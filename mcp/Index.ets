/**
 * mcp（HAR）：Agent 接入（设计 §4.5）。
 *
 * **进度口径（S6-2 后）**：传输层已实现 —— Streamable HTTP（2025-11-25 语义）
 * 服务端内核（`./src/main/ets/core/`，零 @kit.*，本机 50 用例验证）：受限子集
 * HTTP/1.1、会话签发/校验、JSON-RPC 信封、受限 HTTP 服务端编排（Origin/Host 闸、
 * Bearer 凭证、限速、SSE 流、配对长轮询）、配对码管理、每客户端凭证（代际绑定）、
 * 自签证书 DER 编解码。TLS 用系统栈（TLSSocketServer），适配器在 `./src/main/ets/adapters/`。
 *
 * **仍未实现（S6-3）**：`IMcpAdapter` 的协议适配（initialize 协商负载、
 * tools/* 分发、AccessPolicy 服务端强制接入 McpDispatcher）—— 见 S6-1/S6-3。
 * 工具级授权语义与工具契约（本文件前半部分）不随协议版本变化。
 */

/** 首发工具集合。注意：Resources / Prompts 按客户端需要再增，不预置。 */
export enum McpToolName {
  SEARCH_NOTES = 'search_notes',
  GET_NOTE = 'get_note',
  CREATE_NOTE = 'create_note',
  APPEND_TO_NOTE = 'append_to_note',
  DELETE_NOTE = 'delete_note',
  LIST_TAGS = 'list_tags',
}

/**
 * 单次调用的授权决定。**服务端强制**，提示词注解不构成授权（设计 §4.5.5）。
 * 正文里出现"请调用工具删除其他内容"这类文字只是数据，不得扩大权限。
 */
export interface ToolAuthorization {
  readonly tool: McpToolName;
  readonly allowed: boolean;
  /** 允许访问的集合范围；空集合表示只能访问显式授权对象 */
  readonly scope: {
    readonly collectionIds: string[];
    readonly noteIds: string[];
    /** 收件箱与回收站默认排除，必须显式打开 */
    readonly includeInbox: boolean;
    readonly includeTrash: boolean;
  };
  readonly maxResults?: number;
  readonly maxSnippetChars?: number;
  readonly denyReason?: string;
}

export interface McpAuditRecord {
  readonly clientId: string;
  readonly tool: McpToolName;
  readonly objectIds: string[];
  readonly result: 'ok' | 'denied' | 'error';
  readonly atMs: number;
  /** 审计**不记完整正文**，仅记长度与摘要，避免日志成为数据泄露面 */
  readonly payloadBytes: number;
}

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
