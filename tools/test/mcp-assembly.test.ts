/**
 * entry MCP 薄装配（S6-7）本机用例。
 *
 * 两条线都走**交付源码**（entry/src/main/ets/services/ 的 McpServiceCore /
 * McpNoteStoreAdapter，与本机测试编译同一文件），传输用内存假 socket
 * （support/mcp-memory-socket.ts），笔记走真实 SQLite 数据层：
 *
 *  1. 开关状态机：关 → start → 运行（端口/指纹）→ 配对确认签发凭证并授权
 *     → 撤销后凭证即刻拒绝 → stop 回关（会话/配对/授权清零）；
 *  2. 端到端 tools/call：真 HTTP 经 McpServer → endpoint → dispatcher →
 *     PolicyGate → McpNoteStoreAdapter（真实适配器）→ SQLite，覆盖
 *     create/append/search/get/delete/list_tags 六个首发工具与审计落库，
 *     断言 MCP 来源标记、revision 递增、软删除语义与片段文本。
 *
 * TLS 是鸿蒙适配器职责（R-A 真机项），本机为内存双工连接，协议语义不受影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { SearchRepository } from '../../common/src/main/ets/core/data/search-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { McpAuditRepository } from '../../common/src/main/ets/core/data/mcp-audit-repository';
import { NoteService } from '../../common/src/main/ets/core/notes';
import { BlobCas } from '../../common/src/main/ets/core/blob-cas';
import { McpServiceCore } from '../../entry/src/main/ets/services/McpServiceCore';
import {
  IssuedCredential,
  PendingPairingView,
} from '../../mcp/src/main/ets/core/transport-ports';
import { utf8Decode, utf8Encode } from '../../mcp/src/main/ets/core/http11';
import {
  FakeCertificateAuthority,
  MemoryConnection,
  MemoryServerSocket,
} from './support/mcp-memory-socket';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import {
  CapturingLogger,
  FixedClock,
  MemoryFileStore,
  NodeHasher,
  SequentialRandom,
} from './support/platform';

const BASE_MS = 1_759_000_000_000;
const PROTOCOL = '2025-11-25';
/** Host 侧地址（Host 头白名单成员） */
const HOST_ADDR = '10.0.0.2';
const MCP_PORT = 8765;

// ---------------------------------------------------------------------------
// 夹具：真实 SQLite 数据层 + 交付装配内核 + 内存 socket/CA
// ---------------------------------------------------------------------------

interface Fixture {
  db: NodeSqliteExecutor;
  clock: FixedClock;
  random: SequentialRandom;
  hasher: NodeHasher;
  logger: CapturingLogger;
  ca: FakeCertificateAuthority;
  socket: MemoryServerSocket;
  notes: NoteRepository;
  audit: McpAuditRepository;
  svc: NoteService;
  core: McpServiceCore;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const random = new SequentialRandom();
  const hasher = new NodeHasher();
  const notes = new NoteRepository({ db, clock, random, logger });
  const search = new SearchRepository({ db });
  const blobs = new BlobRepository({ db, logger });
  const blobCas = new BlobCas('/sandbox', new MemoryFileStore(), hasher, logger, random);
  const svc = new NoteService({ db, notes, search, blobs, blobCas, hasher, clock, logger });
  const audit = new McpAuditRepository(db);
  const ca = new FakeCertificateAuthority((s) => crypto.createHash('sha256').update(s).digest('hex'));
  const socket = new MemoryServerSocket(ca.peek());
  const core = new McpServiceCore({
    socket,
    certificateAuthority: ca,
    noteService: svc,
    notes: notes,
    auditStore: audit,
    clock,
    random,
    hasher,
    logger,
    address: '0.0.0.0',
    port: MCP_PORT,
    allowedHosts: [HOST_ADDR, 'localhost'],
  });
  return { db, clock, random, hasher, logger, ca, socket, notes, audit, svc, core };
}

// ---------------------------------------------------------------------------
// 测试客户端：同步收字节，await nextResponse() 取下一个完整 HTTP 响应
//（与 mcp-server.test.ts 同一手法）
// ---------------------------------------------------------------------------

interface ParsedResponse {
  status: number;
  headers: Array<readonly [string, string]>;
  bodyText: string;
}

function headerOf(resp: ParsedResponse, name: string): string | undefined {
  const hit = resp.headers.find(([n]) => n === name);
  return hit === undefined ? undefined : hit[1];
}

class TestClient {
  private buffer: Uint8Array = new Uint8Array(0);
  private waiters: Array<() => void> = [];

