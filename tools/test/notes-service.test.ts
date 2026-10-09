/**
 * NoteService（S3-1）本机用例。
 *
 * 覆盖三组纪律：
 *  1. 修订语义：一次保存 = 一次 revision 递增（设计 §4.8）；
 *  2. 回收站语义：删除是软删除，列表排除、可恢复（设计 §4.2 删除协议）；
 *  3. 附件写入顺序：文件先落地、引用后提交 —— 写文件失败时**绝不**留下
 *     "DB 已提交引用、文件却不存在"的悬空引用（设计 §4.2，G5 阻断项）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { SearchRepository } from '../../common/src/main/ets/core/data/search-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { NoteService } from '../../common/src/main/ets/core/notes';
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENTS_PER_NOTE } from '../../common/src/main/ets/core/notes';
import { BlobCas, blobRelativePath } from '../../common/src/main/ets/core/blob-cas';
import { AttachmentRole, BlobStatus } from '../../common/src/main/ets/core/model';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import {
  CapturingLogger,
  FixedClock,
  MemoryFileStore,
  NodeHasher,
  SequentialRandom,
} from './support/platform';

const BASE_MS = 1759000000000;

interface Fixture {
  db: NodeSqliteExecutor;
  clock: FixedClock;
  fs: MemoryFileStore;
  notes: NoteRepository;
  blobs: BlobRepository;
  svc: NoteService;
  logger: CapturingLogger;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const rand = new SequentialRandom();
  const fs = new MemoryFileStore();
  const hasher = new NodeHasher();
  const notes = new NoteRepository({ db, clock, random: rand, logger });
  const search = new SearchRepository({ db });
  const blobs = new BlobRepository({ db, logger });
  const blobCas = new BlobCas('/sandbox', fs, hasher, logger, rand);
  const svc = new NoteService({ db, notes, search, blobs, blobCas, hasher, clock, logger });
  return { db, clock, fs, notes, blobs, svc, logger };
}

function pngBytes(seed: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = (seed * 31 + i) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 新建 / 编辑
// ---------------------------------------------------------------------------

test('save 新建：空白标题取正文首行作标题', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: '', contentMd: '第一行标题内容\n第二行' });
  assert.equal(note.title, '第一行标题内容');
  assert.equal(note.source, 'manual');
  assert.equal(note.revision, 1);
});

test('save 新建：全空正文给兜底名', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: '   ', contentMd: '\n  \n' });
  assert.equal(note.title, '未命名笔记');
});

test('save 编辑：标题+正文一次提交，revision 只 +1', async () => {
  const f = await makeFixture();
  const created = await f.svc.save({ title: '初稿', contentMd: 'v1 正文' });
  const edited = await f.svc.save({ id: created.id, title: '终稿', contentMd: 'v2 正文' });
  assert.equal(edited.title, '终稿');
  assert.equal(edited.contentMd, 'v2 正文');
  assert.equal(edited.revision, 2, '一次保存必须只递增一次修订');
});

test('save 编辑：回收站中的笔记拒绝编辑', async () => {
  const f = await makeFixture();
  const created = await f.svc.save({ title: 'a', contentMd: 'b' });
  await f.svc.moveToTrash(created.id);
  await assert.rejects(() => f.svc.save({ id: created.id, title: 'c', contentMd: 'd' }));
});

// ---------------------------------------------------------------------------
// 列表 / 置顶 / 回收站
// ---------------------------------------------------------------------------

test('listRecent：置顶优先，其余按更新时间倒序', async () => {
  const f = await makeFixture();
  const a = await f.svc.save({ title: 'A', contentMd: 'a' });
  f.clock.advance(1000);
  const b = await f.svc.save({ title: 'B', contentMd: 'b' });
  f.clock.advance(1000);
  const c = await f.svc.save({ title: 'C', contentMd: 'c' });
  await f.svc.setPinned(a.id, true);
  const list = await f.svc.listRecent(10);
  assert.deepEqual(list.map((n) => n.title), ['A', 'C', 'B'], '置顶在前；其余更新时间倒序');
  assert.equal(list[0].pinned, true);
});

test('moveToTrash：列表消失、可恢复、时间戳记录', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 'x', contentMd: 'y' });
  f.clock.advance(500);
  const trashed = await f.svc.moveToTrash(note.id);
  assert.equal(trashed.deletedAtMs, BASE_MS + 500);
  assert.deepEqual(await f.svc.listRecent(10), []);
  assert.equal(await f.svc.getById(note.id), undefined, '默认读取排除回收站条目');
  const restored = await f.svc.restore(note.id);
  assert.equal(restored.deletedAtMs, undefined);
  assert.equal((await f.svc.listRecent(10)).length, 1);
});

test('mergeNotes：顺序拼接、附件并挂（同 sha 去重）、标签并集、被合并篇进垃圾桶且恢复后内容独立', async () => {
  const f = await makeFixture();
  const a = await f.svc.save({ title: '首篇', contentMd: '正文A' });
  const b = await f.svc.save({ title: '第二篇', contentMd: '正文B' });
  const c = await f.svc.save({ title: '第三篇', contentMd: '正文C' });

  // 附件：A 挂 img1；B 挂 img1（同 sha）+ img2；C 无附件
  const img1 = await f.svc.importImage(a.id, pngBytes(1), 'image/png');
  await f.svc.importImage(b.id, pngBytes(1), 'image/png'); // 与 A 同字节同 sha
  const img2 = await f.svc.importImage(b.id, pngBytes(2), 'image/png');

  // 标签：A{阅读}, B{阅读,工作}, C{工作}
  await f.svc.setTags(a.id, ['阅读']);
  await f.svc.setTags(b.id, ['阅读', '工作']);
  await f.svc.setTags(c.id, ['工作']);

  const revBefore: number = a.revision;
  const merged = await f.svc.mergeNotes([a.id, b.id, c.id]);

  // 保留首篇：标题沿用、revision 只 +1、正文按顺序拼接
  assert.equal(merged.id, a.id);
  assert.equal(merged.title, '首篇');
  assert.equal(merged.revision, revBefore + 1);
  assert.equal(merged.contentMd, '正文A\n\n---\n\n正文B\n\n---\n\n正文C');
  assert.ok(merged.updatedAtMs >= a.updatedAtMs);

  // 附件并挂：img1 去重、img2 并入，共 2 条引用
  const keeperAtts = await f.svc.listAttachmentsOf(a.id);
  const shas = keeperAtts.map((x) => x.blobSha256).sort();
  assert.deepEqual(shas, [img1.sha256, img2.sha256].sort());

  // 标签并集
  const tags = (await f.svc.listTagsOfNote(a.id)).map((t) => t.name).sort();
  assert.deepEqual(tags, ['工作', '阅读']);

  // 被合并篇进垃圾桶：活体列表只剩首篇，回收站可恢复且内容独立（附件引用行保留）
  const live = (await f.svc.listRecent(10)).map((n) => n.id);
  assert.deepEqual(live, [a.id]);
  const trashedB = await f.notes.getById(b.id, true);
  assert.notEqual(trashedB?.deletedAtMs, undefined);
  const bAtts = await f.svc.listAttachmentsOf(b.id);
  assert.equal(bAtts.length, 2, '被合并篇恢复后图片仍可渲染（引用行保留）');
  const restoredB = await f.svc.restore(b.id);
  assert.equal(restoredB.contentMd, '正文B');
  assert.equal(restoredB.title, '第二篇');
});

test('mergeNotes：<2 篇、重复 id、含回收站/不存在条目都如实拒绝', async () => {
  const f = await makeFixture();
  const a = await f.svc.save({ title: 'a', contentMd: 'a' });
  const b = await f.svc.save({ title: 'b', contentMd: 'b' });

  await assert.rejects(() => f.svc.mergeNotes([a.id]), /at least 2/);
  await assert.rejects(() => f.svc.mergeNotes([a.id, a.id]), /duplicate/);
  await assert.rejects(() => f.svc.mergeNotes([a.id, 'no-such-note']), /not found/);
  await f.svc.moveToTrash(b.id);
  await assert.rejects(() => f.svc.mergeNotes([a.id, b.id]), /not found or deleted/);
  // 拒绝路径零副作用：首篇正文不变
  assert.equal((await f.svc.getById(a.id))?.contentMd, 'a');
});

test('purge：仅回收站条目可彻底删除；附件引用级联清理', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 'x', contentMd: 'y' });
  // 活体笔记拒绝彻底删除（防误删）
  await assert.rejects(() => f.svc.purge(note.id), /not in trash/);

  // 带附件进回收站后彻底删除：note 行、note_attachment 引用、FTS 索引一并消失
  const img = await f.svc.importImage(note.id, pngBytes(9), 'image/png');
  await f.svc.moveToTrash(note.id);
  assert.equal(await f.svc.purge(note.id), true);
  assert.equal(await f.notes.getById(note.id, true), undefined);
  const attachRows = await f.db.query(
    `SELECT note_id FROM note_attachment WHERE note_id = ?`, [note.id]);
  assert.equal(attachRows.length, 0, '附件引用随级联删除，字节留交 orphan GC');
  const ftsRows = await f.db.query(`SELECT rowid FROM note_fts WHERE title = 'x'`);
  assert.equal(ftsRows.length, 0, 'FTS 索引随触发器清理');
  // blob 记录与文件不在 purge 范围（orphan GC 职责）
  assert.notEqual(await f.blobs.get(img.sha256), undefined);
  // 重复 purge / 不存在 → false
  assert.equal(await f.svc.purge(note.id), false);
  assert.equal(await f.svc.purge('no-such-note'), false);
});

// ---------------------------------------------------------------------------
// 标签同步
// ---------------------------------------------------------------------------

test('setTags：trim、去重、差量解绑', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: 'c' });
  await f.svc.setTags(note.id, [' 前端 ', '前端', '', '阅读']);
  assert.deepEqual((await f.svc.listTagsOfNote(note.id)).map((t) => t.name), ['前端', '阅读']);
  await f.svc.setTags(note.id, ['阅读', '工具']);
  assert.deepEqual((await f.svc.listTagsOfNote(note.id)).map((t) => t.name), ['工具', '阅读']);
});

// ---------------------------------------------------------------------------
// 图片附件：写入顺序与幂等
// ---------------------------------------------------------------------------

test('importImage：文件先落地、引用后提交；snippet 用 attachment:// 协议', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: '正文' });
  const res = await f.svc.importImage(note.id, pngBytes(7), 'image/png');
  // 文件按内容寻址落盘（两级分片）
  assert.ok(f.fs.allPaths().some((p) => p.endsWith(res.sha256) && p.startsWith('/sandbox/blobs/')));
  // 引用与 blob 记录在 DB 提交
  const rec = await f.blobs.get(res.sha256);
  assert.ok(rec !== undefined);
  assert.equal(rec.status, 'referenced');
  assert.equal(rec.mime, 'image/png');
  const atts = await f.svc.listAttachmentsOf(note.id);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].role, 'inline_image');
  assert.equal(atts[0].ordinal, 0);
  assert.equal(res.markdownSnippet, `![图片](attachment://${res.sha256})`);
  assert.equal(res.deduped, false);
});

test('importImage：重复导入同一图片不产生第二份文件/引用，且不挪动已有 ordinal', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: '正文' });
  const first = await f.svc.importImage(note.id, pngBytes(9), 'image/png');
  const second = await f.svc.importImage(note.id, pngBytes(9), 'image/png');
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.deduped, true);
  const atts = await f.svc.listAttachmentsOf(note.id);
  assert.equal(atts.length, 1, '重复导入不得新增引用行');
  assert.equal(atts[0].ordinal, 0, '已有引用的渲染顺序不得被重复导入打乱');
});

test('importImage：两篇笔记引用同一图片得到两份引用、一个文件', async () => {
  const f = await makeFixture();
  const n1 = await f.svc.save({ title: 'n1', contentMd: 'a' });
  const n2 = await f.svc.save({ title: 'n2', contentMd: 'b' });
  const bytes = pngBytes(11);
  await f.svc.importImage(n1.id, bytes, 'image/png');
  const second = await f.svc.importImage(n2.id, bytes, 'image/png');
  assert.equal(second.deduped, true);
  assert.equal((await f.svc.listAttachmentsOf(n2.id)).length, 1);
  // 两个引用行 → 文件只有一个
  const files = f.fs.allPaths().filter((p) => p.includes(second.sha256));
  assert.equal(files.length, 1);
});

test('importImage：孤儿文件命中（文件在、无引用）不重写文件但建立引用', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: 'c' });
  const bytes = pngBytes(13);
  const sha = await new NodeHasher().sha256HexBytes(bytes);
  // 模拟上次崩溃残留：文件已改名成功但引用未提交
  f.fs.seedBytes(`/sandbox/${blobRelativePath(sha)}`, bytes);
  const res = await f.svc.importImage(note.id, bytes, 'image/png');
  assert.equal(res.sha256, sha);
  assert.equal(res.deduped, true);
  assert.equal((await f.svc.listAttachmentsOf(note.id)).length, 1);
});

test('importImage：写文件失败时绝不留下悬空引用（G5 阻断项）', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: 'c' });
  f.fs.failNextWrite = 1; // 临时文件写入即失败（磁盘满）
  await assert.rejects(() => f.svc.importImage(note.id, pngBytes(3), 'image/png'));
  assert.deepEqual(await f.svc.listAttachmentsOf(note.id), [], 'DB 不得出现未落盘文件的引用');
  assert.equal(f.fs.allPaths().length, 0, '失败的临时文件必须被清理');
});

test('importImage：空字节、不存在的笔记、回收站笔记都拒绝', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: 'c' });
  await assert.rejects(() => f.svc.importImage(note.id, new Uint8Array(0), 'image/png'));
  await assert.rejects(() => f.svc.importImage('missing-id', pngBytes(1), 'image/png'));
  await f.svc.moveToTrash(note.id);
  await assert.rejects(() => f.svc.importImage(note.id, pngBytes(2), 'image/png'));
});

test('importImage：达到附件上限后拒绝而不是静默丢弃', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: 'c' });
  // 预置恰好达到上限的引用（不同摘要的合法 blob 名）
  for (let i = 0; i < MAX_IMAGE_ATTACHMENTS_PER_NOTE; i++) {
    const sha = i.toString(16).padStart(64, '0');
    await f.blobs.saveRecord({
      sha256: sha,
      relativePath: blobRelativePath(sha),
      mime: 'image/png',
      size: 10,
      status: BlobStatus.REFERENCED,
    });
    await f.blobs.attach(note.id, sha, AttachmentRole.INLINE_IMAGE, i);
  }
  await assert.rejects(
    () => f.svc.importImage(note.id, pngBytes(21), 'image/png'),
    /exceed limit/,
  );
});

test('importImage：超大字节（>32MB 分享同一口径）在入 CAS 之前拒绝且零副作用', async () => {
  const f = await makeFixture();
  const note = await f.svc.save({ title: 't', contentMd: 'c' });
  const oversized = new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1);
  await assert.rejects(
    () => f.svc.importImage(note.id, oversized, 'image/png'),
    /too large/,
  );
  assert.equal(f.fs.allPaths().length, 0, '超限字节不得落盘');
  assert.deepEqual(await f.svc.listAttachmentsOf(note.id), [], '不得留下附件引用');
});

// ---------------------------------------------------------------------------
// 真机验收 Q4：保存去重（最近 2 日内正文完全相同的活体笔记幂等返回，不新建）
// ---------------------------------------------------------------------------

test('Q4 保存去重：2 日窗口内同正文新建 → 幂等返回既有笔记，不产生第二条', async () => {
  const f = await makeFixture();
  const first = await f.svc.save({ title: '', contentMd: '节后第一天晨读' });
  f.clock.advance(4000);
  const again = await f.svc.save({ title: '', contentMd: '节后第一天晨读' });
  assert.equal(again.id, first.id); // 返回既有笔记
  assert.equal((await f.notes.listRecent(10)).length, 1); // 库里仍只有一篇
  assert.ok(f.logger.has('note_save_deduped'));
  assert.ok(!f.logger.has('note_created') || f.logger.has('note_save_deduped'));
});

test('Q4 保存去重：正文不同（含空白差异）与窗口外（>2 日）都正常新建', async () => {
  const f = await makeFixture();
  await f.svc.save({ title: '', contentMd: '同一份内容' });
  // 空白差异即视为不同内容（口径可预期、可解释）
  const different = await f.svc.save({ title: '', contentMd: '同一份内容 ' });
  const listed1 = await f.notes.listRecent(10);
  assert.equal(listed1.length, 2);
  assert.notEqual(different.title, '');

  // 窗口外：3 天前的同正文不再参与去重
  f.clock.advance(3 * 24 * 60 * 60 * 1000);
  const after = await f.svc.save({ title: '', contentMd: '同一份内容' });
  const listed2 = await f.notes.listRecent(10);
  assert.equal(listed2.length, 3);
  assert.ok(after.id.length > 0);
});

test('Q4 保存去重：回收站中的笔记不参与；编辑（有 id）路径不去重', async () => {
  const f = await makeFixture();
  const first = await f.svc.save({ title: '', contentMd: '将被删除的重复内容' });
  await f.svc.moveToTrash(first.id);
  const second = await f.svc.save({ title: '', contentMd: '将被删除的重复内容' });
  assert.notEqual(second.id, first.id); // 已删不挡新建

  // 编辑路径（有 id）保持原语义：更新既有笔记，不触发去重
  const edited = await f.svc.save({ id: second.id, title: '改名', contentMd: '将被删除的重复内容' });
  assert.equal(edited.id, second.id);
  assert.equal(edited.revision, 2);
});

// ---------------------------------------------------------------------------
// 真机场景回归（2026-10-09 用户报「合并对象/顺序紊乱」）：链式合并。
// 保留篇的内容可能本身就是历史合并结果，再次被合并时会把历史内容整包带入
// 下一篇；此时每一篇源笔记都必须照常进垃圾桶，不能出现"内容被并走、源却还在列表里"。
// ---------------------------------------------------------------------------
test('mergeNotes：链式合并（源笔记自身已是合并结果／曾被从垃圾桶恢复）时，每一篇源都进垃圾桶', async () => {
  const f = await makeFixture();
  const g = await f.svc.save({ title: 'glinscott', contentMd: 'GLINSCOTT_URL' });
  const m = await f.svc.save({ title: '机器', contentMd: '机器正文' });
  const o = await f.svc.save({ title: 'OpenAI', contentMd: 'OPENAI原文' });
  const w = await f.svc.save({ title: 'weibo', contentMd: 'WEIBO正文' });

  // 合并①：机器并入 glinscott（glinscott 自此自带历史内容）
  await f.svc.mergeNotes([g.id, m.id]);
  // 用户随后从垃圾桶恢复了机器（真机实测确有此步）
  await f.svc.restore(m.id);

  // 合并②：glinscott（已自带历史内容）与 weibo 并入 OpenAI
  const merged = await f.svc.mergeNotes([o.id, g.id, w.id]);

  // 保留篇沿用 OpenAI；历史内容随 glinscott 整包带入
  assert.equal(merged.id, o.id);
  assert.equal(merged.title, 'OpenAI');
  assert.equal(
    merged.contentMd,
    'OPENAI原文\n\n---\n\nGLINSCOTT_URL\n\n---\n\n机器正文\n\n---\n\nWEIBO正文',
  );

  // 关键不变量：两个源都要进垃圾桶，不能出现"内容被并走、源仍在活体列表"
  const gAfter = await f.notes.getById(g.id, true);
  const wAfter = await f.notes.getById(w.id, true);
  assert.notEqual(gAfter?.deletedAtMs, undefined, '被并入的 glinscott 必须进垃圾桶');
  assert.notEqual(wAfter?.deletedAtMs, undefined, '被并入的 weibo 必须进垃圾桶');

  // 活体列表只剩 keeper 与用户主动恢复的那篇
  const live = (await f.svc.listRecent(10)).map((n) => n.id).sort();
  assert.deepEqual(live, [o.id, m.id].sort());
});
