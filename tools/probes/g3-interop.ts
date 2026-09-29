/**
 * G3 主机侧互操作台架（设计 §8 门槛 G3 / 协议锁定决议 M4）。
 *
 * 环境无 DevEco/真机，本台架做**协议忠实的 Host 仿真**对全真实服务端栈压测：
 * 真 McpServer + StreamableHttpEndpoint + ClipNoteMcpDispatcher +
 * AccessPolicy/PolicyGate（内存审计 sink），socket 用 Node `net` 实现的
 * TCP IServerSocket 适配器（仅台架脚本内允许 Node 内建），localhost 明文 TCP
 * —— TLS 是鸿蒙适配器职责（R-A 真机项），不影响协议语义验证。
 *
 * Host 端按 Cherry Studio 行为要点（决议 M4）实现 mini Host：
 * POST /mcp、自定义 Bearer Header、Accept: application/json, text/event-stream，
 * 走完整 2025-11-25 生命周期（initialize → Mcp-Session-Id →
 * notifications/initialized → tools/list → 连续 tools/call）。
 *
 * 场景与 G3 验收口径逐项对应：
 *  1. ≥100 次连续调用（混合 6 工具 + 穿插 ping），零协议错误；
 *  2. 断线恢复：kill TCP 后新连接带原会话继续；未知会话 404 → 重新 initialize；
 *  3. 未授权全拒绝：无 Bearer/错误 Bearer → 401，未授予工具 → -32002；
 *  4. 撤销即时生效：revoke 后下一调用即拒；
 *  5. Origin/Host 异常 → 403；超限体积 → 413。
 *
 * 产出：tools/report/g3-interop.md；任一硬断言失败时退出码非零。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AccessPolicy,
  McpAuditRecord,
  McpToolName,
  PolicyGate,
} from '../../mcp/src/main/ets/core/access-policy';
import {
  ClipNoteMcpDispatcher,
  LOCKED_PROTOCOL_VERSION,
} from '../../mcp/src/main/ets/core/dispatcher';
import { StreamableHttpEndpoint } from '../../mcp/src/main/ets/core/endpoint';
import { ClientCredentialStore } from '../../mcp/src/main/ets/core/credentials';
import { McpSessionManager } from '../../mcp/src/main/ets/core/session';
import { PairingManager } from '../../mcp/src/main/ets/core/pairing';
import { McpServer, McpServerOptions } from '../../mcp/src/main/ets/core/server';
import {
  ClockLike,
  IConnection,
  IServerSocket,
  ServerTlsMaterial,
} from '../../mcp/src/main/ets/core/transport-ports';
import { CapturingLogger, NodeHasher } from '../test/support/platform';
import { MemoryNoteStore } from '../test/support/mcp-memory-note-store';

// ---------------------------------------------------------------------------
// TCP IServerSocket 适配器（仅台架；真实实现是鸿蒙适配器的 TLS Server）
// ---------------------------------------------------------------------------

class NetConnection implements IConnection {
  constructor(private readonly socket: net.Socket) {}

  get remoteAddress(): string {
    return this.socket.remoteAddress ?? 'unknown';
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.from(data), (err) => (err === undefined || err === null ? resolve() : reject(err)));
    });
  }

  close(): Promise<void> {
    if (this.socket.destroyed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.destroy();
    });
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.socket.on('data', (chunk: Buffer) => {
      cb(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
  }

  onClose(cb: () => void): void {
    this.socket.on('close', cb);
  }

  onError(cb: (err: Error) => void): void {
    this.socket.on('error', cb);
  }
}

class NetServerSocket implements IServerSocket {
  private server: net.Server | undefined;
  private connCb: ((conn: IConnection) => void) | undefined;
  private port: number = 0;

  async start(address: string, port: number): Promise<void> {
    this.server = net.createServer((socket: net.Socket) => {
      if (this.connCb !== undefined) {
        this.connCb(new NetConnection(socket));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, address, () => resolve());
    });
    const addressInfo = this.server!.address() as net.AddressInfo;
    this.port = addressInfo.port;
  }

  async stop(): Promise<void> {
    const server: net.Server | undefined = this.server;
    this.server = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  onConnection(cb: (conn: IConnection) => void): void {
    this.connCb = cb;
  }

  boundPort(): number {
    return this.port;
  }
}

/** 台架用 CA 假实现：TCP 明文台架不校验 TLS 材料，仅满足 McpServer 依赖。 */
class BenchCertificateAuthority {
  private material: ServerTlsMaterial = {
    keyPem: '(bench)',
    certPem: '(bench)',
    fingerprintSha256: crypto.createHash('sha256').update('bench').digest('hex'),
    generation: 1,
  };