  constructor(readonly conn: MemoryConnection) {
    conn.onData((data: Uint8Array) => {
      const merged = new Uint8Array(this.buffer.length + data.length);
      merged.set(this.buffer);
      merged.set(data, this.buffer.length);
      this.buffer = merged;
      for (const w of this.waiters) {
        w();
      }
    });
  }

  send(method: string, target: string, headers: Record<string, string> = {}, body?: string): void {
    const bodyBytes: Uint8Array = body === undefined ? new Uint8Array(0) : utf8Encode(body);
    const entries: Array<[string, string]> = [['Host', HOST_ADDR]];
    for (const [k, v] of Object.entries(headers)) {
      entries.push([k, v]);
    }
    let raw = `${method} ${target} HTTP/1.1\r\n`;
    for (const [k, v] of entries) {
      raw += `${k}: ${v}\r\n`;
    }
    raw += `Content-Length: ${bodyBytes.length}\r\n\r\n`;
    const head = utf8Encode(raw);
    const out = new Uint8Array(head.length + bodyBytes.length);
    out.set(head, 0);
    out.set(bodyBytes, head.length);
    void this.conn.write(out);
  }

  async nextResponse(timeoutMs: number = 1000): Promise<ParsedResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = tryParseResponse(this.buffer);
      if (parsed !== undefined) {
        this.buffer = parsed.rest;
        return parsed.resp;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for response, buffer=' +
          JSON.stringify(utf8Decode(this.buffer).slice(0, 200)));
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 5);
      });
    }
  }
}

