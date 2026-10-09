import { wifiManager } from '@kit.ConnectivityKit';
import {
  AppDataRuntime,
  AppContextHolder,
  CryptoHasher,
  CryptoRandom,
  HilogLogger,
  LogLevel,
  NoteService,
  SandboxFileStore,
  SystemClock,
} from 'common';
import {
  HarmonyCertificateAuthority,
  HarmonyTlsServerSocket,
  IssuedCredential,
  McpServerState,
  PairingCodeView,
  PendingPairingView,
} from 'mcp';
import {
  McpGrantedClientView,
  McpServiceCore,
} from './McpServiceCore';

/**
 * MCP 服务（S6-7；设计 §4.5.3）：Harmony 装配 + 开关 + 前台生命周期。
 *
 * 薄包装 —— 全部可测逻辑在平台无关的 McpServiceCore（本机用例覆盖），
 * 本类只做四件平台相关的事：
 *  1. 用鸿蒙适配器装配 core（TLS 证书权威 + TLS 监听 socket，材料持久化在
 *     filesDir/mcp-tls；私钥不出设备、不进日志）；
 *  2. Host/Origin 白名单按本机 IPv4 地址枚举（DNS rebinding 防护；
 *     枚举失败收敛为基础名并记警告日志 —— 显式失败，绝不静默放开）；
 *  3. 开关状态（enabled）：内存态，重启默认关（安全默认 = 默认拒绝；
 *     开关持久化属 V0.3 体验增强，当前无通用偏好存储入口）；
 *  4. 前台生命周期：回前台启动 + 30s 周期清扫（tick），退后台即关。
 *
 * 端口固定 8765 / 0.0.0.0（设计留白：UI 展示实际地址与证书指纹）。
 * 启动失败（如端口占用）显式抛错交 UI 提示，绝不静默、绝不退回明文。
 */

/** 固定服务端口（设计留白；与 G3 互操作台架一致） */
export const MCP_PORT: number = 8765;
const TICK_INTERVAL_MS: number = 30 * 1000;
const TLS_DIR_NAME: string = 'mcp-tls';

export interface McpServiceDeps {
  readonly clock: SystemClock;
  readonly random: CryptoRandom;
  readonly hasher: CryptoHasher;
  readonly fs: SandboxFileStore;
  readonly logger: HilogLogger;
  /** NoteService 提供者（AppServices 注入；避免与 AppServices 模块循环依赖） */
  readonly noteService: () => Promise<NoteService>;
}

export class McpService {
  private core: McpServiceCore | undefined = undefined;
  private enabled: boolean = false;
  private tickTimer: number | undefined = undefined;

  private readonly deps: McpServiceDeps;

