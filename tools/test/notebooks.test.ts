/**
 * NotebookService（V5 / Feature 1）本机用例。
 *
 * 覆盖：
 *  1. 默认笔记本随库走：迁移产出 nb-default，setDefault 恰一行 is_default=1；
 *  2. CRUD 与删除保护：内置拒删、当前默认拒删、非空（含软删条目）拒删；
 *  3. NoteRepository 接线：create 缺省落当前默认、listRecent 按笔记本过滤、countByNotebook。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { NotebookService, NotebookView } from '../../common/src/main/ets/core/notebooks';
import { DEFAULT_NOTEBOOK_ID, NoteSource } from '../../common/src/main/ets/core/model';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import { CapturingLogger, FixedClock, SequentialRandom } from './support/platform';

const BASE_MS = 1759000000000;

interface Fixture {
  db: NodeSqliteExecutor;
  notes: NoteRepository;
  svc: NotebookService;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const rand = new SequentialRandom();
  const clock = new FixedClock(BASE_MS);
  const notes = new NoteRepository({ db, clock, random: rand, logger });
  const svc = new NotebookService({ db, notes, clock, random: rand, logger });
  return { db, notes, svc };
}

test('迁移后即存在内置默认笔记本；list 附带条目数', async () => {
  const f = await makeFixture();
  const list: NotebookView[] = await f.svc.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].notebook.id, DEFAULT_NOTEBOOK_ID);
  assert.equal(list[0].notebook.builtIn, true);
  assert.equal(list[0].notebook.isDefault, true);
  assert.equal(list[0].noteCount, 0);

  const def = await f.svc.getDefault();
  assert.equal(def.id, DEFAULT_NOTEBOOK_ID);
});

test('create/rename：空名与重名如实拒绝', async () => {
  const f = await makeFixture();
  const nb = await f.svc.create('工作');
  assert.equal(nb.name, '工作');
  assert.equal(nb.builtIn, false);
  assert.equal(nb.isDefault, false);

  await assert.rejects(() => f.svc.create('工作'), /already exists/);
  await assert.rejects(() => f.svc.create('  '), /empty/);
  await assert.rejects(() => f.svc.rename(nb.id, '默认笔记本'), /already exists/);
  await assert.rejects(() => f.svc.rename(nb.id, ' '), /empty/);

  const renamed = await f.svc.rename(nb.id, '学习');
  assert.equal(renamed.name, '学习');
  assert.equal((await f.svc.list()).length, 2);
});

test('setDefault：恰一行 is_default=1，新建笔记落当前默认', async () => {
  const f = await makeFixture();
  // 未指定笔记本时落 nb-default
  const n1 = await f.notes.create({ title: 'a', contentMd: 'a', source: NoteSource.MANUAL });
  assert.equal(n1.notebookId, DEFAULT_NOTEBOOK_ID);

  const work = await f.svc.create('工作');
  await f.svc.setDefault(work.id);
  assert.equal((await f.svc.getDefault()).id, work.id);
  const all = await f.svc.list();
  assert.equal(all.filter((v) => v.notebook.isDefault).length, 1);

  // 换默认后新笔记落新默认；显式指定笔记本优先
  const n2 = await f.notes.create({ title: 'b', contentMd: 'b', source: NoteSource.MANUAL });
  assert.equal(n2.notebookId, work.id);
  const n3 = await f.notes.create({
    title: 'c', contentMd: 'c', source: NoteSource.MANUAL, notebookId: DEFAULT_NOTEBOOK_ID,
  });
  assert.equal(n3.notebookId, DEFAULT_NOTEBOOK_ID);
});

test('listRecent 按笔记本过滤；countByNotebook 含软删条目', async () => {
  const f = await makeFixture();
  const work = await f.svc.create('工作');
  await f.notes.create({ title: 'a1', contentMd: 'a1', source: NoteSource.MANUAL });
  const w1 = await f.notes.create({
    title: 'w1', contentMd: 'w1', source: NoteSource.MANUAL, notebookId: work.id,
  });
  const w2 = await f.notes.create({
    title: 'w2', contentMd: 'w2', source: NoteSource.MANUAL, notebookId: work.id,
  });
  await f.notes.softDelete(w2.id);

  const all = await f.notes.listRecent(50);
  assert.equal(all.length, 2); // w2 软删不出现在活体列表
  const inWork = await f.notes.listRecent(50, undefined, work.id);
  assert.equal(inWork.length, 1);
  assert.equal(inWork[0].id, w1.id);
  const inDefault = await f.notes.listRecent(50, undefined, DEFAULT_NOTEBOOK_ID);
  assert.equal(inDefault.length, 1);

  // 删除保护计数含软删
  assert.equal(await f.notes.countByNotebook(work.id), 2);
});

test('delete 保护：内置拒删、当前默认拒删、非空（含软删）拒删、空壳可删', async () => {
  const f = await makeFixture();
  await assert.rejects(() => f.svc.delete(DEFAULT_NOTEBOOK_ID), /built-in/);

  const work = await f.svc.create('工作');
  await f.svc.setDefault(work.id);
  await assert.rejects(() => f.svc.delete(work.id), /default/);
  await f.svc.setDefault(DEFAULT_NOTEBOOK_ID);

  const w1 = await f.notes.create({
    title: 'w1', contentMd: 'w1', source: NoteSource.MANUAL, notebookId: work.id,
  });
  await assert.rejects(() => f.svc.delete(work.id), /not empty/);
  // 软删后仍算非空（垃圾桶条目也阻止删除，防误丢）
  await f.notes.softDelete(w1.id);
  await assert.rejects(() => f.svc.delete(work.id), /not empty/);
  // 物理清掉后可删
  await f.notes.purge(w1.id);
  await f.svc.delete(work.id);
  assert.equal((await f.svc.list()).length, 1);
});
