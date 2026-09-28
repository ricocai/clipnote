import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import { StreamableHttpEndpoint, McpDispatcher, JsonRpcMethodError } from '../../mcp/src/main/ets/core/endpoint';
import { ClientCredentialStore } from '../../mcp/src/main/ets/core/credentials';
import { McpSessionManager } from '../../mcp/src/main/ets/core/session';
import { PairingManager } from '../../mcp/src/main/ets/core/pairing';
import { McpServer, McpServerOptions } from '../../mcp/src/main/ets/core/server';
import { utf8Decode, utf8Encode } from '../../mcp/src/main/ets/core/http11';
import {
  AuthenticatedClient,
  IssuedCredential,
} from '../../mcp/src/main/ets/core/transport-ports';
import { CapturingLogger, FixedClock, NodeHasher, SequentialRandom } from './support/platform';
import { FakeCertificateAuthority, MemoryConnection, MemoryServerSocket } from './support/mcp-memory-socket';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const PROTOCOL = '2025-11-25';

class Fixture {
  readonly clock = new FixedClock(1_700_000_000_000);
  readonly random = new SequentialRandom();
  readonly hasher = new NodeHasher();
  readonly logger = new CapturingLogger();
  readonly ca = new FakeCertificateAuthority((s) => crypto.createHash('sha256').update(s).digest('hex'));
  readonly socket = new MemoryServerSocket(this.ca.peek());
  readonly sessions = new McpSessionManager(this.clock, this.random, { idleTtlMs: 300_000 });
  readonly pairing = new PairingManager(this.random, this.clock, { codeTtlMs: 300_000, maxAttempts: 5 });
  readonly credentials = new ClientCredentialStore(this.random, this.hasher, this.clock, { tokenTtlMs: 30 * 24 * 3600 * 1000 });
  readonly dispatcher: McpDispatcher = {
    async initialize(clientProtocolVersion: string | undefined, params: Record<string, unknown> | undefined, client: AuthenticatedClient) {
      return {
        protocolVersion: PROTOCOL,
        result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'clipnote', version: '0.1.0' } },
      };
    },
    async dispatch(session: unknown, method: string, params: Record<string, unknown> | undefined, client: AuthenticatedClient) {
      if (method === 'tools/list') {
        return { tools: [] };
      }
      throw new JsonRpcMethodError(-32601, 'method not found');
    },
  };
  readonly endpoint = new StreamableHttpEndpoint(this.sessions, this.dispatcher);
  readonly options: McpServerOptions = {
    maxHeaderBytes: 8192,
    maxBodyBytes: 4096,
    rateLimitPerMinute: 100,
    allowedHosts: ['192.168.1.5', 'localhost'],
  };
  readonly server = new McpServer({
    socket: this.socket,
    certificateAuthority: this.ca,
    endpoint: this.endpoint,
    sessions: this.sessions,
    pairing: this.pairing,
    credentials: this.credentials,
    clock: this.clock,
    logger: this.logger,
  }, this.options);

  async start(): Promise<void> {
    await this.server.start('192.168.1.5', 8765);
  }
}

interface ParsedResponse {
  status: number;
  headers: Array<readonly [string, string]>;
  bodyText: string;
}

