/**
 * S6-1 用例：AccessPolicy 服务端强制 + 审计落库（设计 §4.5.5）。
 *
 * 覆盖：
 *  - 默认拒绝（无授权、工具未授权）；
 *  - 越权参数（范围外对象、收件箱/回收站默认排除、条数/片段限量收敛）；
 *  - 重放（撤销/收窄授权后，旧授权决定重放即拒 —— 即时生效）；
 *  - PolicyGate 三态审计（denied/error/ok）与审计落库 round-trip（只记元数据）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AccessDeniedError,
  AccessPolicy,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_SNIPPET_CHARS,
  HARD_MAX_RESULTS,
  McpAuditRecord,
  McpAuditStoreSink,
  McpToolName,
  PolicyGate,
  ScopeObject,
  ToolAuthorization,
  ToolInvocation,
  clampMaxResults,
  clampSnippet,
  isObjectInScope,
} from '../../mcp/src/main/ets/core/access-policy';
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  McpAuditRepository,
} from '../../common/src/main/ets/core/data/mcp-audit-repository';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { DB_SCHEMA_VERSION } from '../../common/src/main/ets/core/data/schema';
import { FixedClock, CapturingLogger } from './support/platform';
import { NodeSqliteExecutor } from './support/sqlite-executor';

const CLIENT = 'client-A';
const OTHER = 'client-B';

class Fixture {
  readonly clock = new FixedClock(1_700_000_000_000);
  readonly logger = new CapturingLogger();
  readonly policy = new AccessPolicy(this.clock);
  readonly records: McpAuditRecord[] = [];
  readonly memorySink = {
    append: async (r: McpAuditRecord): Promise<void> => {
      this.records.push(r);
    },
  };
  readonly gate = new PolicyGate(this.policy, this.memorySink, this.clock);

  grantFull(): void {
    this.policy.grant({
      clientId: CLIENT,
      tools: [McpToolName.SEARCH_NOTES, McpToolName.GET_NOTE],
      collectionIds: ['col-1'],
      noteIds: ['note-explicit'],
      maxResults: 5,
      maxSnippetChars: 10,
    });
  }
}

// ---------------------------------------------------------------------------
// 默认拒绝
// ---------------------------------------------------------------------------

test('policy: 未授权客户端一律拒绝（默认拒绝）', () => {
  const f = new Fixture();
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.SEARCH_NOTES);
  assert.equal(auth.allowed, false);
  assert.equal(auth.denyReason, 'no grant for client');
});

test('policy: 已授权客户端调用未列出工具仍拒绝', () => {
  const f = new Fixture();
  f.grantFull();
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.DELETE_NOTE);
  assert.equal(auth.allowed, false);
  assert.equal(auth.denyReason, 'tool not granted');
});

test('policy: 授权后按清单放行并带限量', () => {
  const f = new Fixture();
  f.grantFull();
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(auth.allowed, true);
  assert.equal(auth.maxResults, 5);
  assert.equal(auth.maxSnippetChars, 10);
  assert.deepEqual(auth.scope.collectionIds, ['col-1']);
  assert.equal(auth.scope.includeInbox, false);
  assert.equal(auth.scope.includeTrash, false);
});

test('policy: 限量护栏 —— grant 也不能突破硬上限，负数归零', () => {
  const f = new Fixture();
  const g = f.policy.grant({
    clientId: CLIENT,
    tools: [McpToolName.SEARCH_NOTES],
    maxResults: 99999,
    maxSnippetChars: -3,
  });
  assert.equal(g.maxResults, HARD_MAX_RESULTS);
  assert.equal(g.maxSnippetChars, 0);
});

// ---------------------------------------------------------------------------
// 越权参数（范围谓词与限量收敛）
// ---------------------------------------------------------------------------

function obj(id: string, collections: string[], inInbox = false, inTrash = false): ScopeObject {
  return { id, collectionIds: collections, inInbox, inTrash };
}

test('scope: 集合外交集为空的对象不可见；显式 noteId 与授权集合内对象可见', () => {
  const f = new Fixture();
  f.grantFull();
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(auth, obj('n1', ['col-1'])), true);
  assert.equal(isObjectInScope(auth, obj('note-explicit', [])), true);
  assert.equal(isObjectInScope(auth, obj('n2', ['col-2'])), false);
  assert.equal(isObjectInScope(auth, obj('n3', [])), false);
});

test('scope: 收件箱与回收站默认排除，显式打开后才可见', () => {
  const f = new Fixture();
  f.grantFull();
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(auth, obj('n1', ['col-1'], true)), false);
  assert.equal(isObjectInScope(auth, obj('n1', ['col-1'], false, true)), false);

  f.policy.grant({
    clientId: CLIENT,
    tools: [McpToolName.GET_NOTE],
    noteIds: ['in-inbox', 'in-trash'],
    includeInbox: true,
    includeTrash: true,
  });
  const opened: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(opened, obj('in-inbox', [], true)), true);
  assert.equal(isObjectInScope(opened, obj('in-trash', [], false, true)), true);
});

test('scope: 拒绝决定下一切皆不可见（谓词不旁路授权）', () => {
  const f = new Fixture();
  const deniedAuth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(deniedAuth, obj('note-explicit', ['col-1'])), false);
});

test('scope: 空授权集合只能访问显式授权对象（冻结语义）', () => {
  const f = new Fixture();
  f.policy.grant({ clientId: CLIENT, tools: [McpToolName.GET_NOTE] });
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(auth, obj('n1', ['col-1'])), false);
});

test('clamp: 条数与片段长度收敛到授权上限', () => {
  const f = new Fixture();
  f.grantFull();
  const auth: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.SEARCH_NOTES);
  assert.equal(clampMaxResults(auth, 100), 5);
  assert.equal(clampMaxResults(auth, 3), 3);
  assert.equal(clampMaxResults(auth, undefined), 5);
  assert.equal(clampMaxResults(auth, 0), 5);
  assert.equal(clampSnippet(auth, '一二三四五六七八九十甲乙丙'), '一二三四五六七八九十');

  const noLimits: ToolAuthorization = {
    tool: McpToolName.SEARCH_NOTES,
    allowed: true,
    scope: { collectionIds: [], noteIds: [], includeInbox: false, includeTrash: false },
  };
  assert.equal(clampMaxResults(noLimits, undefined), DEFAULT_MAX_RESULTS);
  assert.equal(clampSnippet(noLimits, 'x'.repeat(DEFAULT_MAX_SNIPPET_CHARS + 1)).length, DEFAULT_MAX_SNIPPET_CHARS);
});

// ---------------------------------------------------------------------------
// 重放：授权变更即时生效
// ---------------------------------------------------------------------------

test('replay: 撤销授权后重放同一调用即拒（旧授权决定不得复用）', async () => {
  const f = new Fixture();
  f.grantFull();
  const run = (auth: ToolAuthorization): Promise<ToolInvocation<string>> =>
    Promise.resolve({ result: 'ok', objectIds: ['note-explicit'] });

  const first: string = await f.gate.execute(CLIENT, McpToolName.GET_NOTE, 64, run);
  assert.equal(first, 'ok');

  f.policy.revoke(CLIENT);
  await assert.rejects(
    () => f.gate.execute(CLIENT, McpToolName.GET_NOTE, 64, run),
    (err: unknown) => err instanceof AccessDeniedError,
  );

  // 审计留下"先放行后拒绝"的完整轨迹
  assert.deepEqual(
    f.records.map((r: McpAuditRecord) => r.result),
    ['ok', 'denied'],
  );
});

test('replay: 收窄授权后旧范围对象立即不可见', () => {
  const f = new Fixture();
  f.grantFull();
  const before: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(before, obj('n1', ['col-1'])), true);

  // 收窄：集合授权移除，仅保留显式对象
  f.policy.grant({ clientId: CLIENT, tools: [McpToolName.GET_NOTE], noteIds: ['note-explicit'] });
  const after: ToolAuthorization = f.policy.authorize(CLIENT, McpToolName.GET_NOTE);
  assert.equal(isObjectInScope(after, obj('n1', ['col-1'])), false);
  assert.equal(isObjectInScope(after, obj('note-explicit', [])), true);
});

// ---------------------------------------------------------------------------
// PolicyGate 三态审计
// ---------------------------------------------------------------------------

test('gate: 拒绝/异常/成功三态都落审计，且只记元数据', async () => {
  const f = new Fixture();
  f.grantFull();

  // denied：工具未授权
  await assert.rejects(
    () => f.gate.execute(CLIENT, McpToolName.DELETE_NOTE, 32, () => Promise.reject(new Error('unreachable'))),
    (err: unknown) => err instanceof AccessDeniedError,
  );
  // error：工具执行抛错
  await assert.rejects(() =>
    f.gate.execute(CLIENT, McpToolName.GET_NOTE, 48, () => Promise.reject(new Error('disk io'))),
  );
  // ok：成功并自报触及对象
  const value: string = await f.gate.execute(CLIENT, McpToolName.GET_NOTE, 55, () =>
    Promise.resolve({ result: '正文内容', objectIds: ['note-explicit'] }),
  );
  assert.equal(value, '正文内容');

  assert.equal(f.records.length, 3);
  const [deniedRec, errorRec, okRec] = f.records;
  assert.equal(deniedRec.result, 'denied');
  assert.equal(deniedRec.tool, McpToolName.DELETE_NOTE);
  assert.equal(deniedRec.payloadBytes, 32);
  assert.deepEqual(deniedRec.objectIds, []);
  assert.equal(errorRec.result, 'error');
  assert.equal(okRec.result, 'ok');
  assert.deepEqual(okRec.objectIds, ['note-explicit']);
  assert.equal(okRec.atMs, 1_700_000_000_000);
  // 审计记录不含正文：结果值"正文内容"不出现在任何字段
  for (const r of f.records) {
    assert.equal(JSON.stringify(r).includes('正文内容'), false);
  }
});

// ---------------------------------------------------------------------------
// 审计落库（schema v2 + McpAuditRepository round-trip）
// ---------------------------------------------------------------------------

async function openAuditRepo(): Promise<{ db: NodeSqliteExecutor; repo: McpAuditRepository }> {
  const db = NodeSqliteExecutor.openMemory();
  await new SchemaMigrator(db, new CapturingLogger()).migrate();
  return { db, repo: new McpAuditRepository(db) };
}

test('audit: schema v3 建立 mcp_audit 表并随迁移链路到达最新版本', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const version: number = await new SchemaMigrator(db, new CapturingLogger()).migrate();
  assert.equal(version, DB_SCHEMA_VERSION);
  // V3 = mcp_audit（S6-1）；V4 = export_record（S4-2）；V5 = notebook —— 版本钉随迁移链路前移
  assert.equal(DB_SCHEMA_VERSION, 5);
  const tables = await db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_audit'`);
  assert.equal(tables.length, 1);
  const idx = await db.query(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_mcp_audit_at', 'idx_mcp_audit_client')`,
  );
  assert.equal(idx.length, 2);
  db.close();
});

test('audit: 闸门审计经 sink 落库，可按客户端/工具/结果/时间过滤查询', async () => {
  const { db, repo } = await openAuditRepo();
  const clock = new FixedClock(1_700_000_000_000);
  const policy = new AccessPolicy(clock);
  const gate = new PolicyGate(policy, new McpAuditStoreSink(repo), clock);

  policy.grant({ clientId: CLIENT, tools: [McpToolName.SEARCH_NOTES] });
  await gate.execute(CLIENT, McpToolName.SEARCH_NOTES, 120, () =>
    Promise.resolve({ result: ['n1'], objectIds: ['n1'] }),
  );
  clock.advance(1000);
  await assert.rejects(() =>
    gate.execute(CLIENT, McpToolName.DELETE_NOTE, 40, () => Promise.resolve({ result: 0, objectIds: [] })),
  );
  clock.advance(1000);
  await gate.execute(OTHER, McpToolName.SEARCH_NOTES, 66, () =>
    Promise.resolve({ result: [], objectIds: [] }),
  ).then(
    () => assert.fail('OTHER 无授权应被拒绝'),
    (err: unknown) => assert.ok(err instanceof AccessDeniedError),
  );

  const all = await repo.query({});
  assert.equal(all.length, 3);
  // 倒序：最新在前
  assert.equal(all[0].clientId, OTHER);
  assert.equal(all[0].result, 'denied');
  assert.equal(all[1].tool, McpToolName.DELETE_NOTE);
  assert.equal(all[2].result, 'ok');
  assert.deepEqual(all[2].objectIds, ['n1']);
  assert.equal(all[2].payloadBytes, 120);

  assert.equal((await repo.query({ clientId: CLIENT })).length, 2);
  assert.equal((await repo.query({ result: 'denied' })).length, 2);
  assert.equal((await repo.query({ tool: McpToolName.SEARCH_NOTES })).length, 2);
  assert.equal((await repo.query({ sinceMs: 1_700_000_001_000 })).length, 2);
  assert.equal(await repo.count({}), 3);
  assert.equal(await repo.count({ result: 'ok' }), 1);
  db.close();
});

test('audit: 查询 limit 收敛（缺省默认、超限硬上限、非法值回默认）', async () => {
  const { db, repo } = await openAuditRepo();
  for (let i: number = 0; i < 5; i++) {
    await repo.append(CLIENT, 'search_notes', [], 'ok', 1000 + i, 1);
  }
  assert.equal((await repo.query({})).length, 5);
  assert.equal((await repo.query({ limit: 2 })).length, 2);
  assert.equal((await repo.query({ limit: 0 })).length, 5);
  assert.equal((await repo.query({ limit: MAX_QUERY_LIMIT + 500 })).length, 5);
  assert.ok(DEFAULT_QUERY_LIMIT <= MAX_QUERY_LIMIT);
  db.close();
});
