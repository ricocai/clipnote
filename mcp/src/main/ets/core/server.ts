/**
 * MCP 局域网服务端编排（设计 §4.5.3 通道 A2 + design/mcp-传输选型.md）。
 *
 * 职责：连接生命周期、每连接 HTTP 请求循环（keep-alive、顺序处理）、
 * 安全闸（Origin/Host 匹配 403、Bearer 凭证 401、每 IP 限速 429、
 * 请求体积 413/431）、路由（POST /pair 配对、/mcp 端点）、
 * SSE 响应流（心跳维持）、配对挂起长轮询、证书轮换与退后台清理。
 *
 * 平台无关：socket/TLS/证书全部经端口注入（transport-ports.ts），
 * 鸿蒙实现在 adapters/，本机测试用内存假实现。前台生命周期由 UI 层
 * 以 start()/stop() 显式驱动 —— 仅前台监听、退后台即关（V1.4 口径）；
 * 周期性清扫由 UI/适配器定时调用 tick()（本类不持有定时器，保持可确定性测试）。
 */

import {
  EndpointResponse,
  StreamableHttpEndpoint,
} from './endpoint';
import {
  encodeChunk,
  encodeFixedResponse,
  encodeHead,
  encodeSseComment,
  headerValue,
  HttpParseError,
  HttpRequest,
  HttpRequestParser,
  isSafeHeaderValue,
  utf8Decode,
  utf8Encode,
} from './http11';
import { ClientCredentialStore } from './credentials';
import { McpSessionManager } from './session';
import { PairAttemptOutcome, PairingCodeView, PairingManager } from './pairing';
import {
  AuthenticatedClient,
  ClockLike,
  ICertificateAuthority,
  IConnection,
  IServerSocket,
  IssuedCredential,
  LoggerLike,
  PendingPairingView,
  ServerTlsMaterial,
} from './transport-ports';

export interface McpServerDeps {
  /** 监听套接字（TCP 或 TLS Server 适配器）；start() 时由适配器自行从
   *  certificateAuthority 加载当前 TLS 材料（两者必须注入同一 CA 实例）。 */
  readonly socket: IServerSocket;
  readonly certificateAuthority: ICertificateAuthority;
  readonly endpoint: StreamableHttpEndpoint;
  readonly sessions: McpSessionManager;
  readonly pairing: PairingManager;
  readonly credentials: ClientCredentialStore;
  readonly clock: ClockLike;
  readonly logger: LoggerLike;
}

export interface McpServerOptions {
  /** 请求头块上限（字节，超限 431） */
  readonly maxHeaderBytes: number;
  /** 请求体上限（字节，超限 413） */
  readonly maxBodyBytes: number;
  /** 每 IP 每分钟请求上限（超限 429） */
  readonly rateLimitPerMinute: number;
  /**
   * 允许的 Host/Origin 主机值（小写主机名或 IP，不含端口）。
   * DNS rebinding 防护（规范传输要求）：Host 头必须命中其一；
   * Origin 头存在时其主机部分也必须命中；Origin 缺席允许（MCP Host 非浏览器）。
   */
  readonly allowedHosts: string[];
}

export interface McpServerState {
  readonly running: boolean;
  readonly boundPort: number;
  readonly certGeneration: number;
  /** 证书 SHA-256 指纹（64 位小写十六进制，无分隔） */
  readonly fingerprintSha256: string;
}

interface ConnectionCtx {
  readonly parser: HttpRequestParser;
  /** 串行化该连接上的请求处理与响应写出，保证响应顺序；响应均为单次 write 原子写出 */
  queue: Promise<void>;
  hijacked: boolean;
  closed: boolean;
}

type HeldPairingResolution =
  | { kind: 'paired'; clientId: string }
  | { kind: 'rejected' }
  | { kind: 'expired' };

interface HeldPairing {
  readonly resolve: (r: HeldPairingResolution) => void;
  readonly conn: IConnection;
}

const JSON_HEADERS: ReadonlyArray<readonly [string, string]> = [['Content-Type', 'application/json']];