  async current(): Promise<ServerTlsMaterial> {
    return this.material;
  }

  async rotate(): Promise<ServerTlsMaterial> {
    this.material = {
      ...this.material,
      generation: this.material.generation + 1,
      fingerprintSha256: crypto.createHash('sha256').update(`bench-${this.material.generation + 1}`).digest('hex'),
    };
    return this.material;
  }
}

// ---------------------------------------------------------------------------
// mini Host（Node http 原生客户端，Cherry Studio 行为要点）
// ---------------------------------------------------------------------------

interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

interface JsonRpcOk {
  readonly id: number;
  readonly result: unknown;
}

interface JsonRpcErr {
  readonly id: number | null;
  readonly error: { code: number; message: string };
}

const ACCEPT = 'application/json, text/event-stream';

class MiniHost {
  private idSeq: number = 0;
  private readonly agent: http.Agent;

  constructor(
    readonly port: number,
    private readonly token?: string,
  ) {
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  }

  /** kill TCP：销毁 keep-alive 连接池里的连接（仿真 Host 断线/进程重启）。 */
  killConnection(): void {
    this.agent.destroy();
  }

  dispose(): void {
    this.agent.destroy();
  }

  /** 底层 HTTP 请求（负向场景直接断言状态码用）。 */
  rawRequest(method: string, bodyText: string | undefined, headers: Record<string, string>): Promise<HttpResult> {
    const finalHeaders: Record<string, string> = { ...headers };
    if (bodyText !== undefined && finalHeaders['Content-Length'] === undefined && finalHeaders['content-length'] === undefined) {
      finalHeaders['Content-Length'] = String(Buffer.byteLength(bodyText, 'utf8'));
    }
    return new Promise<HttpResult>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/mcp',
          method,
          agent: this.agent,
          headers: finalHeaders,
        },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const headerMap: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') {
                headerMap[k.toLowerCase()] = v;
              }
            }
            resolve({ status: res.statusCode ?? 0, headers: headerMap, bodyText: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      if (bodyText !== undefined) {
        req.write(bodyText);
      }
      req.end();
    });
  }

  private post(body: unknown, sessionId?: string, extraHeaders?: Record<string, string>): Promise<HttpResult> {
    const bodyText: string = JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: ACCEPT,
      'Content-Type': 'application/json',
      // 服务端 HTTP/1.1 受限子集不支持 chunked 请求体（mcp-传输选型：固定长度）
      'Content-Length': String(Buffer.byteLength(bodyText, 'utf8')),
    };
    if (this.token !== undefined) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (sessionId !== undefined) {
      headers['Mcp-Session-Id'] = sessionId;
      headers['MCP-Protocol-Version'] = LOCKED_PROTOCOL_VERSION;
    }
    if (extraHeaders !== undefined) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers[k] = v;
      }
    }
    return this.rawRequest('POST', bodyText, headers);
  }

  async initialize(): Promise<{ status: number; sessionId: string | undefined; body: unknown }> {
    const id: number = ++this.idSeq;
    const resp: HttpResult = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'Cherry Studio (bench)', version: '2.1.3' },
      },
    });
    return {
      status: resp.status,
      sessionId: resp.headers['mcp-session-id'],
      body: safeParse(resp.bodyText),
    };
  }

  async notifyInitialized(sessionId: string): Promise<number> {
    const resp: HttpResult = await this.post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    return resp.status;
  }

  /** JSON-RPC 请求：断言 200 且 id 对应（协议错误以异常抛出，由场景记失败）。 */
  async call(sessionId: string, method: string, params?: unknown): Promise<JsonRpcOk | JsonRpcErr> {
    const id: number = ++this.idSeq;
    const resp: HttpResult = await this.post({ jsonrpc: '2.0', id, method, params }, sessionId);
    const body = safeParse(resp.bodyText);
    const obj = body as Record<string, unknown>;
    if (resp.status !== 200) {
      throw new Error(`expected HTTP 200, got ${resp.status}: ${resp.bodyText.slice(0, 120)}`);
    }
    if (obj === undefined || obj['jsonrpc'] !== '2.0' || obj['id'] !== id) {
      throw new Error(`invalid JSON-RPC envelope: ${resp.bodyText.slice(0, 200)}`);
    }
    if (obj['error'] !== undefined) {
      return { id, error: obj['error'] as { code: number; message: string } };
    }
    return { id, result: obj['result'] };
  }

  async ping(sessionId: string): Promise<unknown> {
    const ok = await this.call(sessionId, 'ping');
    if ('error' in ok) {
      throw new Error(`ping failed: ${ok.error.code} ${ok.error.message}`);
    }
    return ok.result;
  }

  /** 带任意会话 id 的原始 RPC 请求（负向场景：404/400 等状态码断言）。 */
  async rpcRaw(sessionId: string, method: string, params?: unknown): Promise<HttpResult> {
    const id: number = ++this.idSeq;
    return this.post({ jsonrpc: '2.0', id, method, params }, sessionId);
  }

  async callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<JsonRpcOk | JsonRpcErr> {
    return this.call(sessionId, 'tools/call', { name, arguments: args });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 场景结果收集
// ---------------------------------------------------------------------------

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface ScenarioResult {
  readonly name: string;
  readonly checks: Check[];
}

const scenarioResults: ScenarioResult[] = [];
let currentChecks: Check[] = [];

function scenario(name: string): void {
  currentChecks = [];
  scenarioResults.push({ name, checks: currentChecks });
}

function check(name: string, ok: boolean, detail: string = ''): void {
  currentChecks.push({ name, ok, detail });
  const mark: string = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const clock: ClockLike = { nowMs: () => Date.now() };
  const random = { nextBytes: (n: number) => new Uint8Array(crypto.randomBytes(n)) };
  const hasher = new NodeHasher();
  const logger = new CapturingLogger();

  const socket = new NetServerSocket();
  const sessions = new McpSessionManager(clock, random, { idleTtlMs: 30 * 60 * 1000 });
  const pairing = new PairingManager(random, clock, { codeTtlMs: 300_000, maxAttempts: 5 });
  const credentials = new ClientCredentialStore(random, hasher, clock, { tokenTtlMs: 30 * 24 * 3600 * 1000 });

  const auditRecords: McpAuditRecord[] = [];
  const auditSink = {
    append: async (r: McpAuditRecord): Promise<void> => {
      auditRecords.push(r);
    },
  };
  const policy = new AccessPolicy(clock);
  const gate = new PolicyGate(policy, auditSink, clock);

  const store = new MemoryNoteStore(clock);
  store.seedTag('col-1', '工作');
  store.seedTag('col-2', '生活');
  const APPEND_TARGET: string = store.seed({ title: '台架追加目标', content: '基准段落', tagIds: ['col-1'] });
  const GET_TARGET: string = store.seed({ title: '鸿蒙笔记', content: '鸿蒙 ArkTS 开发笔记 '.repeat(10), tagIds: ['col-1'] });
  store.seed({ title: '鸿蒙资料', content: '鸿蒙 分布式能力 '.repeat(10), tagIds: ['col-1'] });
  store.seed({ title: '私有笔记', content: '鸿蒙 秘密 '.repeat(5), tagIds: ['col-2'] });
  // delete_note 目标池：预置授权集合（col-1）内笔记，每个只删一次（软删除成功路径）
  const DISPOSABLE: string[] = [];
  for (let i = 0; i < 30; i++) {
    DISPOSABLE.push(store.seed({ title: `待删${i}`, content: `临时内容${i} 鸿蒙`, tagIds: ['col-1'] }));
  }

  const dispatcher = new ClipNoteMcpDispatcher(gate, store, clock, { windowMs: 60_000, maxCalls: 100_000 });
  const endpoint = new StreamableHttpEndpoint(sessions, dispatcher);
  const options: McpServerOptions = {
    maxHeaderBytes: 8192,
    maxBodyBytes: 4096,
    rateLimitPerMinute: 100_000,
    allowedHosts: ['127.0.0.1', 'localhost'],
  };
  const server = new McpServer(
    {
      socket,
      certificateAuthority: new BenchCertificateAuthority(),
      endpoint,
      sessions,
      pairing,
      credentials,
      clock,
      logger,
    },
    options,
  );
  await server.start('127.0.0.1', 0);
  const port: number = socket.boundPort();
  console.log(`bench server listening on 127.0.0.1:${port}`);

  // 凭证与授权（等价于 UI 配对确认后签发 + 用户授权）
  const issued = await credentials.issue('Cherry Studio', 1);
  const ALL_TOOLS: McpToolName[] = [
    McpToolName.SEARCH_NOTES,
    McpToolName.GET_NOTE,
    McpToolName.CREATE_NOTE,
    McpToolName.APPEND_TO_NOTE,
    McpToolName.DELETE_NOTE,
    McpToolName.LIST_TAGS,
  ];
  policy.grant({
    clientId: issued.clientId,
    tools: ALL_TOOLS,
    collectionIds: ['col-1'],
    maxResults: 10,
    maxSnippetChars: 120,
  });

  try {
    // -----------------------------------------------------------------------
    // 场景 1：≥100 次连续调用（混合 6 工具 + 穿插 ping），零协议错误
    // -----------------------------------------------------------------------
    scenario('S1 ≥100 次连续调用（混合 6 工具 + ping），零协议错误');
    const host = new MiniHost(port, issued.token);
    const init = await host.initialize();
    check('initialize 200 并签发 Mcp-Session-Id', init.status === 200 && init.sessionId !== undefined,
      `status=${init.status}`);
    check('协议版本锁定 2025-11-25',
      (init.body as { result?: { protocolVersion?: string } }).result?.protocolVersion === LOCKED_PROTOCOL_VERSION);
    const sessionId: string = init.sessionId!;
    check('notifications/initialized → 202', (await host.notifyInitialized(sessionId)) === 202);

    const list = await host.call(sessionId, 'tools/list');
    check('tools/list 返回 6 个已授权工具',
      'result' in list && ((list.result as { tools: unknown[] }).tools.length === 6));

    const TOOL_CYCLE: Array<(i: number) => [string, Record<string, unknown>]> = [
      () => [McpToolName.SEARCH_NOTES, { query: '鸿蒙', limit: 5 }],
      () => [McpToolName.GET_NOTE, { note_id: GET_TARGET }],
      (i) => [McpToolName.CREATE_NOTE, { title: `台架新建${i}`, content: `内容${i}`, collection_ids: ['col-1'] }],
      (i) => [McpToolName.APPEND_TO_NOTE, { note_id: APPEND_TARGET, content: `追加${i}`, idempotency_key: `bench-${i}` }],
      () => [McpToolName.DELETE_NOTE, {}],
      () => [McpToolName.LIST_TAGS, {}],
    ];
    const ITERATIONS = 120;
    const startedAt: number = Date.now();
    let pingOk = 0;
    let toolCalls = 0;
    let toolOk = 0;
    let toolIsError = 0;
    let protocolErrors = 0;
    let deleteIdx = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      try {
        const pingRes = await host.ping(sessionId);
        if (JSON.stringify(pingRes) === '{}') {
          pingOk++;
        } else {
          protocolErrors++;
        }
        let [toolName, args] = TOOL_CYCLE[i % TOOL_CYCLE.length](i);
        if (toolName === McpToolName.DELETE_NOTE) {
          // 预置池按序消费，每个只删一次（软删除成功路径）
          args = { note_id: DISPOSABLE[deleteIdx] };
          deleteIdx++;
        }
        toolCalls++;
        const res = await host.callTool(sessionId, toolName, args);
        if ('error' in res) {
          protocolErrors++;
          console.log(`    iteration ${i} tool=${toolName} rpc error: ${JSON.stringify(res.error)}`);
          continue;
        }
        if ((res.result as { isError?: boolean }).isError === true) {
          toolIsError++;
        } else {
          toolOk++;
        }
      } catch (err) {
        protocolErrors++;
        console.log(`    iteration ${i} protocol error: ${String(err)}`);
      }
    }
    const elapsedMs: number = Date.now() - startedAt;
    check('≥100 次连续 tools/call 零协议错误', protocolErrors === 0 && toolCalls >= 100,
      `tools/call=${toolCalls}（成功=${toolOk}，业务isError=${toolIsError}），ping=${pingOk}，协议错误=${protocolErrors}，耗时=${elapsedMs}ms`);
    check('审计轨迹全部 ok（连续调用无非授权拒绝）',
      auditRecords.length === toolCalls && auditRecords.every((r) => r.result === 'ok'),
      `审计记录=${auditRecords.length}`);

    // -----------------------------------------------------------------------
    // 场景 2：断线恢复 + 未知会话 404 + 重新 initialize
    // -----------------------------------------------------------------------
    scenario('S2 断线恢复：kill TCP 后带原会话继续；未知会话 404 → 重新 initialize');
    const beforePing: unknown = await host.ping(sessionId);
    check('断线前调用正常', JSON.stringify(beforePing) === '{}');
    host.killConnection();
    await new Promise((r) => setTimeout(r, 50));
    const afterPing: unknown = await host.ping(sessionId);
    check('kill TCP 后新连接带原 Mcp-Session-Id 继续调用成功', JSON.stringify(afterPing) === '{}');

    const unknownResp: HttpResult = await host.rpcRaw('00000000-0000-4000-8000-000000000000', 'ping');
    check('未知/过期会话 → 404（Host 须重新 initialize）', unknownResp.status === 404, `status=${unknownResp.status}`);

    const reinit = await host.initialize();
    check('重新 initialize 恢复（新会话可用）', reinit.status === 200 && reinit.sessionId !== undefined
      && JSON.stringify(await host.ping(reinit.sessionId!)) === '{}');
    host.dispose();

    // -----------------------------------------------------------------------
    // 场景 3：未授权访问全拒绝
    // -----------------------------------------------------------------------
    scenario('S3 未授权访问全拒绝（401 / -32002）');
    const noAuth = new MiniHost(port);
    const noAuthInit = await noAuth.initialize();
    check('无 Bearer → initialize 401', noAuthInit.status === 401, `status=${noAuthInit.status}`);
    noAuth.dispose();

    const badAuth = new MiniHost(port, 'bogus-token');
    const badAuthInit = await badAuth.initialize();
    check('错误 Bearer → initialize 401', badAuthInit.status === 401, `status=${badAuthInit.status}`);
    badAuth.dispose();

    const limitedIssued = await credentials.issue('Limited Host', 1);
    policy.grant({ clientId: limitedIssued.clientId, tools: [McpToolName.LIST_TAGS] });
    const limitedHost = new MiniHost(port, limitedIssued.token);
    const limitedInit = await limitedHost.initialize();
    const limitedSession: string = limitedInit.sessionId!;
    const deniedTool = await limitedHost.callTool(limitedSession, McpToolName.SEARCH_NOTES, { query: '鸿蒙' });
    check('已认证但未授予工具 → JSON-RPC -32002',
      'error' in deniedTool && deniedTool.error.code === -32002,
      JSON.stringify(deniedTool));
    const allowedTool = await limitedHost.callTool(limitedSession, McpToolName.LIST_TAGS, {});
    check('已授予工具仍可用（-32002 非传输故障）',
      'result' in allowedTool && (allowedTool.result as { isError?: boolean }).isError !== true);
    limitedHost.dispose();

    // -----------------------------------------------------------------------
    // 场景 4：撤销即时生效
    // -----------------------------------------------------------------------
    scenario('S4 撤销即时生效（revoke 后下一调用即拒）');
    const host4 = new MiniHost(port, issued.token);
    const init4 = await host4.initialize();
    const session4: string = init4.sessionId!;
    const beforeRevoke = await host4.callTool(session4, McpToolName.SEARCH_NOTES, { query: '鸿蒙' });
    check('撤销前调用正常', 'result' in beforeRevoke && (beforeRevoke.result as { isError?: boolean }).isError !== true);
    policy.revoke(issued.clientId);
    const afterRevoke = await host4.callTool(session4, McpToolName.SEARCH_NOTES, { query: '鸿蒙' });
    check('revoke 后下一调用即 -32002', 'error' in afterRevoke && afterRevoke.error.code === -32002,
      JSON.stringify(afterRevoke));
    check('撤销产生 denied 审计', auditRecords.some((r) => r.result === 'denied' && r.clientId === issued.clientId));
    policy.grant({
      clientId: issued.clientId,
      tools: ALL_TOOLS,
      collectionIds: ['col-1'],
      maxResults: 10,
      maxSnippetChars: 120,
    });
    const regranted = await host4.callTool(session4, McpToolName.SEARCH_NOTES, { query: '鸿蒙' });
    check('重新 grant 后恢复', 'result' in regranted && (regranted.result as { isError?: boolean }).isError !== true);
    host4.dispose();

    // -----------------------------------------------------------------------
    // 场景 5：Origin/Host 异常 403；超限体积 413
    // -----------------------------------------------------------------------
    scenario('S5 Origin/Host 异常 → 403；超限体积 → 413');
    const evilHost = new MiniHost(port, issued.token);
    const evilResp = await evilHost.rawRequest(
      'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      { Host: 'evil.example.com', Accept: ACCEPT, 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
    );
    check('Host 异常 → 403', evilResp.status === 403, `status=${evilResp.status}`);

    const originResp = await evilHost.rawRequest(
      'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://evil.example.com',
        Accept: ACCEPT,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.token}`,
      },
    );
    check('Origin 异常 → 403', originResp.status === 403, `status=${originResp.status}`);

    const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { pad: 'x'.repeat(6000) } });
    const bigResp = await evilHost.rawRequest(
      'POST',
      bigBody,
      { Host: `127.0.0.1:${port}`, Accept: ACCEPT, 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
    );
    check('超限体积 → 413', bigResp.status === 413, `status=${bigResp.status}`);
    evilHost.dispose();
  } finally {
    await server.stop();
  }

  // ---------------------------------------------------------------------------
  // 报告
  // ---------------------------------------------------------------------------
  const failures: number = scenarioResults.reduce(
    (n, s) => n + s.checks.filter((c) => !c.ok).length,
    0,
  );
  const totalChecks: number = scenarioResults.reduce((n, s) => n + s.checks.length, 0);
  const reportPath: string = path.join(process.cwd(), 'report', 'g3-interop.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderReport(failures, totalChecks, auditRecords), 'utf8');
  console.log(`\nreport written: ${reportPath}`);
  console.log(failures === 0 ? `G3 主机侧台架全部通过（${totalChecks}/${totalChecks}）` : `G3 台架存在失败项（${failures}/${totalChecks}）`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

function renderReport(failures: number, totalChecks: number, auditRecords: McpAuditRecord[]): string {
  const lines: string[] = [];
  lines.push('# G3 主机侧互操作台架报告');
  lines.push('');
  lines.push(`- 日期：${new Date().toISOString()}`);
  lines.push(`- 环境：Node ${process.version} / ${os.platform()} ${os.release()} / ${os.arch()}`);
  lines.push('- 栈：真 McpServer + StreamableHttpEndpoint + ClipNoteMcpDispatcher + AccessPolicy/PolicyGate（内存审计 sink）；TCP 为 Node `net` 适配器（localhost 明文，TLS 属鸿蒙适配器真机项 R-A）');
  lines.push('- Host：mini Host 仿真 Cherry Studio（决议 M4：POST /mcp、自定义 Bearer Header、Accept: application/json, text/event-stream，完整 2025-11-25 生命周期）');
  lines.push('');
  lines.push('## 场景结果');
  lines.push('');
  for (const s of scenarioResults) {
    const allOk: boolean = s.checks.every((c) => c.ok);
    lines.push(`### ${allOk ? '✅' : '❌'} ${s.name}`);
    lines.push('');
    for (const c of s.checks) {
      lines.push(`- ${c.ok ? 'PASS' : 'FAIL'}：${c.name}${c.detail === '' ? '' : `（${c.detail}）`}`);
    }
    lines.push('');
  }
  const denied: number = auditRecords.filter((r) => r.result === 'denied').length;
  const ok: number = auditRecords.filter((r) => r.result === 'ok').length;
  const errors: number = auditRecords.filter((r) => r.result === 'error').length;
  lines.push('## 审计汇总');
  lines.push('');
  lines.push(`- 总记录 ${auditRecords.length}：ok=${ok} / denied=${denied} / error=${errors}（只记元数据，无正文无令牌）`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  if (failures === 0) {
    lines.push(`- **G3 主机侧台架全部通过（${totalChecks}/${totalChecks} 硬断言）**：连续调用零协议错误、断线恢复、401/-32002 全拒绝、撤销即时生效、403/413 安全闸均符合 design §8 G3 口径。`);
  } else {
    lines.push(`- **G3 主机侧台架存在 ${failures} 项失败（共 ${totalChecks} 项硬断言），见上方 FAIL 项。**`);
  }
  lines.push('- **遗留真机项**：Cherry Studio 实机 ↔ 真机（HarmonyOS TLS 适配器 + 自签证书 TOFU）互操作复核；设备侧证书生成/轮换、SSE 心跳真机行为、Android/iOS Host 兼容不在本台架范围。');
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error('g3-interop bench crashed:', err);
  process.exitCode = 1;
});
