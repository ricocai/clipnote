/**
 * mcp（HAR）：Agent 接入（设计 §4.5）。
 *
 * **进度口径（S6-3 后）**：传输层（S6-2）、AccessPolicy 服务端强制（S6-1）、
 * 协议适配层（S6-3）均已实现：
 *  - `./src/main/ets/core/access-policy.ts`：默认拒绝、每客户端授权清单、
 *    授权变更即时生效（现场查表不缓存）、PolicyGate 三态审计（denied/error/ok），
 *    审计经 `IMcpAuditSink` 落库到 common 的 `mcp_audit` 表（schema v2，只记元数据）；
 *  - `./src/main/ets/core/dispatcher.ts`：ClipNoteMcpDispatcher —— initialize
 *    锁定协商（恒回 `2025-11-25`）、ping/tools/list/tools/call 分发、每 clientId
 *    滑动窗限流（-32002）、6 首发工具语义（含 append 应用级幂等键与
 *    expected_revision 冲突结果），工具调用唯一经 PolicyGate.execute 收口，
 *    AccessDeniedError 映射 -32002；笔记触达经 NoteStoreLike 结构端口
 *    （不 import common，装配层用 NoteService 适配）。
 *
 * **仍未实现（遗留）**：entry 装配接线（NoteService → NoteStoreLike 适配、
 * 审计 sink 接 McpAuditRepository 已在测试验证，UI 开关/配对页未接）；
 * G3 真机互操作复核（Cherry Studio 实机连真机服务端，主机侧台架见
 * tools/probes/g3-interop.ts）。工具级授权语义与工具契约不随协议版本变化。
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
export * from './src/main/ets/core/dispatcher';
export * from './src/main/ets/core/server';

// ---- 鸿蒙适配（@kit.* 只允许出现在 adapters/；真机验证项 R-A 见各文件头注释） ----
export { HarmonyTlsServerSocket, HarmonyTcpServerSocket } from './src/main/ets/adapters/harmony-tls-socket';
export { HarmonyCertificateAuthority } from './src/main/ets/adapters/harmony-certificate-authority';