/** 测试客户端：同步收字节，await response() 取下一个完整响应。 */
class TestClient {
  private buffer: Uint8Array = new Uint8Array(0);
  private waiters: Array<() => void> = [];
  hijacked: boolean = false;

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
    // 默认 Host 可被显式传入的同名字头覆盖（重复 Host 属于非法请求，测试不制造它）
    const entries: Array<[string, string]> = [['Host', '192.168.1.5']];
    for (const [k, v] of Object.entries(headers)) {
      const idx = entries.findIndex(([n]) => n.toLowerCase() === k.toLowerCase());
      if (idx >= 0) {
        entries[idx] = [k, v];
      } else {
        entries.push([k, v]);
      }
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
        if (parsed.resp.headers.some(([n]) => n.toLowerCase() === 'transfer-encoding')) {
          this.hijacked = true;
        }
        return parsed.resp;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for response, buffer=' + JSON.stringify(utf8Decode(this.buffer).slice(0, 200)));
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 5);
      });
    }
  }

  /** SSE 挂起后读取原始流入字节（心跳等） */
  async awaitBytes(substr: string, timeoutMs: number = 1000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = utf8Decode(this.buffer);
      if (text.includes(substr)) {
        const out = text;
        this.buffer = new Uint8Array(0);
        return out;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${JSON.stringify(substr)} in stream`);
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
  const chunked = headers.some(([n]) => n === 'transfer-encoding');
  if (chunked) {
    // SSE 头：无终止条件，整段视为已就绪
    return {
      resp: { status, headers, bodyText: '' },
      rest: buf.subarray(bodyStart),
    };
  }
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

/** 与真实码不同的错码（确定性随机源下避免撞车） */
function wrongCode(real: string): string {
  return real === '000000' ? '111111' : '000000';
}

// ---------------------------------------------------------------------------
// 凭证存储
// ---------------------------------------------------------------------------

test('ClientCredentialStore 签发/校验/过期/撤销/续期/代际绑定', async () => {
  const f = new Fixture();
  const issued = await f.credentials.issue('Cherry Studio', 1);
  assert.equal(issued.certGeneration, 1);
  assert.ok(issued.token.length >= 43, '≥128 bit 熵的 base64url');

  const client = await f.credentials.authenticate(issued.token, 1);
  assert.equal(client?.clientId, issued.clientId);

  // 未知 token / 代际不符
  assert.equal(await f.credentials.authenticate('bogus', 1), undefined);
  assert.equal(await f.credentials.authenticate(issued.token, 2), undefined);

  // 过期
  f.clock.advance(31 * 24 * 3600 * 1000);
  assert.equal(await f.credentials.authenticate(issued.token, 1), undefined);

  // 撤销
  const issued2 = await f.credentials.issue('VS Code', 1);
  assert.equal(f.credentials.revoke(issued2.clientId), true);
  assert.equal(await f.credentials.authenticate(issued2.token, 1), undefined);
  assert.equal(f.credentials.revoke('nope'), false);

  // 续期：新 token 生效、旧 token 即刻失效
  const issued3 = await f.credentials.issue('Cherry Studio', 1);
  const renewed = await f.credentials.renew(issued3.clientId, 1);
  assert.ok(renewed);
  assert.notEqual(renewed!.token, issued3.token);
  assert.equal(await f.credentials.authenticate(issued3.token, 1), undefined);
  assert.equal((await f.credentials.authenticate(renewed!.token, 1))?.clientId, issued3.clientId);

  // list 不含已撤销
  assert.ok(!f.credentials.list().some((r) => r.clientId === issued2.clientId));
});

// ---------------------------------------------------------------------------
// 配对管理
// ---------------------------------------------------------------------------

test('PairingManager 配对码生成/错码限速/退后台失效', () => {
  const f = new Fixture();
  const view = f.pairing.newCode();
  assert.match(view.code, /^\d{6}$/);
  assert.equal(f.pairing.currentCode()?.code, view.code);

  // 错码累计，剩余次数递减
  const wrong = wrongCode(view.code);
  for (let i = 0; i < 4; i++) {
    const outcome = f.pairing.attempt(wrong, 'Host', '10.0.0.2');
    assert.equal(outcome.kind, 'invalid-code');
  }
  // 第 5 次错码：码作废
  const last = f.pairing.attempt(wrong, 'Host', '10.0.0.2');
  assert.equal(last.kind, 'no-active-code');
  assert.equal(f.pairing.currentCode(), undefined);

  // 无码时 attempt
  assert.equal(f.pairing.attempt(view.code, 'Host', '10.0.0.2').kind, 'no-active-code');

  // 正确码 → 挂起
  const view2 = f.pairing.newCode();
  const ok = f.pairing.attempt(view2.code, 'Cherry Studio', '10.0.0.2');
  assert.equal(ok.kind, 'pending');
  if (ok.kind === 'pending') {
    assert.equal(f.pairing.pending().length, 1);
    // 确认
    const confirmed = f.pairing.markConfirmed(ok.view.id);
    assert.equal(confirmed?.label, 'Cherry Studio');
    assert.equal(f.pairing.markConfirmed(ok.view.id), undefined, '重复确认拒绝');
    // 拒绝另一个
  }
  const view3 = f.pairing.newCode();
  const ok2 = f.pairing.attempt(view3.code, 'VS Code', '10.0.0.3');
  if (ok2.kind === 'pending') {
    assert.equal(f.pairing.markRejected(ok2.view.id), true);
    assert.equal(f.pairing.stateOf(ok2.view.id), 'rejected');
  }

  // 过期：码与挂起请求
  const view4 = f.pairing.newCode();
  const ok3 = f.pairing.attempt(view4.code, 'Late', '10.0.0.4');
  f.clock.advance(301_000);
  assert.equal(f.pairing.currentCode(), undefined);
  if (ok3.kind === 'pending') {
    assert.deepEqual(f.pairing.sweepExpired(), [ok3.view.id]);
    assert.equal(f.pairing.stateOf(ok3.view.id), 'expired');
  }

  // 退后台：全部失效
  const view5 = f.pairing.newCode();
  const ok4 = f.pairing.attempt(view5.code, 'Bg', '10.0.0.5');
  f.pairing.invalidateAll();
  assert.equal(f.pairing.currentCode(), undefined);
  assert.equal(f.pairing.pending().length, 0);
  if (ok4.kind === 'pending') {
    assert.equal(f.pairing.stateOf(ok4.view.id), undefined, '记录已清出');
  }
});

// ---------------------------------------------------------------------------
// 服务端端到端（内存 socket）
// ---------------------------------------------------------------------------

test('服务端：无凭证 /mcp 一律 401', async () => {
  const f = new Fixture();
  await f.start();
  const client = new TestClient(f.socket.connect('192.168.1.5'));
  client.send('POST', '/mcp', {}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  const resp = await client.nextResponse();
  assert.equal(resp.status, 401);
  await f.server.stop();
});

test('服务端：完整配对 → initialize → tools/list → DELETE 会话流程', async () => {
  const f = new Fixture();
  await f.start();
  const conn = f.socket.connect('192.168.1.5');
  const client = new TestClient(conn);

  // 1. 配对（Host 侧长轮询挂起）
  const code = f.server.newPairingCode().code;
  client.send('POST', '/pair', {}, JSON.stringify({ code, clientName: 'Cherry Studio' }));
  await new Promise((r) => setTimeout(r, 20)); // 让挂起登记
  const pendings = f.server.pendingPairings();
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0].clientName, 'Cherry Studio');

  // 2. UI 确认 → Host 收到 paired；UI 拿到一次性 token
  const issued: IssuedCredential | undefined = await f.server.confirmPairing(pendings[0].id);
  assert.ok(issued);
  const pairResp = await client.nextResponse();
  assert.equal(pairResp.status, 200);
  assert.match(pairResp.bodyText, /"status":"paired"/);

  // 3. initialize（无会话 id，Bearer 凭证）
  client.send('POST', '/mcp', bearer(issued!.token), JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Cherry Studio', version: '2.1.3' } },
  }));
  const initResp = await client.nextResponse();
  assert.equal(initResp.status, 200);
  const sessionId = initResp.headers.find(([n]) => n === 'mcp-session-id')?.[1];
  assert.ok(sessionId, 'initialize 必须签发 Mcp-Session-Id');
  const initBody = JSON.parse(initResp.bodyText);
  assert.equal(initBody.result.protocolVersion, PROTOCOL);

  // 4. 会话内 tools/list（带 MCP-Protocol-Version）
  client.send('POST', '/mcp', {
    ...bearer(issued!.token),
    'Mcp-Session-Id': sessionId!,
    'MCP-Protocol-Version': PROTOCOL,
  }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const listResp = await client.nextResponse();
  assert.equal(listResp.status, 200);
  assert.deepEqual(JSON.parse(listResp.bodyText).result, { tools: [] });

  // 5. 协议版本不符 → 400
  client.send('POST', '/mcp', {
    ...bearer(issued!.token),
    'Mcp-Session-Id': sessionId!,
    'MCP-Protocol-Version': '2026-07-28',
  }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  assert.equal((await client.nextResponse()).status, 400);

  // 6. 通知 → 202
  client.send('POST', '/mcp', {
    ...bearer(issued!.token),
    'Mcp-Session-Id': sessionId!,
  }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal((await client.nextResponse()).status, 202);

  // 7. DELETE 终止会话，之后旧会话 404
  client.send('DELETE', '/mcp', { ...bearer(issued!.token), 'Mcp-Session-Id': sessionId! });
  assert.equal((await client.nextResponse()).status, 200);
  client.send('POST', '/mcp', {
    ...bearer(issued!.token),
    'Mcp-Session-Id': sessionId!,
  }, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
  assert.equal((await client.nextResponse()).status, 404);

  await f.server.stop();
});

test('服务端：initialize-only 语义 —— 无会话 id 的非 initialize 请求 400；未知会话 404', async () => {
  const f = new Fixture();
  await f.start();
  const issued = await f.credentials.issue('H', 1);
  const client = new TestClient(f.socket.connect('192.168.1.5'));

  client.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal((await client.nextResponse()).status, 400);

  client.send('POST', '/mcp', { ...bearer(issued.token), 'Mcp-Session-Id': 'no-such' }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const resp = await client.nextResponse();
  assert.equal(resp.status, 404);

  await f.server.stop();
});

test('服务端：配对拒绝与过期（tick 清扫唤醒长轮询）', async () => {
  const f = new Fixture();
  await f.start();

  // 拒绝
  const c1 = new TestClient(f.socket.connect('192.168.1.5'));
  const code1 = f.server.newPairingCode().code;
  c1.send('POST', '/pair', {}, JSON.stringify({ code: code1, clientName: 'R' }));
  await new Promise((r) => setTimeout(r, 20));
  const id1 = f.server.pendingPairings()[0].id;
  assert.equal(f.server.rejectPairing(id1), true);
  assert.equal((await c1.nextResponse()).status, 403);

  // 过期：时钟越过码有效期，tick 清扫后挂起请求收到 410
  const c2 = new TestClient(f.socket.connect('192.168.1.5'));
  const code2 = f.server.newPairingCode().code;
  c2.send('POST', '/pair', {}, JSON.stringify({ code: code2, clientName: 'E' }));
  await new Promise((r) => setTimeout(r, 20));
  f.clock.advance(301_000);
  f.server.tick();
  assert.equal((await c2.nextResponse()).status, 410);

  await f.server.stop();
});

test('服务端：错配对码 401 递减剩余次数，超限作废返回 409', async () => {
  const f = new Fixture();
  await f.start();
  const client = new TestClient(f.socket.connect('192.168.1.5'));
  f.server.newPairingCode();

  for (let i = 0; i < 4; i++) {
    client.send('POST', '/pair', {}, JSON.stringify({ code: '999999', clientName: 'X' }));
    const resp = await client.nextResponse();
    assert.equal(resp.status, 401);
    assert.match(resp.bodyText, new RegExp(`"remainingAttempts":${4 - i}`));
  }
  client.send('POST', '/pair', {}, JSON.stringify({ code: '999999', clientName: 'X' }));
  assert.equal((await client.nextResponse()).status, 409);

  // 码作废后正确码同样 409
  client.send('POST', '/pair', {}, JSON.stringify({ code: f.server.currentPairingCode()?.code ?? '', clientName: 'X' }));
  assert.equal((await client.nextResponse()).status, 409);

  await f.server.stop();
});

test('服务端：Origin/Host 不符 403（DNS rebinding 防护）', async () => {
  const f = new Fixture();
  await f.start();
  const issued = await f.credentials.issue('H', 1);

  // Host 不符
  const c1 = new TestClient(f.socket.connect('192.168.1.5'));
  c1.send('POST', '/mcp', { Host: 'evil.example.com', ...bearer(issued.token) }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((await c1.nextResponse()).status, 403);

  // Origin 不符（Host 合规）
  const c2 = new TestClient(f.socket.connect('192.168.1.5'));
  c2.send('POST', '/mcp', { Origin: 'http://evil.example.com', ...bearer(issued.token) }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((await c2.nextResponse()).status, 403);

  // Origin 合规（局域网 IP）放行
  const c3 = new TestClient(f.socket.connect('192.168.1.5'));
  c3.send('POST', '/mcp', { Origin: 'http://192.168.1.5:8765', ...bearer(issued.token) }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((await c3.nextResponse()).status, 200);

  await f.server.stop();
});

test('服务端：GET /mcp 开 SSE 流并收到心跳；无 Accept 拒绝 406', async () => {
  const f = new Fixture();
  await f.start();
  const issued = await f.credentials.issue('H', 1);

  // 无 Accept: text/event-stream → 406
  const init = new TestClient(f.socket.connect('192.168.1.5'));
  init.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  const initResp = await init.nextResponse();
  const sessionId = initResp.headers.find(([n]) => n === 'mcp-session-id')![1];
  init.send('GET', '/mcp', { ...bearer(issued.token), 'Mcp-Session-Id': sessionId }, undefined);
  assert.equal((await init.nextResponse()).status, 406);

  // 正确 SSE：200 chunked 头，tick 后有心跳注释帧
  const stream = new TestClient(f.socket.connect('192.168.1.5'));
  stream.send('GET', '/mcp', { ...bearer(issued.token), 'Mcp-Session-Id': sessionId, Accept: 'text/event-stream' }, undefined);
  const sseResp = await stream.nextResponse();
  assert.equal(sseResp.status, 200);
  assert.ok(sseResp.headers.some(([n, v]) => n === 'content-type' && v === 'text/event-stream'));
  f.server.tick();
  const flowed = await stream.awaitBytes(': ping');
  assert.ok(flowed.includes(': ping'));

  await f.server.stop();
});

test('服务端：速率限制 429、超大请求体 413', async () => {
  const f = new Fixture();
  (f.options as { rateLimitPerMinute: number }).rateLimitPerMinute = 3;
  await f.start();
  const issued = await f.credentials.issue('H', 1);
  const client = new TestClient(f.socket.connect('192.168.1.5'));
  for (let i = 0; i < 3; i++) {
    client.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: i, method: 'initialize' }));
    assert.notEqual((await client.nextResponse()).status, 429);
  }
  client.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize' }));
  assert.equal((await client.nextResponse()).status, 429);
  await f.server.stop();

  // 413：maxBodyBytes 上限
  const g = new Fixture();
  await g.start();
  const big = new TestClient(g.socket.connect('192.168.1.5'));
  const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: 'x'.repeat(5000) } });
  big.send('POST', '/mcp', { ...bearer((await g.credentials.issue('H', 1)).token), 'Content-Length': String(utf8Encode(bigBody).length) }, bigBody);
  assert.equal((await big.nextResponse()).status, 413);
  await g.server.stop();
});

test('服务端：证书轮换后旧代际凭证全部拒绝（更新后重建信任）', async () => {
  const f = new Fixture();
  await f.start();
  const before = f.server.state();
  assert.equal(before.certGeneration, 1);
  assert.match(f.server.fingerprintDisplay(), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  const issued = await f.credentials.issue('Cherry Studio', before.certGeneration);
  const conn = new TestClient(f.socket.connect('192.168.1.5'));
  conn.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((await conn.nextResponse()).status, 200);

  // 轮换：指纹变化、代际 +1、旧 token 401、旧会话清除
  const material = await f.server.rotateCertificate();
  assert.equal(material.generation, 2);
  assert.notEqual(f.server.state().fingerprintSha256, before.fingerprintSha256);
  assert.equal(f.sessions.size(), 0);

  conn.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }));
  assert.equal((await conn.nextResponse()).status, 401);

  // 重新配对（新码 + 新代际凭证）可用
  const code = f.server.newPairingCode().code;
  conn.send('POST', '/pair', {}, JSON.stringify({ code, clientName: 'Cherry Studio' }));
  await new Promise((r) => setTimeout(r, 20));
  const pending = f.server.pendingPairings()[0];
  const reissued = await f.server.confirmPairing(pending.id);
  assert.equal(reissued!.certGeneration, 2);
  await conn.nextResponse(); // paired
  conn.send('POST', '/mcp', bearer(reissued!.token), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize' }));
  assert.equal((await conn.nextResponse()).status, 200);

  await f.server.stop();
});

test('服务端：凭证过期与撤销 → 401；stop() 断开连接并清空状态', async () => {
  const f = new Fixture();
  await f.start();
  const issued = await f.credentials.issue('H', 1);

  // 过期
  f.clock.advance(31 * 24 * 3600 * 1000);
  const c1 = new TestClient(f.socket.connect('192.168.1.5'));
  c1.send('POST', '/mcp', bearer(issued.token), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((await c1.nextResponse()).status, 401);

  // 撤销
  const issued2 = await f.credentials.issue('H2', 1);
  f.credentials.revoke(issued2.clientId);
  const c2 = new TestClient(f.socket.connect('192.168.1.5'));
  c2.send('POST', '/mcp', bearer(issued2.token), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((await c2.nextResponse()).status, 401);

  // stop：连接关闭、会话清零、配对码失效
  const c3 = new TestClient(f.socket.connect('192.168.1.5'));
  c3.send('POST', '/mcp', bearer((await f.credentials.issue('H3', 1)).token), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  await c3.nextResponse();
  assert.ok(f.sessions.size() > 0);
  f.server.newPairingCode();
  await f.server.stop();
  assert.equal(f.server.isRunning(), false);
  assert.equal(f.sessions.size(), 0);
  assert.equal(f.server.currentPairingCode(), undefined);
});
