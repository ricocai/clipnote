/**
 * MCP 传输端口（Port）定义 —— 传输内核与平台之间的全部接触面。
 *
 * 鸿蒙实现位于 `mcp/src/main/ets/adapters/`（`@kit.*` 只允许出现在那里），
 * 本机测试实现位于 `tools/test/support/mcp-memory-socket.ts`。
 * 设计 §4.5.3（选型见 `design/mcp-传输选型.md`）：受限子集 HTTP/1.1 自研，
 * TLS 用系统栈，因此"安全上下文"对本内核只是一个材料端口。
 */

/** 一条已建立的双字节流连接（TCP 或已握手 TLS）。 */
export interface IConnection {
  /** 对端地址（用于审计展示与限速键），如 `192.168.1.5` */
  readonly remoteAddress: string;
  /** 追加数据发送；实现必须按调用顺序完整写出 */
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** 注册数据回调；实现保证同一连接的数据回调顺序触发 */
  onData(cb: (data: Uint8Array) => void): void;
  /** 注册关闭回调（对端关闭或本地 close 后恰好一次触发） */
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

/** 服务端监听套接字（TCP 或 TLS Server 的统一形状）。 */
export interface IServerSocket {
  start(address: string, port: number): Promise<void>;
  stop(): Promise<void>;
  onConnection(cb: (conn: IConnection) => void): void;
  /** 实际绑定端口（0 表示自动分配后回填） */
  boundPort(): number;
}

/**
 * 基础依赖的结构性接口（与 common/core/ports.ts 同形状）。
 * 刻意不 import 'common'：mcp core 必须同时被 hvigor（包名导入）与
 * 本机 tsc（相对导入、无包解析）两边编译，结构性接口是唯一零成本桥。
 * 装配层（entry / 测试）传入 common 的实现，天然满足契约。
 */
export interface ClockLike {
  nowMs(): number;
}

export interface RandomLike {
  nextBytes(length: number): Uint8Array;
}

export interface LoggerLike {
  log(level: string, event: string, fields: Record<string, string | number | boolean>): void;
}

/** TLS 材料：TLSSocketServer 需要的 PEM 形态；指纹用于 TOFU 展示与凭证代际绑定。 */
export interface ServerTlsMaterial {
  readonly keyPem: string;
  readonly certPem: string;
  /** 证书 DER 的 SHA-256，小写 64 位十六进制（展示为分组指纹） */
  readonly fingerprintSha256: string;
  /** 证书代际：轮换即 +1，旧代际凭证全部失效（设计 §4.5.3"更新后重建信任"） */
  readonly generation: number;
}

/**
 * 证书权威端口：自签证书的设备侧生命周期。
 * 实现（鸿蒙适配器）在首次启用时生成 EC(P-256) 自签证书并持久化于应用沙箱。
 * 注意：设备侧生成路径属真机验证项（design/mcp-传输选型.md R-A），
 * 实现失败必须显式报错交 UI 提示，**绝不静默退回明文 HTTP**。
 */
export interface ICertificateAuthority {
  /** 返回当前代际材料；首次调用时生成 generation=1 */
  current(): Promise<ServerTlsMaterial>;
  /** 轮换：生成新证书，generation+1；旧材料立即不再返回 */
  rotate(): Promise<ServerTlsMaterial>;
}

/** 配对确认 UI 所需的待确认请求视图。 */export interface PendingPairingView {
  readonly id: string;
  /** 客户端自报名称（Host 侧展示名，仅作展示，不构成身份） */
  readonly clientName: string;
  readonly remoteAddress: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
}

/** 签发结果：token 仅在签发瞬间以明文出现一次，存储与传输只留摘要。 */
export interface IssuedCredential {
  readonly clientId: string;
  /** Bearer token（base64url，≥128 bit 熵）；UI 展示供用户粘贴到 Host */
  readonly token: string;
  readonly expiresAtMs: number;
  readonly certGeneration: number;
}

/** 已认证客户端的上下文，随每次 MCP 请求传入上层。 */
export interface AuthenticatedClient {
  readonly clientId: string;
  readonly certGeneration: number;
}
