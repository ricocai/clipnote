/**
 * Streamable HTTP 端点（2025-11-25 语义，协议锁定决议 + design/mcp-传输选型.md）。
 *
 * 只承载传输与协议信封语义：单端点 `/mcp`、POST/GET/DELETE、
 * `Mcp-Session-Id` 签发/校验（未知 404）、`MCP-Protocol-Version` 校验（不符 400）、
 * Origin/Host 匹配（不符 403）。方法语义（initialize 负载、tools/* 分发）由
 * 注入的 McpDispatcher 承担 —— S6-3 的协议适配层实现它，本层不感知任何工具。
 */

import {
  accepts,
  headerValue,
  HttpRequest,
  utf8Decode,
} from './http11';
import {
  encodeError,
  encodeResult,
  JsonRpcRequest,
  parseEnvelope,
} from './jsonrpc';
import { McpSession, McpSessionManager } from './session';
import { AuthenticatedClient } from './transport-ports';

/** 方法语义错误：由 dispatcher 抛出，端点层编码为 JSON-RPC error 响应 */
export class JsonRpcMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 协议分发端口（S6-3 实现）。initialize 负责版本协商，
 * 返回的 InitializeResult 负载原样进入响应。
 */
export interface McpDispatcher {
  initialize(
    clientProtocolVersion: string | undefined,
    params: Record<string, unknown> | undefined,
    client: AuthenticatedClient,
  ): Promise<{ protocolVersion: string; result: unknown }>;

  dispatch(
    session: McpSession,
    method: string,
    params: Record<string, unknown> | undefined,
    client: AuthenticatedClient,
  ): Promise<unknown>;
}

export type EndpointResponse =
  | { kind: 'fixed'; status: number; bodyText: string; extraHeaders?: ReadonlyArray<readonly [string, string]> }
  | { kind: 'accepted' }
  | { kind: 'sse'; session: McpSession };

function jsonErrorResponse(status: number, id: string | number | null, code: number, message: string): EndpointResponse {
  return { kind: 'fixed', status, bodyText: encodeError(id, code, message) };
}

export class StreamableHttpEndpoint {
  constructor(
    private readonly sessions: McpSessionManager,
    private readonly dispatcher: McpDispatcher,
  ) {}

  /** 已鉴权后的 `/mcp` 请求处理。origin 校验由 server 层统一执行。 */
  async handle(req: HttpRequest, client: AuthenticatedClient): Promise<EndpointResponse> {
    if (req.method === 'POST') {
      return this.handlePost(req, client);
    }
    if (req.method === 'GET') {
      return this.handleGet(req);
    }
    if (req.method === 'DELETE') {
      return this.handleDelete(req);
    }
    return {
      kind: 'fixed',
      status: 405,
      bodyText: encodeError(null, -32600, 'method not allowed'),
      extraHeaders: [['Allow', 'POST, GET, DELETE']],
    };
  }

  private async handlePost(req: HttpRequest, client: AuthenticatedClient): Promise<EndpointResponse> {
    const sessionId: string | undefined = headerValue(req, 'mcp-session-id');
    const envelope = parseEnvelope(utf8Decode(req.body));

    if (sessionId === undefined) {
      // 无会话：唯一合法消息是 initialize
      if (envelope.kind !== 'request' || envelope.request.method !== 'initialize') {
        return jsonErrorResponse(400, null, -32600, 'expected initialize request without session id');
      }
      return this.handleInitialize(envelope.request, client);
    }

    const session: McpSession | undefined = this.sessions.touch(sessionId);
    if (session === undefined) {
      // 规范：404 → 客户端必须重新 initialize
      return jsonErrorResponse(404, null, -32600, 'unknown or expired session');
    }
    const declaredVersion: string | undefined = headerValue(req, 'mcp-protocol-version');
    if (declaredVersion !== undefined && declaredVersion !== session.protocolVersion) {
      return jsonErrorResponse(400, null, -32600, `unsupported protocol version: ${declaredVersion}`);
    }

    if (envelope.kind === 'invalid') {
      return jsonErrorResponse(400, null, envelope.errorCode, 'invalid JSON-RPC message');
    }
    if (envelope.kind === 'notification') {
      // 通知（notifications/initialized 等）：202 空响应
      return { kind: 'accepted' };
    }
    try {
      const result: unknown = await this.dispatcher.dispatch(session, envelope.request.method, envelope.request.params, client);
      return { kind: 'fixed', status: 200, bodyText: encodeResult(envelope.request.id, result ?? {}) };
    } catch (err) {
      if (err instanceof JsonRpcMethodError) {
        return jsonErrorResponse(200, envelope.request.id, err.code, err.message);
      }
      return jsonErrorResponse(200, envelope.request.id, -32603, 'internal error');
    }
  }

  private async handleInitialize(request: JsonRpcRequest, client: AuthenticatedClient): Promise<EndpointResponse> {
    const clientVersion: string | undefined = (request.params?.['protocolVersion'] as string | undefined) ?? undefined;
    try {
      const negotiated = await this.dispatcher.initialize(clientVersion, request.params, client);
      const session: McpSession = this.sessions.create(negotiated.protocolVersion);
      return {
        kind: 'fixed',
        status: 200,
        bodyText: encodeResult(request.id, negotiated.result),
        extraHeaders: [['Mcp-Session-Id', session.id]],
      };
    } catch (err) {
      if (err instanceof JsonRpcMethodError) {
        return jsonErrorResponse(400, request.id, err.code, err.message);
      }
      return jsonErrorResponse(400, request.id, -32603, 'internal error');
    }
  }

  private handleGet(req: HttpRequest): EndpointResponse {
    const sessionId: string | undefined = headerValue(req, 'mcp-session-id');
    if (sessionId === undefined) {
      return jsonErrorResponse(400, null, -32600, 'session id required');
    }
    const session: McpSession | undefined = this.sessions.touch(sessionId);
    if (session === undefined) {
      return jsonErrorResponse(404, null, -32600, 'unknown or expired session');
    }
    if (!accepts(headerValue(req, 'accept'), 'text/event-stream')) {
      return jsonErrorResponse(406, null, -32600, 'GET requires Accept: text/event-stream');
    }
    return { kind: 'sse', session };
  }

  private handleDelete(req: HttpRequest): EndpointResponse {
    const sessionId: string | undefined = headerValue(req, 'mcp-session-id');
    if (sessionId === undefined) {
      return jsonErrorResponse(400, null, -32600, 'session id required');
    }
    if (!this.sessions.delete(sessionId)) {
      return jsonErrorResponse(404, null, -32600, 'unknown or expired session');
    }
    return { kind: 'fixed', status: 200, bodyText: '{}' };
  }
}
