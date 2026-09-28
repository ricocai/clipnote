/**
 * JSON-RPC 2.0 信封（MCP 消息载体）。
 * 只承担信封解析/编码与错误形状，方法语义在协议适配层（S6-3）。
 */

/** 规范内错误码；不使用 -32002 以外的自创码（协议锁定决议） */
export const JSONRPC_PARSE_ERROR: number = -32700;
export const JSONRPC_INVALID_REQUEST: number = -32600;
export const JSONRPC_METHOD_NOT_FOUND: number = -32601;
export const JSONRPC_INTERNAL_ERROR: number = -32603;

export interface JsonRpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

/** 以宽松形状接收未知方法负载，校验交给协议适配层 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export type Envelope =
  | { kind: 'request'; request: JsonRpcRequest }
  | { kind: 'notification'; method: string; params: Record<string, unknown> | undefined }
  | { kind: 'invalid'; errorCode: number };

/**
 * 解析一个 JSON-RPC 消息体（单条，非 batch）。
 * MCP Host（Cherry Studio / VS Code）首发路径不发送 batch；批量消息按
 * Invalid Request 拒绝（endpoint 层 400），保持行为确定、可审计。
 */
export function parseEnvelope(bodyText: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return { kind: 'invalid', errorCode: JSONRPC_PARSE_ERROR };
  }
  if (Array.isArray(value)) {
    return { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST };
  }
  const obj: Record<string, unknown> | undefined = asRecord(value);
  if (obj === undefined || obj['jsonrpc'] !== '2.0') {
    return { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST };
  }
  const method: unknown = obj['method'];
  if (typeof method !== 'string') {
    return { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST };
  }
  const params: Record<string, unknown> | undefined = asRecord(obj['params']);
  const idValue: unknown = obj['id'];
  if (idValue === undefined) {
    return { kind: 'notification', method, params };
  }
  if (typeof idValue !== 'string' && typeof idValue !== 'number') {
    return { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST };
  }
  return { kind: 'request', request: { id: idValue, method, params } };
}

export function encodeResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function encodeError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}