  constructor(deps: McpServiceDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // 开关与运行状态
  // -------------------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 开关切换：立即生效（设置页位于前台，直接启/停）。
   * 开启即 start（失败显式上抛，由设置页提示并回退开关态）。
   */
  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    if (on) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  async start(): Promise<void> {
    const core: McpServiceCore = await this.ensureCore();
    if (core.isRunning()) {
      return;
    }
    await core.start();
  }

  async stop(): Promise<void> {
    if (this.core === undefined) {
      return;
    }
    await this.core.stop();
  }

  isRunning(): boolean {
    return this.core !== undefined && this.core.isRunning();
  }

  state(): McpServerState {
    if (this.core === undefined) {
      return { running: false, boundPort: 0, certGeneration: 0, fingerprintSha256: '' };
    }
    return this.core.state();
  }

  /** 本机 IPv4 地址（UI 展示连接地址）；枚举失败返回空串 */
  async localAddress(): Promise<string> {
    const addrs: string[] = await localIpv4Addresses(this.deps.logger);
    return addrs.length > 0 ? addrs[0] : '';
  }

  /** 证书分组指纹（UI 展示，TOFU 核对用）；未运行时为空串 */
  fingerprintDisplay(): string {
    const hex: string = this.state().fingerprintSha256;
    if (hex.length === 0) {
      return '';
    }
    const parts: string[] = [];
    for (let i: number = 0; i < hex.length; i += 2) {
      parts.push(hex.slice(i, i + 2).toUpperCase());
    }
    return parts.join(':');
  }

  tick(): void {
    try {
      this.core?.tick();
    } catch (err) {
      // 清扫失败不中断前台会话，但必须在日志留痕
      const fields: Record<string, string | number | boolean> = {};
      fields['message'] = String(err);
      this.deps.logger.log(LogLevel.ERROR, 'mcp.tick.failed', fields);
    }
  }

  // -------------------------------------------------------------------------
  // 配对与授权（委托 core；UI 面见 Settings 页）
  // -------------------------------------------------------------------------

  newPairingCode(): PairingCodeView {
    return this.requireCore().newPairingCode();
  }

  currentPairingCode(): PairingCodeView | undefined {
    if (this.core === undefined) {
      return undefined;
    }
    return this.core.currentPairingCode();
  }

  pendingPairings(): PendingPairingView[] {
    if (this.core === undefined) {
      return [];
    }
    return this.core.pendingPairings();
  }

  confirmPairing(id: string): Promise<IssuedCredential | undefined> {
    return this.requireCore().confirmPairing(id);
  }

  rejectPairing(id: string): boolean {
    return this.requireCore().rejectPairing(id);
  }

  revokeClient(clientId: string): boolean {
    return this.requireCore().revokeClient(clientId);
  }

  revokeAll(): number {
    return this.requireCore().revokeAll();
  }

  grantedClients(): McpGrantedClientView[] {
    if (this.core === undefined) {
      return [];
    }
    return this.core.grantedClients();
  }

  // -------------------------------------------------------------------------
  // 前台生命周期（EntryAbility 调用；Ability 保持薄）
  // -------------------------------------------------------------------------

  /** 回前台：开关开启则启动服务并挂 30s 周期清扫 */
  async enterForeground(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.start();
    if (this.tickTimer === undefined) {
      this.tickTimer = setInterval(() => {
        this.tick();
      }, TICK_INTERVAL_MS);
    }
  }

  /** 退后台：停清扫定时器并停止服务（仅前台监听口径） */
  async enterBackground(): Promise<void> {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    await this.stop();
  }

  // -------------------------------------------------------------------------

  private requireCore(): McpServiceCore {
    if (this.core === undefined) {
      throw new Error('MCP 服务未启动');
    }
    return this.core;
  }

  /** 数据层就绪后装配 core（证书/socket 首启即建；重复调用返回同一实例） */
  private async ensureCore(): Promise<McpServiceCore> {
    if (this.core !== undefined) {
      return this.core;
    }
    const rt: AppDataRuntime = await AppDataRuntime.whenReady();
    const root: string = AppContextHolder.filesDir();
    const ca = new HarmonyCertificateAuthority(
      this.deps.fs,
      `${root}/${TLS_DIR_NAME}`,
      this.deps.random,
      this.deps.clock,
    );
    this.core = new McpServiceCore({
      socket: new HarmonyTlsServerSocket(ca),
      certificateAuthority: ca,
      noteService: await this.deps.noteService(),
      notes: rt.notes,
      auditStore: rt.mcpAudit,
      clock: this.deps.clock,
      random: this.deps.random,
      hasher: this.deps.hasher,
      logger: this.deps.logger,
      address: '0.0.0.0',
      port: MCP_PORT,
      allowedHosts: await localHostNames(this.deps.logger),
    });
    return this.core;
  }
}

// ---------------------------------------------------------------------------
// 平台小工具（本机不可验证，R-A 真机项同 harmony adapters）
// ---------------------------------------------------------------------------

/** 本机 IPv4 地址枚举（Host 头白名单与 UI 展示共用） */
async function localIpv4Addresses(logger: HilogLogger): Promise<string[]> {
  const out: string[] = [];
  try {
    // SDK 无 NetHandle 本机地址枚举接口；LAN 服务场景即 Wi-Fi，
    // 取 wifiManager.getIpInfo() 的 STA 地址。注意 HarmonyOS 的 ipAddress 为
    // 网络字节序（大端）整数，须按大端拆字节，否则会得到四字节整体倒序的错 IP
    // （曾误显示为真实地址的八位组倒序，并连带污染 Host 白名单 → 直连 403）。
    // 失败（无 Wi-Fi / 权限受限）收敛为空表并记警告——显式失败，不静默放开。
    const info: wifiManager.IpInfo = wifiManager.getIpInfo();
    const ip: number = info.ipAddress;
    if (ip !== 0) {
      out.push(`${(ip >>> 24) & 0xFF}.${(ip >>> 16) & 0xFF}.${(ip >>> 8) & 0xFF}.${ip & 0xFF}`);
    }
  } catch (err) {
    const fields: Record<string, string | number | boolean> = {};
    fields['message'] = String(err);
    logger.log(LogLevel.WARN, 'mcp.local_addr.failed', fields);
  }
  return out;
}

/** Host/Origin 白名单：本机地址 + 基础名（clipnote.local 为证书 SAN） */
async function localHostNames(logger: HilogLogger): Promise<string[]> {
  const hosts: Set<string> = new Set<string>(['localhost', '127.0.0.1', '0.0.0.0', 'clipnote.local']);
  const addrs: string[] = await localIpv4Addresses(logger);
  for (let i: number = 0; i < addrs.length; i++) {
    hosts.add(addrs[i]);
  }
  const out: string[] = [];
  hosts.forEach((h: string) => {
    out.push(h);
  });
  return out;
}
