/**
 * MCP 服务协调内核（S6-7；设计 §4.5.3 通道 A2 + §4.5.5 授权语义）。
 *
 * 职责：把 mcp core 的传输/协议/授权/审计组件装配成一个可开关的服务，
 * 并承载 UI 面（配对确认/撤销/状态）。平台无关 —— socket 与证书权威由
 * Harmony 包装层（McpService.ets）注入鸿蒙适配器，本机用例注入内存假实现
 * 驱动同一源码（tools/test/mcp-assembly.test.ts）。
 *
 * 生命周期口径（V1.4：仅前台监听、退后台即关）：
 *  - start()：加载 TLS 材料（首次启用即生成证书）并监听，失败显式上抛
 *    （UI 提示），**绝不静默退回明文**；
 *  - stop()：会话、配对码与挂起请求即刻清零（server.stop 语义）；
 *    授权清单与凭证同为内存态、前台周期边界，stop 一并清零
 *    （access-policy.ts 头注释口径："前台周期边界，stop 即清零"）。
 *
 * 授权口径：确认配对即授予全部首发工具 + 当前全部标签集合（collectionIds）。
 * 按工具/集合粒度的授权 UI 规范属后续任务，此处为首发口径（代码注释标记）。
 */

import {
  IClock,
  ILogger,
  LogLevel,
  IRandom,
  NoteRepository,
  NoteService,
} from 'common';
import {
  AccessPolicy,
  ClientCredentialStore,
  ClipNoteMcpDispatcher,
  CredentialRecord,
  DEFAULT_RATE_LIMIT,
  HasherLike,
  ICertificateAuthority,
  IServerSocket,
  IssuedCredential,
  McpAuditStoreLike,
  McpAuditStoreSink,
  McpServer,
  McpServerState,
  McpSessionManager,
  McpToolName,
  PairingCodeView,
  PairingManager,
  PendingPairingView,
  PolicyGate,
  StreamableHttpEndpoint,
} from 'mcp';
import { McpNoteStoreAdapter } from './McpNoteStoreAdapter';

/** 凭证有效期：30 天（与主机侧台架同一口径；到期须重新配对） */
const TOKEN_TTL_MS: number = 30 * 24 * 3600 * 1000;
/** 协议会话空闲过期：30 分钟（滑动） */
const SESSION_IDLE_TTL_MS: number = 30 * 60 * 1000;
/** 配对码有效期：5 分钟（PairingManager 缺省口径） */
const PAIR_CODE_TTL_MS: number = 5 * 60 * 1000;
/** 配对码连续错误尝试上限：5 次（PairingManager 缺省口径） */
const PAIR_MAX_ATTEMPTS: number = 5;

/** 全部首发工具：确认配对即整组授予 */
const ALL_TOOLS: McpToolName[] = [
  McpToolName.SEARCH_NOTES,
  McpToolName.GET_NOTE,
  McpToolName.CREATE_NOTE,
  McpToolName.APPEND_TO_NOTE,
  McpToolName.DELETE_NOTE,
  McpToolName.LIST_TAGS,
];

export interface McpServiceCoreDeps {
  readonly socket: IServerSocket;
  readonly certificateAuthority: ICertificateAuthority;
  readonly noteService: NoteService;
  readonly notes: NoteRepository;
  /** AppDataRuntime.mcpAudit（结构兼容 McpAuditStoreLike，不 import common 数据层细节） */
  readonly auditStore: McpAuditStoreLike;
  readonly clock: IClock;
  readonly random: IRandom;
  /** common CryptoHasher 满足 HasherLike（小写 64 位十六进制 SHA-256） */
  readonly hasher: HasherLike;
  readonly logger: ILogger;
  readonly address: string;
  readonly port: number;
  /** Host/Origin 白名单（DNS rebinding 防护；由包装层按本机地址枚举） */
  readonly allowedHosts: string[];
}

/** 已授权客户端的 UI 视图（凭证 label + 授权范围摘要；不含令牌） */
export interface McpGrantedClientView {
  readonly clientId: string;
  readonly label: string;
  readonly toolCount: number;
  readonly collectionCount: number;
  readonly expiresAtMs: number;
}

export class McpServiceCore {
  private readonly policy: AccessPolicy;
  private readonly credentials: ClientCredentialStore;
  private readonly sessions: McpSessionManager;
  private readonly pairing: PairingManager;
  private readonly gate: PolicyGate;
  private readonly server: McpServer;

