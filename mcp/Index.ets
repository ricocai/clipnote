/**
 * mcp（HAR）：Agent 接入（设计 §4.5）。
 *
 * **本期（V0.1）刻意不实现协议与传输**，原因有三，且都是评审已采纳的结论：
 *  1. §4.5.1 要求「协议版本以目标 Host 实测为准」并显式标注。2026-07-28 规范已无状态化
 *     （移除 initialize 握手、新增 server/discover、移除 SSE 恢复），
 *     在锁定目标 Host 之前写协议适配层等于把返工写进代码；
 *  2. A1（HMAF 本机 Agent）与 A2（局域网外部 Agent）均为**待 PoC**，G2/G3 未通过前不投入；
 *  3. 工具级授权语义（§4.5.5）必须先于工具实现固化，否则会先出现"能调用但越权"的实现。
 *
 * 本文件冻结的是**授权语义与工具契约**，这部分不随协议版本变化。
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
