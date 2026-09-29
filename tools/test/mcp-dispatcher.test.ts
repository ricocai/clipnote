/**
 * S6-3 用例：MCP 协议适配层 ClipNoteMcpDispatcher（设计 §4.5.5 + 协议锁定决议）。
 *
 * 覆盖：
 *  - initialize 版本协商锁定 2025-11-25（客户端声明任何版本一律回退）；
 *  - tools/list 按 grant 过滤（无 grant 空数组；未授予工具不可见）；
 *  - tools/call 参数校验（缺参/类型错 → -32602；未知工具名 → -32601）；
 *  - 授权拒绝映射 -32002（未授权客户端/未授予工具/集合越权），审计 denied；
 *  - search 越权对象静默剔除 + clampMaxResults/clampSnippet 收敛；
 *  - get_note 越权/不存在报 not found 不泄露存在性；正文不截断；
 *  - append 应用级幂等键重放不重复追加；expected_revision 冲突返回 current_revision；
 *  - delete 软删除 + 冲突；list_tags 空 scope 空列表；
 *  - 每 clientId 滑动窗限流超限 -32002；三态审计（ok 带 objectIds / denied / error）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AccessPolicy,
  McpAuditRecord,
  McpToolName,
  PolicyGate,
} from '../../mcp/src/main/ets/core/access-policy';
import {
  ClipNoteMcpDispatcher,
  DispatcherRateLimit,
  LOCKED_PROTOCOL_VERSION,
  MAX_NOTE_CONTENT_BYTES,
  NoteStoreLike,
  utf8ByteLength,
} from '../../mcp/src/main/ets/core/dispatcher';
import { JsonRpcMethodError } from '../../mcp/src/main/ets/core/endpoint';
import { McpSession } from '../../mcp/src/main/ets/core/session';
import { AuthenticatedClient } from '../../mcp/src/main/ets/core/transport-ports';
import { FixedClock } from './support/platform';
import { MemoryNoteStore } from './support/mcp-memory-note-store';

const CLIENT = 'client-A';
const OTHER = 'client-B';

const SESSION: McpSession = {
  id: 'sess-1',
  protocolVersion: LOCKED_PROTOCOL_VERSION,
  createdAtMs: 0,
  lastSeenMs: 0,
};

const CLIENT_CTX: AuthenticatedClient = { clientId: CLIENT, certGeneration: 1 };

class Fixture {
  readonly clock = new FixedClock(1_700_000_000_000);
  readonly store: MemoryNoteStore = new MemoryNoteStore(this.clock);
  readonly policy = new AccessPolicy(this.clock);
  readonly records: McpAuditRecord[] = [];
  readonly sink = {
    append: async (r: McpAuditRecord): Promise<void> => {
      this.records.push(r);
    },
  };
  readonly gate = new PolicyGate(this.policy, this.sink, this.clock);
  readonly rateLimit: DispatcherRateLimit = { windowMs: 60_000, maxCalls: 60 };
  readonly dispatcher: ClipNoteMcpDispatcher = new ClipNoteMcpDispatcher(this.gate, this.store as NoteStoreLike, this.clock, this.rateLimit);

  constructor() {
    this.store.seedTag('col-1', '工作');
    this.store.seedTag('col-2', '生活');
    this.store.seedTag('col-3', '阅读');
  }

  grant(tools: McpToolName[], extra?: { collectionIds?: string[]; noteIds?: string[]; maxResults?: number; maxSnippetChars?: number }): void {
    this.policy.grant({
      clientId: CLIENT,
      tools,
      collectionIds: extra?.collectionIds,
      noteIds: extra?.noteIds,
      maxResults: extra?.maxResults,
      maxSnippetChars: extra?.maxSnippetChars,
    });
  }

  dispatch(method: string, params?: Record<string, unknown>, clientId: string = CLIENT): Promise<unknown> {
    return this.dispatcher.dispatch(SESSION, method, params, { clientId, certGeneration: 1 });
  }

  callTool(name: string, args?: Record<string, unknown>, clientId: string = CLIENT): Promise<unknown> {
    return this.dispatch('tools/call', { name, arguments: args ?? {} }, clientId);
  }

  async callToolError(name: string, args?: Record<string, unknown>, clientId: string = CLIENT): Promise<JsonRpcMethodError> {
    try {
      await this.callTool(name, args, clientId);
    } catch (err) {
      assert.ok(err instanceof JsonRpcMethodError, `expected JsonRpcMethodError, got ${String(err)}`);
      return err as JsonRpcMethodError;
    }
    assert.fail('expected tools/call to reject with JsonRpcMethodError');
  }

  async dispatchError(method: string, params?: Record<string, unknown>, clientId: string = CLIENT): Promise<JsonRpcMethodError> {
    try {
      await this.dispatch(method, params, clientId);
    } catch (err) {
      assert.ok(err instanceof JsonRpcMethodError, `expected JsonRpcMethodError, got ${String(err)}`);
      return err as JsonRpcMethodError;
    }
    assert.fail(`expected dispatch('${method}') to reject with JsonRpcMethodError`);
  }
}

/** 解包 tools/call 成功结果（content[0].text 的 JSON）。 */
function unwrapResult(dispatchResult: unknown): Record<string, unknown> {
  const wrapper = dispatchResult as { content: Array<{ type: string; text: string }> };
  return JSON.parse(wrapper.content[0].text) as Record<string, unknown>;
}