  constructor(private readonly deps: McpServiceCoreDeps) {
    // ES2022 字段初始化先于构造参数属性赋值，组件装配必须在构造器体内进行
    this.policy = new AccessPolicy(deps.clock);
    this.credentials = new ClientCredentialStore(
      deps.random,
      deps.hasher,
      deps.clock,
      { tokenTtlMs: TOKEN_TTL_MS },
    );
    this.sessions = new McpSessionManager(deps.clock, deps.random, {
      idleTtlMs: SESSION_IDLE_TTL_MS,
    });
    this.pairing = new PairingManager(deps.random, deps.clock, {
      codeTtlMs: PAIR_CODE_TTL_MS,
      maxAttempts: PAIR_MAX_ATTEMPTS,
    });
    this.gate = new PolicyGate(
      this.policy,
      new McpAuditStoreSink(deps.auditStore),
      deps.clock,
    );
    const store = new McpNoteStoreAdapter({
      service: deps.noteService,
      notes: deps.notes,
    });
    const dispatcher = new ClipNoteMcpDispatcher(this.gate, store, deps.clock, DEFAULT_RATE_LIMIT);
    const endpoint = new StreamableHttpEndpoint(this.sessions, dispatcher);
    this.server = new McpServer({
      socket: deps.socket,
      certificateAuthority: deps.certificateAuthority,
      endpoint: endpoint,
      sessions: this.sessions,
      pairing: this.pairing,
      credentials: this.credentials,
      clock: deps.clock,
      // mcp LoggerLike 的 level 是 string；common LogLevel 是同名字符串枚举，直接桥接
      logger: {
        log: (level: string, event: string, fields: Record<string, string | number | boolean>): void => {
          deps.logger.log(level as LogLevel, event, fields);
        },
      },
    }, {
      maxHeaderBytes: 8192,
      maxBodyBytes: 4096,
      rateLimitPerMinute: 100,
      allowedHosts: deps.allowedHosts,
    });
  }

  /** 前台进入：监听启动失败显式上抛（由调用方记日志/提示），绝不静默 */
  async start(): Promise<void> {
    await this.server.start(this.deps.address, this.deps.port);
  }

  /** 退后台：监听关闭 + 会话/配对清零 + 授权与凭证清零（内存态前台周期口径） */
  async stop(): Promise<void> {
    await this.server.stop();
    this.policy.revokeAll();
    const records: CredentialRecord[] = this.credentials.list();
    for (let i: number = 0; i < records.length; i++) {
      this.credentials.revoke(records[i].clientId);
    }
  }

  isRunning(): boolean {
    return this.server.isRunning();
  }

  state(): McpServerState {
    return this.server.state();
  }

  /** 周期性清扫（UI 每 30s 驱动一次）；未运行时各组件清扫为空操作 */
  tick(): void {
    this.server.tick();
  }

  // -------------------------------------------------------------------------
  // 配对（UI 面；token 只在确认瞬间经 UI 展示一次，本层不进日志）
  // -------------------------------------------------------------------------

  newPairingCode(): PairingCodeView {
    return this.server.newPairingCode();
  }

  currentPairingCode(): PairingCodeView | undefined {
    return this.server.currentPairingCode();
  }

  pendingPairings(): PendingPairingView[] {
    return this.server.pendingPairings();
  }

  /**
   * 确认配对：签发凭证（token 一次性明文返回，交由 UI 展示），
   * 同时按首发口径授予全部工具 + 当前全部标签集合。
   */
  async confirmPairing(id: string): Promise<IssuedCredential | undefined> {
    const issued: IssuedCredential | undefined = await this.server.confirmPairing(id);
    if (issued === undefined) {
      return undefined;
    }
    // TODO(S6 后续任务)：按工具/集合粒度的授权 UI 规范落地后，此处改为按用户勾选授予
    const tags = await this.deps.noteService.listAllTags();
    const collectionIds: string[] = [];
    for (let i: number = 0; i < tags.length; i++) {
      collectionIds.push(tags[i].id);
    }
    this.policy.grant({
      clientId: issued.clientId,
      tools: ALL_TOOLS,
      collectionIds: collectionIds,
      // 收件箱/回收站保持默认排除（设计 §4.5.5：必须显式打开）
    });
    return issued;
  }

  rejectPairing(id: string): boolean {
    return this.server.rejectPairing(id);
  }

  // -------------------------------------------------------------------------
  // 已授权客户端（撤销即时生效：authorize 现场查表，见 access-policy.ts）
  // -------------------------------------------------------------------------

  /** 撤销单客户端：授权 + 凭证同时失效 */
  revokeClient(clientId: string): boolean {
    const revoked: boolean = this.credentials.revoke(clientId);
    this.policy.revoke(clientId);
    return revoked;
  }

  /** 撤销全部（stop 亦走同一口径） */
  revokeAll(): number {
    const records: CredentialRecord[] = this.credentials.list();
    for (let i: number = 0; i < records.length; i++) {
      this.credentials.revoke(records[i].clientId);
    }
    return this.policy.revokeAll();
  }

  /** 已授权客户端列表（凭证 label + 授权摘要，供设置页展示） */
  grantedClients(): McpGrantedClientView[] {
    const labels: Map<string, string> = new Map<string, string>();
    const records: CredentialRecord[] = this.credentials.list();
    for (let i: number = 0; i < records.length; i++) {
      labels.set(records[i].clientId, records[i].label);
    }
    const grants = this.policy.listGrants();
    const out: McpGrantedClientView[] = [];
    for (let i: number = 0; i < grants.length; i++) {
      const label: string = labels.get(grants[i].clientId) ?? '';
      const expiresAtMs: number = this.expiresOf(grants[i].clientId, records);
      out.push({
        clientId: grants[i].clientId,
        label: label,
        toolCount: grants[i].tools.length,
        collectionCount: grants[i].scope.collectionIds.length,
        expiresAtMs: expiresAtMs,
      });
    }
    return out;
  }

  private expiresOf(clientId: string, records: CredentialRecord[]): number {
    for (let i: number = 0; i < records.length; i++) {
      if (records[i].clientId === clientId) {
        return records[i].expiresAtMs;
      }
    }
    return 0;
  }
}
