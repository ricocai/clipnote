import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import {
  NOTE_DEDUPE_INTERVAL_MS,
  NoteDedupeService,
} from '../../common/src/main/ets/core/note-dedupe';
import { NoteSource, PERSISTED_DEDUPE_WINDOW_MS } from '../../common/src/main/ets/core/model';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import { CapturingLogger, FixedClock, SequentialRandom } from './support/platform';

const BASE_MS = 1759000000000;

interface Fixture {
  clock: FixedClock;
  notes: NoteRepository;
  svc: NoteDedupeService;
  logger: CapturingLogger;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const notes = new NoteRepository({ db, clock, random: new SequentialRandom(), logger });
  const svc = new NoteDedupeService({ notes, clock, logger });
  return { clock, notes, svc, logger };
}

async function seed(f: Fixture, contentMd: string, pinned: boolean = false): Promise<string> {
  const note = await f.notes.create({ title: contentMd.slice(0, 8), contentMd, source: NoteSource.MANUAL });
  if (pinned) {
    await f.notes.setPinned(note.id, true);
  }
  return note.id;
}

test('Q4 周期清理：2 日窗口内同正文组保留最早一篇，其余软删进回收站', async () => {
  const f = await makeFixture();
  const keep = await seed(f, '重复的正文');
  f.clock.advance(60_000);
  const dup1 = await seed(f, '重复的正文');
  f.clock.advance(60_000);
  const dup2 = await seed(f, '重复的正文');
  await seed(f, '不重复的正文');

  const report = await f.svc.run(PERSISTED_DEDUPE_WINDOW_MS, true);
  assert.equal(report.skipped, false);
  assert.equal(report.scanned, 4);
  assert.equal(report.duplicateGroups, 1);
  assert.equal(report.trashed, 2);

  assert.ok((await f.notes.getById(keep)) !== undefined, '最早一篇保留');
  assert.equal(await f.notes.getById(dup1), undefined, '重复件已软删（默认查询不可见）');
  assert.equal(await f.notes.getById(dup2), undefined);
  // 软删而非物理删除：回收站可找回
  assert.ok((await f.notes.getById(dup1, true))?.deletedAtMs !== undefined);
  assert.equal((await f.notes.listRecent(10)).length, 2);
  assert.ok(f.logger.has('note_dedupe_cleanup'));
});

test('Q4 周期清理：组内有置顶件时保留置顶件（其余含更早的非置顶件也软删）', async () => {
  const f = await makeFixture();
  const early = await seed(f, '置顶优先的内容');
  f.clock.advance(60_000);
  const pinned = await seed(f, '置顶优先的内容', true);

  const report = await f.svc.run(PERSISTED_DEDUPE_WINDOW_MS, true);
  assert.equal(report.trashed, 1);
  assert.equal(await f.notes.getById(early), undefined, '非置顶的更早件让位');
  assert.ok((await f.notes.getById(pinned)) !== undefined, '置顶件保留');
});

test('Q4 周期清理：窗口外（>2 日）的笔记不参与清理', async () => {
  const f = await makeFixture();
  const old = await seed(f, '跨越窗口的内容');
  f.clock.advance(3 * 24 * 60 * 60 * 1000); // 3 天后再存一篇同内容
  const recent = await seed(f, '跨越窗口的内容');

  const report = await f.svc.run(PERSISTED_DEDUPE_WINDOW_MS, true);
  assert.equal(report.duplicateGroups, 0);
  assert.equal(report.trashed, 0);
  assert.ok((await f.notes.getById(old)) !== undefined);
  assert.ok((await f.notes.getById(recent)) !== undefined);
});

test('Q4 周期清理：6h 节流——非 force 运行间隔不足即跳过，force 忽略节流', async () => {
  const f = await makeFixture();
  await seed(f, 'x');
  const first = await f.svc.run(PERSISTED_DEDUPE_WINDOW_MS, true);
  assert.equal(first.skipped, false);

  // 1 小时后非 force：跳过
  f.clock.advance(60 * 60 * 1000);
  const throttled = await f.svc.run(PERSISTED_DEDUPE_WINDOW_MS, false);
  assert.equal(throttled.skipped, true);
  assert.equal(throttled.scanned, 0);

  // 越过 6h：正常运行
  f.clock.advance(NOTE_DEDUPE_INTERVAL_MS);
  const after = await f.svc.run(PERSISTED_DEDUPE_WINDOW_MS, false);
  assert.equal(after.skipped, false);
});