/** 解包 tools/call isError 结果。 */
function unwrapError(dispatchResult: unknown): Record<string, unknown> {
  const wrapper = dispatchResult as { isError: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(wrapper.isError, true);
  return JSON.parse(wrapper.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// initialize 协商
// ---------------------------------------------------------------------------

test('dispatcher: initialize 无论客户端声明什么版本都锁定 2025-11-25', async () => {
  const f = new Fixture();
  for (const declared of [undefined, '2025-11-25', '2024-11-05', '2026-07-28']) {
    const negotiated = await f.dispatcher.initialize(declared, { protocolVersion: declared }, CLIENT_CTX);
    assert.equal(negotiated.protocolVersion, LOCKED_PROTOCOL_VERSION);
    const result = negotiated.result as Record<string, unknown>;
    assert.equal(result['protocolVersion'], LOCKED_PROTOCOL_VERSION);
    assert.deepEqual(result['capabilities'], { tools: {} });
    assert.deepEqual(result['serverInfo'], { name: 'clipnote', version: '0.2.0' });
  }
});

// ---------------------------------------------------------------------------
// ping / 未知方法 / tools/list
// ---------------------------------------------------------------------------

test('dispatcher: ping 返回空对象；未知方法 -32601', async () => {
  const f = new Fixture();
  assert.deepEqual(await f.dispatch('ping'), {});
  const err = await f.dispatchError('resources/list');
  assert.equal(err.code, -32601);
});

test('dispatcher: tools/list 无 grant 返回空数组，grant 后按清单过滤', async () => {
  const f = new Fixture();
  const empty = (await f.dispatch('tools/list')) as { tools: unknown[] };
  assert.deepEqual(empty.tools, []);

  f.grant([McpToolName.SEARCH_NOTES, McpToolName.GET_NOTE], { collectionIds: ['col-1'] });
  const listed = (await f.dispatch('tools/list')) as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), [McpToolName.GET_NOTE, McpToolName.SEARCH_NOTES].sort());
  for (const tool of listed.tools) {
    assert.ok(tool.description.length > 0, '中文 description 必填');
    assert.equal(tool.inputSchema['type'], 'object');
    assert.ok(Array.isArray(tool.inputSchema['required']));
  }
  // 未授予工具不可见（另一客户端仍为空）
  assert.deepEqual(((await f.dispatch('tools/list', undefined, OTHER)) as { tools: unknown[] }).tools, []);
});

// ---------------------------------------------------------------------------
// 参数校验与授权拒绝
// ---------------------------------------------------------------------------

test('dispatcher: tools/call 缺 name / 未知工具名 / 缺 query / 类型错 → -32602 或 -32601', async () => {
  const f = new Fixture();
  f.grant([McpToolName.SEARCH_NOTES]);

  const noName = await f.callToolError('');
  assert.equal(noName.code, -32602);

  const unknownTool = await f.callToolError('no_such_tool');
  assert.equal(unknownTool.code, -32601);

  const missingQuery = await f.callToolError(McpToolName.SEARCH_NOTES, {});
  assert.equal(missingQuery.code, -32602);

  const wrongType = await f.callToolError(McpToolName.SEARCH_NOTES, { query: 42 });
  assert.equal(wrongType.code, -32602);

  const wrongLimit = await f.callToolError(McpToolName.SEARCH_NOTES, { query: 'x', limit: 'ten' });
  assert.equal(wrongLimit.code, -32602);

  const badArgs = await f.dispatchError('tools/call', { name: McpToolName.SEARCH_NOTES, arguments: 'oops' });
  assert.equal(badArgs.code, -32602);
});

test('dispatcher: 未授权客户端与未授予工具调用 → -32002，审计 denied', async () => {
  const f = new Fixture();
  const err = await f.callToolError(McpToolName.SEARCH_NOTES, { query: 'x' }, OTHER);
  assert.equal(err.code, -32002);
  assert.match(err.message, /no grant for client/);

  f.grant([McpToolName.GET_NOTE]);
  const err2 = await f.callToolError(McpToolName.SEARCH_NOTES, { query: 'x' });
  assert.equal(err2.code, -32002);
  assert.match(err2.message, /tool not granted/);

  assert.deepEqual(f.records.map((r) => r.result), ['denied', 'denied']);
  assert.equal(f.records[0].clientId, OTHER);
  assert.equal(f.records[1].tool, McpToolName.SEARCH_NOTES);
});

test('dispatcher: AccessDeniedError 不吞掉重写为成功（denied 审计轨迹完整）', async () => {
  const f = new Fixture();
  f.grant([McpToolName.GET_NOTE], { noteIds: ['note-explicit'] });
  await f.callTool(McpToolName.GET_NOTE, { note_id: 'note-explicit' });
  f.policy.revoke(CLIENT);
  const err = await f.callToolError(McpToolName.GET_NOTE, { note_id: 'note-explicit' });
  assert.equal(err.code, -32002);
  assert.deepEqual(f.records.map((r) => r.result), ['ok', 'denied']);
});

// ---------------------------------------------------------------------------
// search_notes
// ---------------------------------------------------------------------------

test('dispatcher: search 越权对象静默剔除，条数/片段收敛到授权上限', async () => {
  const f = new Fixture();
  const inScope = f.store.seed({ title: '季度财报', content: '营收与毛利分析 '.repeat(20), tagIds: ['col-1'] });
  const outScope = f.store.seed({ title: '季度生活', content: '营收无关 '.repeat(20), tagIds: ['col-2'] });
  f.grant([McpToolName.SEARCH_NOTES], { collectionIds: ['col-1'], maxResults: 5, maxSnippetChars: 10 });

  const raw = await f.callTool(McpToolName.SEARCH_NOTES, { query: '营收', limit: 100 });
  const result = unwrapResult(raw) as { results: Array<{ id: string; title: string; snippet: string }> };
  assert.deepEqual(result.results.map((r) => r.id), [inScope], '越权候选静默剔除，不报错不泄露');
  assert.ok(!JSON.stringify(raw).includes('季度生活'));
  assert.equal(result.results[0].snippet.length, 10, '片段截断到 maxSnippetChars');

  // 条数收敛：授权上限 5，候选充足且全部在授权范围内 → 恰好 5 条
  for (let i = 0; i < 8; i++) {
    f.store.seed({ title: `毛利笔记${i}`, content: '毛利 '.repeat(30), tagIds: ['col-1'] });
  }
  const capped = unwrapResult(await f.callTool(McpToolName.SEARCH_NOTES, { query: '毛利', limit: 100 })) as { results: unknown[] };
  assert.equal(capped.results.length, 5);

  // ok 审计带触及对象 id 与载荷字节数
  const okRec = f.records[f.records.length - 1];
  assert.equal(okRec.result, 'ok');
  assert.equal(okRec.tool, McpToolName.SEARCH_NOTES);
  assert.equal(okRec.payloadBytes, utf8ByteLength(JSON.stringify({ query: '毛利', limit: 100 })));
  assert.ok(okRec.objectIds.length > 0);
  void outScope;
});

test('dispatcher: search 空授权集合只能访问显式授权对象', async () => {
  const f = new Fixture();
  f.store.seed({ title: '会议纪要', content: '会议结论纪要', tagIds: ['col-1'] });
  const explicit = f.store.seed({ title: '显式', content: '会议', tagIds: [] });
  f.grant([McpToolName.SEARCH_NOTES], { noteIds: [explicit] });

  const result = unwrapResult(await f.callTool(McpToolName.SEARCH_NOTES, { query: '会议' })) as { results: Array<{ id: string }> };
  assert.deepEqual(result.results.map((r) => r.id), [explicit]);
});

// ---------------------------------------------------------------------------
// get_note
// ---------------------------------------------------------------------------

test('dispatcher: get_note 越权/不存在报 not found 不泄露存在性；正文完整不截断', async () => {
  const f = new Fixture();
  const longBody: string = '正文内容'.repeat(500); // 4000 字符，超过默认片段上限
  const secret = f.store.seed({ title: '私密笔记', content: longBody, tagIds: ['col-2'] });
  f.grant([McpToolName.GET_NOTE], { collectionIds: ['col-1'], maxSnippetChars: 200 });

  const denied = unwrapError(await f.callTool(McpToolName.GET_NOTE, { note_id: secret }));
  assert.equal(denied['error'], 'note not found or not accessible');
  assert.ok(!JSON.stringify(denied).includes('私密笔记'), '不泄露标题');
  assert.ok(!JSON.stringify(denied).includes('正文内容'), '不泄露正文');

  const missing = unwrapError(await f.callTool(McpToolName.GET_NOTE, { note_id: 'no-such' }));
  assert.equal(missing['error'], 'note not found or not accessible');

  // 授权内：整本读取，正文不截断
  const pub = f.store.seed({ title: '公开', content: longBody, tagIds: ['col-1'] });
  const got = unwrapResult(await f.callTool(McpToolName.GET_NOTE, { note_id: pub })) as { id: string; title: string; content: string; revision: number };
  assert.equal(got.id, pub);
  assert.equal(got.content, longBody);
  assert.equal(got.revision, 1);
  assert.deepEqual(f.records[f.records.length - 1].objectIds, [pub]);
});

// ---------------------------------------------------------------------------
// create_note
// ---------------------------------------------------------------------------

test('dispatcher: create 成功/标题缺省取首行/正文体积超限 -32602', async () => {
  const f = new Fixture();
  f.grant([McpToolName.CREATE_NOTE], { collectionIds: ['col-1'] });

  const created = unwrapResult(await f.callTool(McpToolName.CREATE_NOTE, {
    title: '新笔记',
    content: '第一行标题\n\n正文',
    collection_ids: ['col-1'],
  })) as { id: string; title: string; revision: number };
  assert.equal(created.title, '新笔记');
  assert.equal(created.revision, 1);
  assert.equal(f.store.contentOf(created.id), '第一行标题\n\n正文');

  const derived = unwrapResult(await f.callTool(McpToolName.CREATE_NOTE, { content: '自动标题行\n内容' })) as { title: string };
  assert.equal(derived.title, '自动标题行');

  const oversize = await f.callToolError(McpToolName.CREATE_NOTE, { content: 'x'.repeat(MAX_NOTE_CONTENT_BYTES + 1) });
  assert.equal(oversize.code, -32602);

  const missingContent = await f.callToolError(McpToolName.CREATE_NOTE, { title: 't' });
  assert.equal(missingContent.code, -32602);
});

test('dispatcher: create collection_ids 越权 → -32002（AccessDenied 经闸门）', async () => {
  const f = new Fixture();
  f.grant([McpToolName.CREATE_NOTE], { collectionIds: ['col-1'] });

  const err = await f.callToolError(McpToolName.CREATE_NOTE, { content: 'x', collection_ids: ['col-2'] });
  assert.equal(err.code, -32002);
  assert.match(err.message, /collection not granted/);
  // 拒绝经 PolicyGate 落审计（AccessDeniedError 原样上抛）
  assert.equal(f.records[f.records.length - 1].result, 'error');
  assert.ok(f.records.some((r) => r.result === 'error' && r.tool === McpToolName.CREATE_NOTE));

  const ok = await f.callTool(McpToolName.CREATE_NOTE, { content: 'x', collection_ids: ['col-1'] });
  assert.equal((unwrapResult(ok) as { id: string }).id.length > 0, true);
});

// ---------------------------------------------------------------------------
// append_to_note
// ---------------------------------------------------------------------------

test('dispatcher: append 幂等键重放不重复追加，冲突返回 current_revision', async () => {
  const f = new Fixture();
  const id = f.store.seed({ title: '追加目标', content: '原始内容', tagIds: ['col-1'] });
  f.grant([McpToolName.APPEND_TO_NOTE], { collectionIds: ['col-1'] });

  const first = unwrapResult(await f.callTool(McpToolName.APPEND_TO_NOTE, {
    note_id: id,
    content: '新增段落',
    idempotency_key: 'req-1',
  })) as { id: string; revision: number };
  assert.equal(first.revision, 2);
  assert.equal(f.store.contentOf(id), '原始内容\n\n新增段落');

  // 同键重放：返回首次结果，不重复追加
  const replay = unwrapResult(await f.callTool(McpToolName.APPEND_TO_NOTE, {
    note_id: id,
    content: '新增段落',
    idempotency_key: 'req-1',
  })) as { revision: number };
  assert.equal(replay.revision, 2);
  assert.equal(f.store.contentOf(id), '原始内容\n\n新增段落', '只追加一次');

  // 不同键正常追加
  const second = unwrapResult(await f.callTool(McpToolName.APPEND_TO_NOTE, {
    note_id: id,
    content: '再来一段',
    idempotency_key: 'req-2',
  })) as { revision: number };
  assert.equal(second.revision, 3);

  // 版本冲突：明确结果，不重试伪装成功
  const conflict = unwrapError(await f.callTool(McpToolName.APPEND_TO_NOTE, {
    note_id: id,
    content: 'x',
    expected_revision: 1,
  }));
  assert.equal(conflict['conflict'], true);
  assert.equal(conflict['current_revision'], 3);

  // 越权/不存在 → not found 口径
  const other = f.store.seed({ title: '别人', content: 'y', tagIds: ['col-2'] });
  const nf = unwrapError(await f.callTool(McpToolName.APPEND_TO_NOTE, { note_id: other, content: 'z' }));
  assert.equal(nf['error'], 'note not found or not accessible');
});

test('dispatcher: append 幂等键 24h 过期后不再重放', async () => {
  const f = new Fixture();
  const id = f.store.seed({ title: 't', content: 'a', tagIds: ['col-1'] });
  f.grant([McpToolName.APPEND_TO_NOTE], { collectionIds: ['col-1'] });

  await f.callTool(McpToolName.APPEND_TO_NOTE, { note_id: id, content: 'b', idempotency_key: 'k' });
  f.clock.advance(24 * 60 * 60 * 1000 + 1);
  const again = unwrapResult(await f.callTool(McpToolName.APPEND_TO_NOTE, { note_id: id, content: 'b', idempotency_key: 'k' })) as { revision: number };
  assert.equal(again.revision, 3, '过期后重新执行');
});

test('dispatcher: append 重放仍经闸门授权（撤销后立即失效）', async () => {
  const f = new Fixture();
  const id = f.store.seed({ title: 't', content: 'a', tagIds: ['col-1'] });
  f.grant([McpToolName.APPEND_TO_NOTE], { collectionIds: ['col-1'] });
  await f.callTool(McpToolName.APPEND_TO_NOTE, { note_id: id, content: 'b', idempotency_key: 'k' });

  f.policy.revoke(CLIENT);
  const err = await f.callToolError(McpToolName.APPEND_TO_NOTE, { note_id: id, content: 'b', idempotency_key: 'k' });
  assert.equal(err.code, -32002);
  assert.equal(f.store.contentOf(id), 'a\n\nb', '重放未旁路授权');
});

// ---------------------------------------------------------------------------
// delete_note
// ---------------------------------------------------------------------------

test('dispatcher: delete 软删除（可恢复口径）+ 版本冲突 + 越权 not found', async () => {
  const f = new Fixture();
  const id = f.store.seed({ title: '待删', content: '内容', tagIds: ['col-1'] });
  const other = f.store.seed({ title: '不可删', content: 'x', tagIds: ['col-2'] });
  f.grant([McpToolName.DELETE_NOTE], { collectionIds: ['col-1'] });

  const nf = unwrapError(await f.callTool(McpToolName.DELETE_NOTE, { note_id: other }));
  assert.equal(nf['error'], 'note not found or not accessible');
  assert.equal(f.store.isDeleted(other), false);

  const conflict = unwrapError(await f.callTool(McpToolName.DELETE_NOTE, { note_id: id, expected_revision: 99 }));
  assert.equal(conflict['conflict'], true);
  assert.equal(conflict['current_revision'], 1);

  const done = unwrapResult(await f.callTool(McpToolName.DELETE_NOTE, { note_id: id, expected_revision: 1 })) as { id: string; deleted: boolean };
  assert.deepEqual(done, { id, deleted: true });
  assert.equal(f.store.isDeleted(id), true, '软删除：记录保留，可恢复');
});

test('dispatcher: 回收站笔记默认不可见（includeTrash 才可见）', async () => {
  const f = new Fixture();
  const trashed = f.store.seed({ title: '已删', content: '回收站内容', tagIds: ['col-1'], deleted: true });
  f.grant([McpToolName.GET_NOTE], { collectionIds: ['col-1'] });
  const nf = unwrapError(await f.callTool(McpToolName.GET_NOTE, { note_id: trashed }));
  assert.equal(nf['error'], 'note not found or not accessible');

  f.policy.grant({ clientId: CLIENT, tools: [McpToolName.GET_NOTE], collectionIds: ['col-1'], includeTrash: true });
  const got = unwrapResult(await f.callTool(McpToolName.GET_NOTE, { note_id: trashed })) as { id: string };
  assert.equal(got.id, trashed);
});

// ---------------------------------------------------------------------------
// list_tags
// ---------------------------------------------------------------------------

test('dispatcher: list_tags 与授权集合求交；空 scope 返回空列表', async () => {
  const f = new Fixture();
  f.grant([McpToolName.LIST_TAGS], { collectionIds: ['col-1', 'col-3'] });
  const listed = unwrapResult(await f.callTool(McpToolName.LIST_TAGS)) as { tags: Array<{ id: string; name: string }> };
  assert.deepEqual(listed.tags, [
    { id: 'col-1', name: '工作' },
    { id: 'col-3', name: '阅读' },
  ]);
  assert.deepEqual(f.records[f.records.length - 1].objectIds, ['col-1', 'col-3']);

  f.policy.grant({ clientId: CLIENT, tools: [McpToolName.LIST_TAGS] });
  const empty = unwrapResult(await f.callTool(McpToolName.LIST_TAGS)) as { tags: unknown[] };
  assert.deepEqual(empty.tags, []);
});

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

test('dispatcher: 每 clientId 滑动窗限流，超限 -32002，窗口滑动后恢复', async () => {
  const f = new Fixture();
  (f.rateLimit as { maxCalls: number }).maxCalls = 2;
  const id = f.store.seed({ title: 't', content: 'c', tagIds: [] });
  f.grant([McpToolName.GET_NOTE], { noteIds: [id] });

  await f.callTool(McpToolName.GET_NOTE, { note_id: id });
  await f.callTool(McpToolName.GET_NOTE, { note_id: id });
  const err = await f.callToolError(McpToolName.GET_NOTE, { note_id: id });
  assert.equal(err.code, -32002);
  assert.match(err.message, /rate limit exceeded/);

  // 另一 clientId 有独立窗口，不受影响
  f.policy.grant({ clientId: OTHER, tools: [McpToolName.GET_NOTE], noteIds: [id] });
  const otherOk = await f.callTool(McpToolName.GET_NOTE, { note_id: id }, OTHER);
  assert.equal((unwrapResult(otherOk) as { id: string }).id, id);

  // 窗口滑动后恢复（60s 窗，越界即清）
  f.clock.advance(60_001);
  const again = await f.callTool(McpToolName.GET_NOTE, { note_id: id });
  assert.equal((unwrapResult(again) as { id: string }).id, id);
});

// ---------------------------------------------------------------------------
// 三态审计
// ---------------------------------------------------------------------------

test('dispatcher: 工具执行异常 → 原样上抛且审计 error', async () => {
  const f = new Fixture();
  const boom = new Error('disk io');
  const failing: NoteStoreLike = {
    search: async () => [],
    getById: async () => {
      throw boom;
    },
    create: async () => {
      throw boom;
    },
    append: async () => {
      throw boom;
    },
    remove: async () => {
      throw boom;
    },
    listTags: async () => [],
  };
  const dispatcher = new ClipNoteMcpDispatcher(f.gate, failing, f.clock, f.rateLimit);
  f.grant([McpToolName.GET_NOTE], { noteIds: ['x'] });

  await assert.rejects(
    () => dispatcher.dispatch(SESSION, 'tools/call', { name: McpToolName.GET_NOTE, arguments: { note_id: 'x' } }, CLIENT_CTX),
    (err: unknown) => err === boom,
  );
  assert.equal(f.records[f.records.length - 1].result, 'error');
  assert.equal(f.records[f.records.length - 1].tool, McpToolName.GET_NOTE);
});

test('dispatcher: 成功调用审计 ok 带 objectIds，denied 带 denyReason 轨迹', async () => {
  const f = new Fixture();
  const id = f.store.seed({ title: 't', content: 'c', tagIds: ['col-1'] });
  f.grant([McpToolName.GET_NOTE, McpToolName.DELETE_NOTE], { collectionIds: ['col-1'] });

  await f.callTool(McpToolName.GET_NOTE, { note_id: id });
  // 版本冲突是工具语义错误（isError 结果），不是传输错误，审计仍为 ok
  const conflictRes = unwrapError(await f.callTool(McpToolName.DELETE_NOTE, { note_id: id, expected_revision: 99 }));
  assert.equal(conflictRes['conflict'], true);
  await f.callToolError(McpToolName.GET_NOTE, { note_id: id }, OTHER);

  const results = f.records.map((r) => r.result);
  assert.deepEqual(results, ['ok', 'ok', 'denied']);
  assert.deepEqual(f.records[0].objectIds, [id]);
  assert.equal(f.records[1].objectIds.length, 0, 'isError 结果未触及对象');
});

// ---------------------------------------------------------------------------
// utf8ByteLength
// ---------------------------------------------------------------------------

test('dispatcher: utf8ByteLength 与 TextEncoder 一致', () => {
  const encoder = new TextEncoder();
  for (const s of ['', 'abc', '中文', '🙂', 'a中🙂b', '\u{1F600}'.repeat(3)]) {
    assert.equal(utf8ByteLength(s), encoder.encode(s).length);
  }
});
