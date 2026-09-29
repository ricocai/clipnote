/**
 * mcp（HAR）：Agent 接入（设计 §4.5）。
 *
 * **进度口径（S6-1 后）**：传输层（S6-2）+ AccessPolicy 服务端强制（S6-1）已实现 ——
 * `./src/main/ets/core/access-policy.ts`：默认拒绝、每客户端授权清单、
 * 授权变更即时生效（现场查表不缓存）、PolicyGate 三态审计（denied/error/ok），
 * 审计经 `IMcpAuditSink` 落库到 common 的 `mcp_audit` 表（schema v2，只记元数据）。
 *
 * **仍未实现（S6-3）**：`IMcpAdapter` 的协议适配（initialize 协商负载、
 * tools/* 分发、PolicyGate 接入 McpDispatcher）。
 * 工具级授权语义与工具契约（`./src/main/ets/core/access-policy.ts` 前半部分，
 * 本文件再导出）不随协议版本变化。
 */

export * from './src/main/ets/core/access-policy';

/** MCP 协议适配（与传输解耦）。 */
export interface IMcpAdapter {
  /** 已锁定的协议版本字符串；未锁定时必须返回 undefined，而不是猜一个默认值 */
  lockedProtocolVersion(): string | undefined;
  discover(): Promise<unknown>;
  callTool(name: McpToolName, args: Record<string, string>, auth: ToolAuthorization): Promise<unknown>;
}

/** 传输适配（Streamable HTTP / 自有隧道）。WSS 仅作为自有隧道内部协议。 */
export interface ITransportAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

// ---- 传输内核（S6-2；分层纪律同 common：core 零 @kit.*，可本机全量验证） ----
export * from './src/main/ets/core/transport-ports';
export * from './src/main/ets/core/http11';
export * from './src/main/ets/core/jsonrpc';
export * from './src/main/ets/core/session';
export * from './src/main/ets/core/credentials';
export * from './src/main/ets/core/pairing';
export * from './src/main/ets/core/x509-selfsign';
export * from './src/main/ets/core/endpoint';
export * from './src/main/ets/core/server';

// ---- 鸿蒙适配（@kit.* 只允许出现在 adapters/；真机验证项 R-A 见各文件头注释） ----
export { HarmonyTlsServerSocket, HarmonyTcpServerSocket } from './src/main/ets/adapters/harmony-tls-socket';
export { HarmonyCertificateAuthority } from './src/main/ets/adapters/harmony-certificate-authority';