export class McpServer {
  private tlsMaterial: ServerTlsMaterial | undefined;
  private boundAddress: string = '';
  private boundPort: number = 0;
  private readonly connections: Set<IConnection> = new Set();
  private readonly sseConnections: Set<IConnection> = new Set();
  private readonly rateBuckets: Map<string, number[]> = new Map();
  private readonly heldPairings: Map<string, HeldPairing> = new Map();

  constructor(
    private readonly deps: McpServerDeps,
    private readonly options: McpServerOptions,
  ) {}

  /** 前台进入：加载 TLS 材料（首次启用即生成证书）并监听。失败显式抛错，UI 明示，不退回明文。 */
  async start(address: string, port: number): Promise<void> {
    if (this.tlsMaterial !== undefined) {
      throw new Error('mcp server already started');
    }
    this.tlsMaterial = await this.deps.certificateAuthority.current();
    await this.deps.socket.start(address, port);
    this.boundAddress = address;
    this.boundPort = this.deps.socket.boundPort();
    this.deps.socket.onConnection((conn: IConnection) => {
      this.onConnection(conn);
    });
    this.deps.logger.log('info', 'mcp.server.started', {
      address: this.boundAddress,
      port: this.boundPort,
      certGeneration: this.tlsMaterial.generation,
    });
  }

  /** 退后台/退出：关监听、断开全部连接、会话与配对状态即刻清零（前台周期边界）。 */
  async stop(): Promise<void> {
    if (this.tlsMaterial === undefined) {
      return;
    }
    this.deps.pairing.invalidateAll();
    for (const held of this.heldPairings.values()) {
      held.resolve({ kind: 'expired' });
    }
    this.heldPairings.clear();
    this.deps.sessions.clear();
    const conns: IConnection[] = [...this.connections];
    this.connections.clear();
    this.sseConnections.clear();
    for (const conn of conns) {
      try {
        await conn.close();
      } catch {
        // 关闭失败不再重试：前台周期已结束
      }
    }
    await this.deps.socket.stop();
    this.tlsMaterial = undefined;
    this.deps.logger.log('info', 'mcp.server.stopped', { port: this.boundPort });
  }

  isRunning(): boolean {
    return this.tlsMaterial !== undefined;
  }

  state(): McpServerState {
    return {
      running: this.isRunning(),
      boundPort: this.boundPort,
      certGeneration: this.tlsMaterial?.generation ?? 0,
      fingerprintSha256: this.tlsMaterial?.fingerprintSha256 ?? '',
    };
  }

  /** UI 展示用分组指纹（如 `AB:CD:…`） */
  fingerprintDisplay(): string {
    const hex: string = this.state().fingerprintSha256;
    const parts: string[] = [];
    for (let i: number = 0; i < hex.length; i += 2) {
      parts.push(hex.slice(i, i + 2).toUpperCase());
    }
    return parts.join(':');
  }

  /**
   * 证书轮换（"更新后重建信任"，设计 §4.5.3）：新证书立即生效，旧代际凭证全部拒绝
   * （ClientCredentialStore.authenticate 按 certGeneration 校验）；监听以新材料重启，
   * 会话清零 —— 客户端必须重新 initialize + 重新配对。
   */
  async rotateCertificate(): Promise<ServerTlsMaterial> {
    if (this.tlsMaterial === undefined) {
      throw new Error('mcp server not started');
    }
    const material: ServerTlsMaterial = await this.deps.certificateAuthority.rotate();
    await this.deps.socket.stop();
    this.tlsMaterial = material;
    await this.deps.socket.start(this.boundAddress, this.boundPort);
    this.deps.sessions.clear();
    this.deps.logger.log('info', 'mcp.server.cert_rotated', {
      certGeneration: material.generation,
      port: this.boundPort,
    });
    return material;
  }

