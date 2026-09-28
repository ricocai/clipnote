import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accepts,
  encodeChunk,
  encodeFixedResponse,
  encodeSseComment,
  encodeSseEvent,
  headerValue,
  HttpParseError,
  HttpRequestParser,
  isSafeHeaderValue,
  utf8Decode,
  utf8Encode,
} from '../../mcp/src/main/ets/core/http11';
import {
  encodeError,
  encodeResult,
  parseEnvelope,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
} from '../../mcp/src/main/ets/core/jsonrpc';
import { McpSessionManager } from '../../mcp/src/main/ets/core/session';
import { FixedClock, SequentialRandom } from './support/platform';

function feedText(parser: HttpRequestParser, text: string): void {
  parser.feed(utf8Encode(text));
}

test('HttpRequestParser 解析最小 GET 请求', () => {
  const parser = new HttpRequestParser(8192, 1024);
  feedText(parser, 'GET /mcp HTTP/1.1\r\nHost: 192.168.1.5\r\n\r\n');
  const req = parser.nextRequest();
  assert.ok(req);
  assert.equal(req!.method, 'GET');
  assert.equal(req!.target, '/mcp');
  assert.equal(headerValue(req!, 'host'), '192.168.1.5');
  assert.equal(req!.body.length, 0);
  assert.equal(parser.nextRequest(), undefined);
});

test('HttpRequestParser 增量喂入：跨块凑齐请求行/头/体', () => {
  const parser = new HttpRequestParser(8192, 1024);
  const raw = 'POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhe';
  feedText(parser, raw);
  assert.equal(parser.nextRequest(), undefined);
  feedText(parser, 'llo');
  const req = parser.nextRequest();
  assert.ok(req);
  assert.equal(utf8Decode(req!.body), 'hello');
});

