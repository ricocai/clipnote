import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { InboxRepository } from '../../common/src/main/ets/core/data/inbox-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { transact } from '../../common/src/main/ets/core/data/rdb';
import { blobRelativePath } from '../../common/src/main/ets/core/blob-cas';
import {
  AttachmentRole,
  BlobStatus,
  ClipEntry,
  ClipKind,
  ClipboardItem,
  InboxState,
  NoteSource,
  Sensitivity,
} from '../../common/src/main/ets/core/model';
import { uuidv7 } from '../../common/src/main/ets/core/id';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import { CapturingLogger, FixedClock, SequentialRandom } from './support/platform';

const BASE_MS = 1759000000000;

interface Fixture {
  db: NodeSqliteExecutor;
  clock: FixedClock;
  notes: NoteRepository;
  inbox: InboxRepository;
  blobs: BlobRepository;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const rand = new SequentialRandom();
  return {
    db,
    clock,
    notes: new NoteRepository({ db, clock, random: rand, logger }),
    inbox: new InboxRepository({ db, logger }),
    blobs: new BlobRepository({ db, logger }),
  };
}

function makeItem(id: string, overrides?: Partial<ClipboardItem>): ClipboardItem {
  return {
    id,
    kind: ClipKind.TEXT,
    rawText: '内容',
    sha256: 'a'.repeat(64),
    capturedAtMs: BASE_MS,
    expiresAtMs: BASE_MS + 7 * 24 * 60 * 60 * 1000,
    sensitivity: Sensitivity.NONE,
    state: InboxState.PENDING,
    entry: ClipEntry.FOREGROUND_WATCH,
    truncated: false,
    originalByteLength: 6,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NoteRepository
// ---------------------------------------------------------------------------

test('NoteRepository: 创建/读取/更新正文，revision 递增', async () => {
  const { notes, clock } = await makeFixture();

  const note = await notes.create({ title: '第一篇', contentMd: '# 你好', source: NoteSource.MANUAL });
  assert.equal(note.revision, 1);
  assert.equal(note.contentType, 'text/markdown');

  const loaded = await notes.getById(note.id);
  assert.equal(loaded?.contentMd, '# 你好');
  assert.equal(loaded?.source, NoteSource.MANUAL);

  clock.advance(1000);
  const updated = await notes.updateContent(note.id, '# 你好\n\n补充');
  assert.equal(updated.revision, 2);
  assert.equal(updated.contentMd, '# 你好\n\n补充');
  assert.ok(updated.updatedAtMs > note.createdAtMs);

  const renamed = await notes.rename(note.id, '改名');
  assert.equal(renamed.revision, 3);
  assert.equal(renamed.title, '改名');
});

test('NoteRepository: 软删除进回收站，列表排除，可恢复', async () => {
  const { notes } = await makeFixture();
  const a = await notes.create({ title: 'a', contentMd: 'a', source: NoteSource.MANUAL });
  const b = await notes.create({ title: 'b', contentMd: 'b', source: NoteSource.SHARE });

  await notes.softDelete(a.id);

  const recent = await notes.listRecent(10);
  assert.deepEqual(recent.map((n) => n.id), [b.id]);
  assert.equal(await notes.getById(a.id), undefined);
  assert.notEqual(await notes.getById(a.id, true), undefined);

  const deleted = await notes.listDeleted(10);
  assert.deepEqual(deleted.map((n) => n.id), [a.id]);

  const restored = await notes.restore(a.id);
  assert.equal(restored.deletedAtMs, undefined);
  assert.deepEqual((await notes.listRecent(10)).map((n) => n.id).sort(), [a.id, b.id].sort());
});

test('NoteRepository: 标签绑定幂等、解绑、跨笔记共享', async () => {
  const { notes } = await makeFixture();
  const a = await notes.create({ title: 'a', contentMd: 'a', source: NoteSource.MANUAL });
  const b = await notes.create({ title: 'b', contentMd: 'b', source: NoteSource.MANUAL });

  const tag1 = await notes.addTag(a.id, '阅读');
  const tag2 = await notes.addTag(a.id, '阅读');
  const tag3 = await notes.addTag(b.id, '阅读');
  assert.equal(tag1.id, tag2.id);
  assert.equal(tag1.id, tag3.id);
  assert.equal((await notes.listAllTags()).length, 1);

  assert.deepEqual((await notes.listTagsOfNote(a.id)).map((t) => t.name), ['阅读']);
  await notes.removeTag(a.id, '阅读');
  assert.equal((await notes.listTagsOfNote(a.id)).length, 0);
  assert.deepEqual((await notes.listTagsOfNote(b.id)).map((t) => t.name), ['阅读']);

  await assert.rejects(() => notes.addTag(a.id, '   '), /empty tag name/);
});

// ---------------------------------------------------------------------------
// 事务
// ---------------------------------------------------------------------------

test('事务: 中途失败整体回滚（多写原子性）', async () => {
  const { notes, blobs, db } = await makeFixture();
  const note = await notes.create({ title: 't', contentMd: 'v1', source: NoteSource.MANUAL });
  const sha = 'b'.repeat(64);
  await blobs.saveRecord({
    sha256: sha,
    relativePath: blobRelativePath(sha),
    mime: 'image/png',
    size: 1,
    status: BlobStatus.ORPHAN_GRACE,
  });

  await assert.rejects(
    transact(db, async () => {
      await notes.updateContent(note.id, 'v2');
      await blobs.attach(note.id, sha, AttachmentRole.INLINE_IMAGE, 0);
      throw new Error('boom: 模拟引用提交前崩溃');
    }),
    /boom/,
  );

  // 两处写入都不可见：正文仍是 v1，附件引用未生效
  const after = await notes.getById(note.id);
  assert.equal(after?.contentMd, 'v1');
  assert.equal(after?.revision, 1);
  assert.equal((await blobs.listAttachmentsOf(note.id)).length, 0);
  assert.deepEqual(await blobs.listReferencedShas(), []);

  // 回滚后库仍可用
  const committed = await transact(db, async () => {
    await notes.updateContent(note.id, 'v2');
    await blobs.attach(note.id, sha, AttachmentRole.INLINE_IMAGE, 0);
    return notes.getById(note.id);
  });
  assert.equal(committed?.contentMd, 'v2');
  assert.deepEqual(await blobs.listReferencedShas(), [sha]);
});

// ---------------------------------------------------------------------------
// InboxRepository
// ---------------------------------------------------------------------------

test('InboxRepository: 写入/读取/状态迁移/保留期清理/一键清空', async () => {
  const { inbox } = await makeFixture();
  const rand = new SequentialRandom();
  const clock = new FixedClock(BASE_MS);
  const idOf = () => uuidv7(clock, rand);

  const item1 = makeItem(idOf());
  const item2 = makeItem(idOf(), { state: InboxState.AWAITING_CONFIRM, sensitivity: Sensitivity.SUSPECTED });
  const expired = makeItem(idOf(), { expiresAtMs: BASE_MS - 1 });
  await inbox.save(item1);
  await inbox.save(item2);
  await inbox.save(expired);

  const loaded = await inbox.getById(item1.id);
  assert.equal(loaded?.rawText, '内容');
  assert.equal(loaded?.entry, ClipEntry.FOREGROUND_WATCH);
  assert.equal(loaded?.originApp, undefined);

  assert.equal(await inbox.countByState(InboxState.PENDING), 2);
  assert.equal(await inbox.updateState(item1.id, InboxState.ACCEPTED), true);
  assert.equal((await inbox.getById(item1.id))?.state, InboxState.ACCEPTED);
  assert.equal(await inbox.updateState('no-such-id', InboxState.DISCARDED), false);

  assert.equal(await inbox.purgeExpired(BASE_MS), 1);
  assert.equal(await inbox.getById(expired.id), undefined);

  assert.equal(await inbox.clearAll(), 2);
  assert.equal(await inbox.countByState(InboxState.AWAITING_CONFIRM), 0);
});

// ---------------------------------------------------------------------------
// BlobRepository
// ---------------------------------------------------------------------------

test('BlobRepository: 登记/引用/解除引用/GC 安全网', async () => {
  const { notes, blobs } = await makeFixture();
  const note = await notes.create({ title: 't', contentMd: 't', source: NoteSource.MANUAL });
  const sha = 'c'.repeat(64);
  await blobs.saveRecord({
    sha256: sha,
    relativePath: blobRelativePath(sha),
    mime: 'image/png',
    size: 10,
    status: BlobStatus.ORPHAN_GRACE,
  });

  // 引用前：无引用集合为空，记录已在宽限期
  assert.deepEqual(await blobs.listReferencedShas(), []);

  await blobs.attach(note.id, sha, AttachmentRole.INLINE_IMAGE, 0);
  assert.deepEqual(await blobs.listReferencedShas(), [sha]);
  assert.equal((await blobs.get(sha))?.status, BlobStatus.REFERENCED);
  assert.deepEqual(await blobs.listAttachmentNotesOf(sha), [note.id]);

  // 宽限期内的 GC 安全网：referenced 状态拒绝删除
  assert.equal(await blobs.deleteIfOrphan(sha), false);

  await blobs.detach(note.id, sha, AttachmentRole.INLINE_IMAGE);
  assert.equal((await blobs.get(sha))?.status, BlobStatus.ORPHAN_GRACE);
  assert.deepEqual(await blobs.listReferencedShas(), []);

  // 现在允许删除记录（文件本体的回收由 BlobCas.collectGarbage 另行执行）
  assert.equal(await blobs.deleteIfOrphan(sha), true);
  assert.equal(await blobs.get(sha), undefined);
});

test('BlobRepository: 外键拒绝悬空引用', async () => {
  const { blobs } = await makeFixture();
  await assert.rejects(() =>
    blobs.attach('no-such-note', 'd'.repeat(64), AttachmentRole.FILE, 0),
  );
});