  /**
   * 周期性清扫（由 UI/适配器定时驱动，建议每 30s）：
   * 过期会话、过期配对挂起、限速桶；并向全部 SSE 流写心跳注释帧。
   */
  tick(): void {
    this.deps.sessions.sweep();
    for (const id of this.deps.pairing.sweepExpired()) {
      const held: HeldPairing | undefined = this.heldPairings.get(id);
      if (held !== undefined) {
        this.heldPairings.delete(id);
        held.resolve({ kind: 'expired' });
      }
    }
    for (const [remote, bucket] of this.rateBuckets) {
      if (bucket.length === 0) {
        this.rateBuckets.delete(remote);
      }
    }
    if (this.sseConnections.size === 0) {
      return;
    }
    const beat: Uint8Array = encodeChunk(encodeSseComment('ping'));
    for (const conn of [...this.sseConnections]) {
      conn.write(beat).then(
        () => undefined,
        () => {
          this.sseConnections.delete(conn);
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // 配对（UI 面）
  // -------------------------------------------------------------------------

  newPairingCode(): PairingCodeView {
    return this.deps.pairing.newCode();
  }

  currentPairingCode(): PairingCodeView | undefined {
    return this.deps.pairing.currentCode();
  }

  pendingPairings(): PendingPairingView[] {
    return this.deps.pairing.pending();
  }

  /**
   * 配对确认 UI 的"确认"：签发每客户端凭证（绑定当前证书代际）。
   * 返回的 IssuedCredential 含一次性明文 token，由 UI 展示给用户粘贴到 Host；
   * 同时唤醒挂起的 /pair 长轮询，Host 收到 paired 结果。
   */
  async confirmPairing(id: string): Promise<IssuedCredential | undefined> {
    const confirmed = this.deps.pairing.markConfirmed(id);
    if (confirmed === undefined) {
      return undefined;
    }
    const generation: number = this.requireMaterial().generation;
    const issued: IssuedCredential = await this.deps.credentials.issue(confirmed.label, generation);
    const held: HeldPairing | undefined = this.heldPairings.get(id);
    if (held !== undefined) {
      this.heldPairings.delete(id);
      held.resolve({ kind: 'paired', clientId: issued.clientId });
    }
    this.deps.logger.log('info', 'mcp.pairing.confirmed', {
      clientId: issued.clientId,
      label: confirmed.label,
      remote: confirmed.remoteAddress,
    });
    return issued;
  }

  /** 配对确认 UI 的"拒绝"：挂起的 /pair 请求立即收到拒绝。 */
  rejectPairing(id: string): boolean {
    const ok: boolean = this.deps.pairing.markRejected(id);
    const held: HeldPairing | undefined = this.heldPairings.get(id);
    if (held !== undefined) {
      this.heldPairings.delete(id);
      held.resolve({ kind: 'rejected' });
    }
    if (ok) {
      this.deps.logger.log('info', 'mcp.pairing.rejected', { pairingId: id });
    }
    return ok;
  }

  // -------------------------------------------------------------------------
  // 连接处理
  // -------------------------------------------------------------------------

  private onConnection(conn: IConnection): void {
    this.deps.sessions.sweep();
    this.connections.add(conn);
    const ctx: ConnectionCtx = {
      parser: new HttpRequestParser(this.options.maxHeaderBytes, this.options.maxBodyBytes),
      queue: Promise.resolve(),
      hijacked: false,
      closed: false,
    };
    conn.onClose(() => {
      ctx.closed = true;
      this.connections.delete(conn);
      this.sseConnections.delete(conn);
      for (const [id, held] of this.heldPairings) {
        if (held.conn === conn) {
          this.heldPairings.delete(id);
          held.resolve({ kind: 'expired' });
        }
      }
    });
    conn.onError((err: Error) => {
      this.deps.logger.log('warn', 'mcp.connection.error', {
        remote: conn.remoteAddress,
        message: err.message,
      });
    });
    conn.onData((data: Uint8Array) => {
      if (ctx.hijacked || ctx.closed) {
        return;
      }
      ctx.parser.feed(data);
      ctx.queue = ctx.queue.then(() => this.pumpRequests(conn, ctx));
    });
  }

  /** 依次取出已完成请求并处理；响应按请求顺序写出（每次响应单次 write，天然原子）。 */
  private async pumpRequests(conn: IConnection, ctx: ConnectionCtx): Promise<void> {
    for (;;) {
      if (ctx.hijacked || ctx.closed) {
        return;
      }
      let req: HttpRequest | undefined;
      try {
        req = ctx.parser.nextRequest();
      } catch (err) {
        if (err instanceof HttpParseError) {
          const message: string = isSafeHeaderValue(err.message) ? err.message : 'bad request';
          await conn.write(encodeFixedResponse(err.status, JSON_HEADERS, utf8Encode(
            JSON.stringify({ error: message }),
          ), false));
          await conn.close();
          return;
        }
        throw err;
      }
      if (req === undefined) {
        return;
      }
      const keepAlive: boolean = (headerValue(req, 'connection') ?? '').toLowerCase() !== 'close';
      await this.handleRequest(conn, ctx, req, keepAlive);
      if (!keepAlive && !ctx.hijacked && !ctx.closed) {
        await conn.close();
        return;
      }
    }
  }

  private async handleRequest(conn: IConnection, ctx: ConnectionCtx, req: HttpRequest, keepAlive: boolean): Promise<void> {
    if (!this.isHostAllowed(req)) {
      await this.writeJson(conn, 403, '{"error":"host or origin not allowed"}', keepAlive);
      return;
    }
    if (!this.allowRate(conn.remoteAddress)) {
      await this.writeJson(conn, 429, '{"error":"rate limit exceeded"}', keepAlive);
      return;
    }
    if (req.method === 'POST' && req.target === '/pair') {
      await this.handlePair(conn, req, keepAlive);
      return;
    }
    if (req.target === '/mcp') {
      const client: AuthenticatedClient | undefined = await this.authenticate(req);
      if (client === undefined) {
        await this.writeJson(conn, 401, '{"error":"missing or invalid bearer token"}', keepAlive);
        return;
      }
      const outcome: EndpointResponse = await this.deps.endpoint.handle(req, client);
      await this.writeEndpointResponse(conn, ctx, outcome, keepAlive);
      return;
    }
    await this.writeJson(conn, 404, '{"error":"not found"}', keepAlive);
  }

  private async handlePair(conn: IConnection, req: HttpRequest, keepAlive: boolean): Promise<void> {
    const body = parsePairBody(utf8Decode(req.body));
    if (body === undefined) {
      await this.writeJson(conn, 400, '{"error":"pairing request must be JSON with code and clientName"}', keepAlive);
      return;
    }
    const outcome: PairAttemptOutcome = this.deps.pairing.attempt(body.code, body.clientName, conn.remoteAddress);
    if (outcome.kind === 'no-active-code') {
      await this.writeJson(conn, 409, '{"error":"no active pairing code"}', keepAlive);
      return;
    }
    if (outcome.kind === 'invalid-code') {
      await this.writeJson(conn, 401, `{"error":"invalid pairing code","remainingAttempts":${outcome.remainingAttempts}}`, keepAlive);
      return;
    }
    // 挂起长轮询：等 UI 确认/拒绝、码过期（tick 清扫）或连接断开
    const view: PendingPairingView = outcome.view;
    this.deps.logger.log('info', 'mcp.pairing.requested', {
      pairingId: view.id,
      clientName: view.clientName,
      remote: conn.remoteAddress,
    });
    const resolution: HeldPairingResolution = await new Promise<HeldPairingResolution>((resolve) => {
      this.heldPairings.set(view.id, { resolve, conn });
    });
    if (resolution.kind === 'paired') {
      await this.writeJson(conn, 200, `{"status":"paired","clientId":"${resolution.clientId}"}`, keepAlive);
    } else if (resolution.kind === 'rejected') {
      await this.writeJson(conn, 403, '{"status":"rejected"}', keepAlive);
    } else {
      await this.writeJson(conn, 410, '{"status":"pairing expired"}', keepAlive);
    }
  }

  private async authenticate(req: HttpRequest): Promise<AuthenticatedClient | undefined> {
    const header: string | undefined = headerValue(req, 'authorization');
    if (header === undefined || !header.startsWith('Bearer ')) {
      return undefined;
    }
    const token: string = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      return undefined;
    }
    return this.deps.credentials.authenticate(token, this.requireMaterial().generation);
  }

  private async writeEndpointResponse(conn: IConnection, ctx: ConnectionCtx, outcome: EndpointResponse, keepAlive: boolean): Promise<void> {
    if (outcome.kind === 'fixed') {
      const headers: Array<readonly [string, string]> = [
        ...JSON_HEADERS,
        ...(outcome.extraHeaders ?? []),
      ];
      await conn.write(encodeFixedResponse(outcome.status, headers, utf8Encode(outcome.bodyText), keepAlive));
      return;
    }
    if (outcome.kind === 'accepted') {
      await conn.write(encodeFixedResponse(202, [], new Uint8Array(0), keepAlive));
      return;
    }
    // SSE 流：只写响应头（chunked 无固定长度），连接转为挂起态由 tick() 心跳维持；
    // S6-3 协议层的服务端主动消息经 McpSession 出站队列写入同一 chunked 流。
    await conn.write(encodeHead({
      status: 200,
      headers: [
        ['Content-Type', 'text/event-stream'],
        ['Cache-Control', 'no-cache'],
        ['Connection', 'keep-alive'],
        ['Transfer-Encoding', 'chunked'],
      ],
    }));
    ctx.hijacked = true;
    this.sseConnections.add(conn);
  }

  // -------------------------------------------------------------------------
  // 安全闸
  // -------------------------------------------------------------------------

  /** Host 必检、Origin 有则必中（DNS rebinding 防护）；值全部归一化为主机部分小写。 */
  private isHostAllowed(req: HttpRequest): boolean {
    const host: string | undefined = headerValue(req, 'host');
    if (host === undefined || !this.allowed(hostHostPart(host))) {
      return false;
    }
    const origin: string | undefined = headerValue(req, 'origin');
    if (origin !== undefined) {
      const parsed: string | undefined = originHostPart(origin);
      if (parsed === undefined || !this.allowed(parsed)) {
        return false;
      }
    }
    return true;
  }

  private allowed(host: string): boolean {
    for (const h of this.options.allowedHosts) {
      if (h === host) {
        return true;
      }
    }
    return false;
  }

  /** 滑动窗口（60s）每 IP 限速 */
  private allowRate(remote: string): boolean {
    const now: number = this.deps.clock.nowMs();
    let bucket: number[] | undefined = this.rateBuckets.get(remote);
    if (bucket === undefined) {
      bucket = [];
      this.rateBuckets.set(remote, bucket);
    }
    while (bucket.length > 0 && now - bucket[0] > 60_000) {
      bucket.shift();
    }
    if (bucket.length >= this.options.rateLimitPerMinute) {
      return false;
    }
    bucket.push(now);
    return true;
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  private requireMaterial(): ServerTlsMaterial {
    if (this.tlsMaterial === undefined) {
      throw new Error('mcp server not started');
    }
    return this.tlsMaterial;
  }

  private writeJson(conn: IConnection, status: number, bodyText: string, keepAlive: boolean): Promise<void> {
    return conn.write(encodeFixedResponse(status, JSON_HEADERS, utf8Encode(bodyText), keepAlive));
  }
}

/** Host 头取主机部分（去端口、去尾部点、小写） */
function hostHostPart(host: string): string {
  let h: string = host.trim().toLowerCase();
  const colon: number = h.lastIndexOf(':');
  if (colon > 0 && h.indexOf(']') < 0) {
    h = h.slice(0, colon);
  }
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/** Origin 头（scheme://host[:port]）取主机部分；非法形态返回 undefined（拒绝） */
function originHostPart(origin: string): string | undefined {
  const rest: string = origin.trim().toLowerCase();
  const schemeEnd: number = rest.indexOf('://');
  if (schemeEnd <= 0) {
    return undefined;
  }
  let authority: string = rest.slice(schemeEnd + 3);
  const slash: number = authority.indexOf('/');
  if (slash >= 0) {
    authority = authority.slice(0, slash);
  }
  if (authority.startsWith('[')) {
    const end: number = authority.indexOf(']');
    return end > 0 ? authority.slice(1, end) : undefined;
  }
  return hostHostPart(authority);
}

function parsePairBody(text: string): { code: string; clientName: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec['code'] !== 'string' || typeof rec['clientName'] !== 'string') {
    return undefined;
  }
  return { code: rec['code'], clientName: rec['clientName'] };
}