test('HttpRequestParser 同一缓冲区顺序解析 keep-alive 管道上的多个请求', () => {
  const parser = new HttpRequestParser(8192, 1024);
  feedText(parser,
    'GET /a HTTP/1.1\r\nHost: x\r\n\r\n' +
    'GET /b HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(parser.nextRequest()!.target, '/a');
  assert.equal(parser.nextRequest()!.target, '/b');
  assert.equal(parser.nextRequest(), undefined);
});

test('HttpRequestParser 拒绝 chunked 请求体（受限子集边界）', () => {
  const parser = new HttpRequestParser(8192, 1024);
  feedText(parser, 'POST /mcp HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n');
  assert.throws(() => parser.nextRequest(), (e: unknown) => e instanceof HttpParseError && e.status === 400);
});

test('HttpRequestParser 请求行/版本/Content-Length 非法均拒绝', () => {
  // HTTP/2.0：受限 HTTP/1.1 子集 → 505
  const p1 = new HttpRequestParser(8192, 1024);
  feedText(p1, 'GET /mcp HTTP/2.0\r\nHost: x\r\n\r\n');
  assert.throws(() => p1.nextRequest(), (e: unknown) => e instanceof HttpParseError && e.status === 505);

  for (const raw of [
    'GET\r\nHost: x\r\n\r\n',
    'GET notpath HTTP/1.1\r\nHost: x\r\n\r\n',
    'POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n',
  ]) {
    const parser = new HttpRequestParser(8192, 1024);
    feedText(parser, raw);
    assert.throws(() => parser.nextRequest(), (e: unknown) => e instanceof HttpParseError && e.status === 400, raw);
  }
});

test('HttpRequestParser 头块超限 431、体超限 413', () => {
  const parser = new HttpRequestParser(64, 16);
  feedText(parser, 'GET / HTTP/1.1\r\nHost: this-host-header-value-is-far-too-long-to-fit\r\n\r\n');
  assert.throws(() => parser.nextRequest(), (e: unknown) => e instanceof HttpParseError && e.status === 431);

  const parser2 = new HttpRequestParser(8192, 8);
  feedText(parser2, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n');
  assert.throws(() => parser2.nextRequest(), (e: unknown) => e instanceof HttpParseError && e.status === 413);
});

test('utf8 编解码往返含多字节与代理对', () => {
  const text = '中文🙂笔记é';
  assert.equal(utf8Decode(utf8Encode(text)), text);
});

test('isSafeHeaderValue 拒绝 CRLF 注入', () => {
  assert.equal(isSafeHeaderValue('ok value'), true);
  assert.equal(isSafeHeaderValue('bad\r\nvalue'), false);
  assert.equal(isSafeHeaderValue('bad\nvalue'), false);
});

test('encodeFixedResponse 自动补 Content-Length 与 Connection', () => {
  const out = encodeFixedResponse(200, [['Content-Type', 'application/json']], utf8Encode('{}'), true);
  const text = utf8Decode(out);
  assert.ok(text.startsWith('HTTP/1.1 200 OK\r\n'));
  assert.ok(text.includes('Content-Length: 2\r\n'));
  assert.ok(text.includes('Connection: keep-alive\r\n'));
  assert.ok(text.endsWith('\r\n\r\n{}'));
});

test('chunked 与 SSE 帧编码符合规范形态', () => {
  assert.equal(utf8Decode(encodeChunk(utf8Encode('abc'))), '3\r\nabc\r\n');
  assert.equal(utf8Decode(encodeSseEvent('{"x":1}')), 'event: message\r\ndata: {"x":1}\r\n\r\n');
  assert.equal(utf8Decode(encodeSseComment('ping')), ': ping\r\n\r\n');
});

test('accepts 支持通配与参数后缀', () => {
  assert.equal(accepts('text/event-stream', 'text/event-stream'), true);
  assert.equal(accepts('*/*', 'text/event-stream'), true);
  assert.equal(accepts('application/json, text/event-stream; charset=utf-8', 'text/event-stream'), true);
  assert.equal(accepts('application/json', 'text/event-stream'), false);
  assert.equal(accepts(undefined, 'text/event-stream'), false);
});

test('parseEnvelope 区分 request / notification / invalid', () => {
  const req = parseEnvelope('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"a":1}}');
  assert.equal(req.kind, 'request');
  if (req.kind === 'request') {
    assert.equal(req.request.method, 'initialize');
    assert.equal(req.request.id, 1);
  }

  const note = parseEnvelope('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.equal(note.kind, 'notification');

  assert.deepEqual(parseEnvelope('not json'), { kind: 'invalid', errorCode: JSONRPC_PARSE_ERROR });
  assert.deepEqual(parseEnvelope('[]'), { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST });
  assert.deepEqual(parseEnvelope('{"jsonrpc":"1.0","id":1,"method":"x"}'), { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST });
  // 非字符串 id 拒绝
  assert.deepEqual(parseEnvelope('{"jsonrpc":"2.0","id":{"a":1},"method":"x"}'), { kind: 'invalid', errorCode: JSONRPC_INVALID_REQUEST });
});

test('encodeResult / encodeError 产出规范信封', () => {
  assert.equal(encodeResult('a', { ok: 1 }), '{"jsonrpc":"2.0","id":"a","result":{"ok":1}}');
  assert.equal(encodeError(null, -32600, 'bad'), '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"bad"}}');
});

test('McpSessionManager 签发 UUIDv4 会话、滑动过期、404 语义', () => {
  const clock = new FixedClock(1_000_000);
  const manager = new McpSessionManager(clock, new SequentialRandom(), { idleTtlMs: 5_000 });

  const s = manager.create('2025-11-25');
  assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(manager.size(), 1);

  // touch 命中并刷新空闲时间
  clock.advance(4_000);
  assert.equal(manager.touch(s.id)?.id, s.id);

  // 空闲超时：touch 未命中并清除尸体
  clock.advance(6_000);
  assert.equal(manager.touch(s.id), undefined);
  assert.equal(manager.size(), 0);

  // delete 与未知 id
  const s2 = manager.create('2025-11-25');
  assert.equal(manager.delete(s2.id), true);
  assert.equal(manager.delete('nope'), false);

  // sweep 批量清理
  manager.create('2025-11-25');
  manager.create('2025-11-25');
  clock.advance(6_000);
  assert.equal(manager.sweep(), 2);
  assert.equal(manager.size(), 0);

  // clear（退后台）
  manager.create('2025-11-25');
  manager.clear();
  assert.equal(manager.size(), 0);
});