function tryParseResponse(buf: Uint8Array): { resp: ParsedResponse; rest: Uint8Array } | undefined {
  const text = utf8Decode(buf);
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    return undefined;
  }
  const headText = text.slice(0, headEnd);
  const lines = headText.split('\r\n');
  const status = Number(lines[0].split(' ')[1]);
  const headers: Array<readonly [string, string]> = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  const bodyStart = headEnd + 4;
  const contentLength = Number(headers.find(([n]) => n === 'content-length')?.[1] ?? '0');
  const total = bodyStart + contentLength;
  if (buf.length < total) {
    return undefined;
  }
  return {
    resp: { status, headers, bodyText: utf8Decode(buf.subarray(bodyStart, total)) },
    rest: buf.subarray(total),
  };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function initializeBody(id: number): string {
  return rpc(id, 'initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'assembly-test', version: '0.0.1' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等挂起的配对请求出现（/pair 长轮询已被服务端受理） */
async function waitForPending(f: Fixture, count: number): Promise<PendingPairingView[]> {
  for (let i = 0; i < 200; i++) {
    const pendings = f.core.pendingPairings();
    if (pendings.length >= count) {
      return pendings;
    }
    await sleep(5);
  }
  throw new Error(`pending pairings never reached ${count}`);
}

/**
 * 走真实 /pair 流程完成配对并确认（与设置页 UI 同一入口）：
 * 生成配对码 → Host 提交配对码（长轮询挂起）→ UI 确认（签发凭证 + 授权）。
 */
async function pairAndConfirm(f: Fixture, clientName: string): Promise<IssuedCredential> {
  const code = f.core.newPairingCode();
  const conn = new TestClient(f.socket.connect(HOST_ADDR));
  conn.send('POST', '/pair', {}, JSON.stringify({ code: code.code, clientName }));
  const pendings = await waitForPending(f, 1);
  const issued = await f.core.confirmPairing(pendings[0].id);
  assert.ok(issued, '确认配对必须签发凭证');
  const pairResp = await conn.nextResponse();
  assert.equal(pairResp.status, 200, '挂起的 /pair 应在确认后收到 paired');
  return issued;
}

/** 已初始化会话上的 tools/call；isError 信封直接抛错（测试即失败） */
async function callTool(
  f: Fixture,
  client: TestClient,
  sessionId: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  client.send('POST', '/mcp', {
    ...bearer(token),
    'Mcp-Session-Id': sessionId,
    'Mcp-Protocol-Version': PROTOCOL,
  }, rpc(id, 'tools/call', { name, arguments: args }));
  const resp = await client.nextResponse();
  assert.equal(resp.status, 200, `${name} 应返回 200：${resp.bodyText}`);
  const envelope = JSON.parse(resp.bodyText) as Record<string, unknown>;
  assert.equal(envelope['error'], undefined, `${name} 不应有协议错误：${resp.bodyText}`);
  const result = envelope['result'] as Record<string, unknown>;
  if (result['isError'] === true) {
    throw new Error(`${name} 返回 isError：${resp.bodyText}`);
  }
  const content = result['content'] as Array<Record<string, unknown>>;
  return JSON.parse(content[0]['text'] as string) as Record<string, unknown>;
}

async function initializeSession(
  f: Fixture,
  token: string,
): Promise<{ client: TestClient; sessionId: string }> {
  const client = new TestClient(f.socket.connect(HOST_ADDR));
  client.send('POST', '/mcp', bearer(token), initializeBody(1));
  const resp = await client.nextResponse();
  assert.equal(resp.status, 200, 'initialize 应返回 200');
  const sessionId = headerOf(resp, 'mcp-session-id');
  assert.ok(sessionId, 'initialize 必须签发 Mcp-Session-Id');
  return { client, sessionId };
}

// ---------------------------------------------------------------------------
// 1. 开关状态机
// ---------------------------------------------------------------------------

test('装配状态机：关 → start 运行 → 配对确认签发凭证并授权 → 撤销即拒 → stop 回关', async () => {
  const f = await makeFixture();

  // 关 → 开
  assert.equal(f.core.isRunning(), false, '初始未运行');
  await f.core.start();
  assert.equal(f.core.isRunning(), true);
  const st = f.core.state();
  assert.equal(st.boundPort, MCP_PORT, '端口固定 8765');
  assert.equal(st.fingerprintSha256.length, 64, '证书指纹为 64 位十六进制');
  assert.equal(st.certGeneration, 1);

  // 无配对码时 /pair → 409
  const anon = new TestClient(f.socket.connect(HOST_ADDR));
  anon.send('POST', '/pair', {}, JSON.stringify({ code: '000000', clientName: 'anon' }));
  assert.equal((await anon.nextResponse()).status, 409);

  // 真实 /pair 流程 + UI 确认
  const issued = await pairAndConfirm(f, 'Cherry Studio');

  // 确认即授权：全部 6 个首发工具（集合粒度 = 全部标签，夹具暂无标签）
  const clients = f.core.grantedClients();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientId, issued.clientId);
  assert.equal(clients[0].toolCount, 6, '确认配对授予全部 6 个首发工具');
  assert.equal(clients[0].label, 'Cherry Studio');

  // 凭证可用：initialize 成功签发会话
  const { sessionId } = await initializeSession(f, issued.token);
  assert.ok(sessionId.length > 0);

  // 撤销 → 凭证即刻拒绝（401），授权清单清空
  f.core.revokeClient(issued.clientId);
  assert.equal(f.core.grantedClients().length, 0);
  const rejected = new TestClient(f.socket.connect(HOST_ADDR));
  rejected.send('POST', '/mcp', bearer(issued.token), initializeBody(2));
  assert.equal((await rejected.nextResponse()).status, 401, '撤销后凭证必须拒绝');

  // stop → 回关
  await f.core.stop();
  assert.equal(f.core.isRunning(), false);
});

test('退后台语义：stop 使配对码/挂起请求即刻失效，授权与凭证清零', async () => {
  const f = await makeFixture();
  await f.core.start();

  const code = f.core.newPairingCode();
  assert.ok(f.core.currentPairingCode() !== undefined);
  const conn = new TestClient(f.socket.connect(HOST_ADDR));
  conn.send('POST', '/pair', {}, JSON.stringify({ code: code.code, clientName: 'H' }));
  const pendings = await waitForPending(f, 1);
  assert.equal(pendings.length, 1);

  const issued = await f.core.confirmPairing(pendings[0].id);
  assert.ok(issued);
  const pairResp = await conn.nextResponse();
  assert.equal(pairResp.status, 200);

  // stop（退后台）：配对码作废、挂起清空、授权与凭证清零
  await f.core.stop();
  assert.equal(f.core.isRunning(), false);
  assert.equal(f.core.currentPairingCode(), undefined, '配对码退后台即失效');
  assert.equal(f.core.pendingPairings().length, 0, '挂起请求退后台即清空');
  assert.equal(f.core.grantedClients().length, 0, '授权清单随前台周期清零');

  // 凭证同步失效：重启后旧 token 拒绝
  await f.core.start();
  const rejected = new TestClient(f.socket.connect(HOST_ADDR));
  rejected.send('POST', '/mcp', bearer(issued.token), initializeBody(1));
  assert.equal((await rejected.nextResponse()).status, 401, 'stop 后旧凭证必须拒绝');
  await f.core.stop();
});

// ---------------------------------------------------------------------------
// 2. 端到端 tools/call：真实适配器 + SQLite
// ---------------------------------------------------------------------------

test('端到端 tools/call 全六工具：真实适配器落 SQLite（来源/修订/软删/片段）', async () => {
  const f = await makeFixture();

  // 种子：一篇手工笔记 + 一个标签（标签 = 授权集合成员，配对确认时整体授予）
  const seed = await f.svc.save({ title: '会议记录', contentMd: '周会纪要 alpha 发布计划' });
  const tag = await f.notes.addTag(seed.id, '工作');
  f.clock.advance(60_000);

  await f.core.start();
  const issued = await pairAndConfirm(f, 'Cherry Studio');
  const { client, sessionId } = await initializeSession(f, issued.token);
  let rpcId = 10;

  // create_note：来源标记 MCP，revision=1
  const createContent = 'MCP 创建的正文 alpha\n第二行';
  const created = await callTool(f, client, sessionId, issued.token, rpcId++, 'create_note', {
    content: createContent,
  });
  const createdId = created['id'] as string;
  assert.equal(created['revision'], 1);
  assert.equal(created['title'], 'MCP 创建的正文 alpha', '标题缺省取正文首行');
  const createdRow = await f.notes.getById(createdId, true);
  assert.ok(createdRow);
  assert.equal(createdRow.source, 'mcp', 'MCP 创建的笔记来源必须标记为 mcp');
  assert.equal(createdRow.contentMd, createContent);
  assert.equal(createdRow.revision, 1);

  // 用户事后给笔记挂标签（授权集合成员）→ 后续工具可触达
  await f.notes.addTag(createdId, '工作');

  // append_to_note：dispatcher 已拼 "\n\n"，适配层整存，revision + 1
  const appended = await callTool(f, client, sessionId, issued.token, rpcId++, 'append_to_note', {
    note_id: createdId,
    content: '追加的尾巴',
  });
  assert.equal(appended['id'], createdId);
  assert.equal(appended['revision'], 2, '追加必须 revision + 1');
  const appendedRow = await f.notes.getById(createdId, true);
  assert.ok(appendedRow);
  assert.equal(appendedRow.contentMd, `${createContent}\n\n追加的尾巴`, '追加内容按 \\n\\n 拼接整存');
  assert.equal(appendedRow.source, 'mcp', '追加不改变来源');

  // search_notes：命中 + 片段文本非空
  const searched = await callTool(f, client, sessionId, issued.token, rpcId++, 'search_notes', {
    query: 'alpha',
  });
  const results = searched['results'] as Array<Record<string, unknown>>;
  const hit = results.find((r) => r['id'] === createdId);
  assert.ok(hit, '搜索必须命中 MCP 创建的笔记');
  assert.equal(typeof hit['snippet'], 'string');
  assert.ok((hit['snippet'] as string).length > 0, '片段文本非空');

  // get_note：正文 + 修订；tagIds 由适配层从数据层解析
  const detail = await callTool(f, client, sessionId, issued.token, rpcId++, 'get_note', {
    note_id: createdId,
  });
  assert.equal(detail['content'], `${createContent}\n\n追加的尾巴`);
  assert.equal(detail['revision'], 2);

  // list_tags：可见标签 = 与授权集合求交
  const listed = await callTool(f, client, sessionId, issued.token, rpcId++, 'list_tags', {});
  const tags = listed['tags'] as Array<Record<string, unknown>>;
  const workTag = tags.find((t) => t['id'] === tag.id);
  assert.ok(workTag, '授权集合内的标签必须可见');
  assert.equal(workTag['name'], '工作');

  // delete_note：软删除（回收站口径），搜索排除
  const deleted = await callTool(f, client, sessionId, issued.token, rpcId++, 'delete_note', {
    note_id: createdId,
  });
  assert.equal(deleted['deleted'], true);
  const deletedRow = await f.notes.getById(createdId, true);
  assert.ok(deletedRow);
  assert.ok(deletedRow.deletedAtMs !== undefined, '软删除必须记录 deleted_at');
  assert.equal(deletedRow.revision, 3, '软删除同样递增 revision');
  const afterDelete = await callTool(f, client, sessionId, issued.token, rpcId++, 'search_notes', {
    query: 'alpha',
  });
  const remaining = afterDelete['results'] as Array<Record<string, unknown>>;
  assert.ok(!remaining.some((r) => r['id'] === createdId), '回收站笔记必须排除在搜索外');

  // 审计落库：只记元数据，结果全部 ok
  const entries = await f.audit.query({});
  assert.ok(entries.length >= 7, `每次调用都必须落审计，实际 ${entries.length}`);
  assert.ok(entries.every((e) => e.result === 'ok'));

  await f.core.stop();
});
