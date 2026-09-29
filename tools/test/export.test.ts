import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_NOTES_DIR,
  EXPORT_README_ENTRY,
  assetEntryName,
  assetLinkFromNote,
  buildExportEntries,
  buildStaticHtmlPage,
  extensionForMime,
  sanitizeFileName,
} from '../../common/src/main/ets/core/export';
import {
  EXPORT_OUTPUT_DIR,
  EXPORT_RECORD_KEEP,
  ExportService,
  ExportServiceDeps,
  describeExportRecord,
} from '../../common/src/main/ets/core/export-service';
import { ExportRecordRepository } from '../../common/src/main/ets/core/data/export-record-repository';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { BlobCas } from '../../common/src/main/ets/core/blob-cas';
import { readZip } from '../../common/src/main/ets/core/zip';
import { utf8Decode, utf8Encode } from '../../common/src/main/ets/core/bytes';
import { AttachmentRole, BlobStatus, Note, NoteSource } from '../../common/src/main/ets/core/model';
import { CONTENT_TYPE_HTML } from '../../common/src/main/ets/core/htmlsafe';
import { CapturingLogger, FixedClock, MemoryFileStore, NodeHasher, SequentialRandom } from './support/platform';
import { NodeSqliteExecutor } from './support/sqlite-executor';

const SHA_A: string = 'a'.repeat(64);
const SHA_B: string = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// export.ts 纯函数
// ---------------------------------------------------------------------------

test('export: sanitizeFileName 剥除非法字符/前导点/控制字符，超限截断，空则兜底', () => {
  assert.equal(sanitizeFileName('周报 2026-W39', 'x'), '周报 2026-W39');
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j', 'x'), 'a b c d e f g h i j');
  assert.equal(sanitizeFileName('...隐藏', 'x'), '隐藏');
  assert.equal(sanitizeFileName('   ', 'fallback'), 'fallback');
  assert.equal(sanitizeFileName('', 'fallback'), 'fallback');
  const long: string = '长'.repeat(100);
  assert.ok(sanitizeFileName(long, 'x').length <= 60);
});

test('export: 附件包内命名与相对链接（内容寻址 + MIME 扩展名）', () => {
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('IMAGE/JPEG'), 'jpg');
  assert.equal(extensionForMime('application/octet-stream'), 'bin');
  assert.equal(assetEntryName(SHA_A, 'image/png'), `assets/${SHA_A}.png`);
  assert.equal(assetLinkFromNote(SHA_A, 'image/png'), `../assets/${SHA_A}.png`);
});

test('export: buildStaticHtmlPage 受控静态页（CSP 锁死脚本与联网）', () => {
  const html: string = buildStaticHtmlPage('标题 <script>', '<p>正文</p>');
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!html.includes('<script src'));
  assert.ok(html.includes('<p>正文</p>'));
  // 标题经 HTML 转义
  assert.ok(html.includes('标题 &lt;script&gt;'));
});

test('export: buildExportEntries 链接重写 + 附件去重 + README 声明（导出 ≠ 备份）', () => {
  const note1: Note = makeNote('n1', '第一篇', `正文 ![图](attachment://${SHA_A})`);
  const note2: Note = makeNote('n2', '第二篇', `引用同一张图 attachment://${SHA_A} 与未知 attachment://${SHA_B}`);
  const built = buildExportEntries([
    { note: note1, assets: [{ sha256: SHA_A, mime: 'image/png', bytes: utf8Encode('PNG_BYTES') }] },
    { note: note2, assets: [{ sha256: SHA_A, mime: 'image/png', bytes: utf8Encode('PNG_BYTES') }] },
  ], { appVersion: '0.1.0-test', exportedAtMs: 1759000000000 });

  assert.equal(built.format, 'markdown');
  assert.equal(built.noteCount, 2);
  // 内容寻址去重：两篇共享同一附件，包内只有一份
  assert.equal(built.blobCount, 1);

  const names: string[] = built.entries.map((e) => e.name);
  assert.deepEqual(names.filter((n) => n.startsWith('assets/')), [`assets/${SHA_A}.png`]);
  assert.ok(names.includes(`${EXPORT_NOTES_DIR}/01-第一篇.md`));
  assert.ok(names.includes(`${EXPORT_NOTES_DIR}/02-第二篇.md`));
  assert.ok(names.includes(EXPORT_README_ENTRY));

  const md1: string = utf8Decode(built.entries[0].data);
  assert.ok(md1.includes(`../assets/${SHA_A}.png`));
  // 未知附件：保持原链接并登记，不改成坏链接
  const md2: string = utf8Decode(built.entries[1].data);
  assert.ok(md2.includes(`attachment://${SHA_B}`));
  assert.deepEqual(built.unresolved, [SHA_B]);

  const readme: string = utf8Decode(built.entries[built.entries.length - 1].data);
  assert.ok(readme.includes('可读导出 ≠ 可恢复备份'));
});

test('export: HTML 笔记导出为受控静态页（复跑清洗 + 混合格式判定）', () => {
  const htmlNote: Note = makeNote('h1', '网页剪藏', '<p>正文</p><script>alert(1)</script>', CONTENT_TYPE_HTML);
  const mdNote: Note = makeNote('m1', '普通笔记', '纯文本');
  const built = buildExportEntries([
    { note: htmlNote, assets: [] },
    { note: mdNote, assets: [] },
  ], { appVersion: '0.1.0-test', exportedAtMs: 1759000000000 });

  assert.equal(built.format, 'mixed');
  const htmlEntry = built.entries.find((e) => e.name.endsWith('.html'));
  assert.ok(htmlEntry !== undefined);
  const body: string = utf8Decode(htmlEntry.data);
  assert.ok(body.includes('Content-Security-Policy'));
  assert.ok(body.includes('<p>正文</p>'));
  assert.ok(!body.includes('alert(1)'));
});

// ---------------------------------------------------------------------------
// export-service.ts 端到端（内存库 + 内存文件系统）
// ---------------------------------------------------------------------------

interface World {
  fs: MemoryFileStore;
  service: ExportService;
  notes: NoteRepository;
  blobs: BlobRepository;
  cas: BlobCas;
  records: ExportRecordRepository;
  clock: FixedClock;
}

async function makeWorld(): Promise<World> {
  const fs = new MemoryFileStore();
  const executor = NodeSqliteExecutor.openMemory();
  const clock = new FixedClock(1759000000000);
  const random = new SequentialRandom();
  const hasher = new NodeHasher();
  const logger = new CapturingLogger();
  await new SchemaMigrator(executor, logger).migrate();
  const notes = new NoteRepository({ db: executor, clock, random, logger });
  const blobs = new BlobRepository({ db: executor, logger });
  const cas = new BlobCas('sandbox', fs, hasher, logger, random);
  const records = new ExportRecordRepository(executor);
  const deps: ExportServiceDeps = {
    notes,
    blobs,
    cas,
    records,
    fs,
    clock,
    random,
    logger,
    root: 'sandbox',
    appVersion: '0.1.0-test',
  };
  return { fs, service: new ExportService(deps), notes, blobs, cas, records, clock };
}

function makeNote(id: string, title: string, contentMd: string, contentType?: string): Note {
  return {
    id,
    title,
    contentMd,
    contentType: contentType ?? 'text/markdown',
    source: NoteSource.CLIPBOARD,
    revision: 1,
    contentSchemaVersion: 1,
    pinned: false,
    createdAtMs: 1759000000000,
    updatedAtMs: 1759000000000,
  };
}

/** 种一篇带附件的笔记；正文引用 attachment://<sha> */
async function seedNoteWithAsset(w: World, title: string, blobText: string): Promise<{ noteId: string; sha: string }> {
  const put = await w.cas.putBytes(utf8Encode(blobText));
  const note: Note = await w.notes.create({
    title,
    contentMd: `# ${title}\n\n![图](attachment://${put.sha256})`,
    source: NoteSource.CLIPBOARD,
  });
  await w.blobs.saveRecord({
    sha256: put.sha256,
    relativePath: put.relativePath,
    mime: 'image/png',
    size: put.size,
    status: BlobStatus.REFERENCED,
  });
  await w.blobs.attach(note.id, put.sha256, AttachmentRole.INLINE_IMAGE, 0);
  return { noteId: note.id, sha: put.sha256 };
}

test('export-service: 单篇导出 → ZIP 落盘 + 链接重写 + 记录登记', async () => {
  const w = await makeWorld();
  const { noteId, sha } = await seedNoteWithAsset(w, '周报', '图片字节');

  const result = await w.service.exportSingle(noteId);
  assert.equal(result.record.kind, 'single');
  assert.equal(result.record.format, 'markdown');
  assert.equal(result.record.noteCount, 1);
  assert.equal(result.record.blobCount, 1);
  assert.equal(result.unresolved.length, 0);
  assert.ok(result.record.filePath.startsWith(`sandbox/${EXPORT_OUTPUT_DIR}/`));
  assert.ok(await w.fs.exists(result.record.filePath));

  const zip = readZip(await w.fs.readBytes(result.record.filePath));
  assert.equal(zip.ok, true, JSON.stringify(zip.issues));
  const md = zip.entries.find((e) => e.name.endsWith('.md'));
  assert.ok(md !== undefined);
  assert.ok(utf8Decode(md.data).includes(`../assets/${sha}.png`));
  assert.ok(zip.entries.some((e) => e.name === `assets/${sha}.png`));

  // 记录可查
  const records = await w.service.listRecords(10);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, result.record.id);
  assert.ok(describeExportRecord(records[0]).includes('单篇导出'));
});

test('export-service: 批量导出跳过竞态删除的篇目；单篇不存在直接报错', async () => {
  const w = await makeWorld();
  const a = await seedNoteWithAsset(w, 'A', 'a-bytes');
  const b = await seedNoteWithAsset(w, 'B', 'b-bytes');

  const result = await w.service.exportBatch([a.noteId, 'no-such-note', b.noteId]);
  assert.equal(result.record.kind, 'batch');
  assert.equal(result.record.noteCount, 2);

  await assert.rejects(() => w.service.exportSingle('no-such-note'), /not found/);
  await assert.rejects(() => w.service.exportBatch(['no-such-note']), /no exportable notes/);
});

test('export-service: 全量导出覆盖全部未删除笔记，回收站条目不进包', async () => {
  const w = await makeWorld();
  await seedNoteWithAsset(w, '保留一', 'x1');
  const gone = await seedNoteWithAsset(w, '已删除', 'x2');
  await seedNoteWithAsset(w, '保留二', 'x3');
  await w.notes.softDelete(gone.noteId);

  const result = await w.service.exportAll();
  assert.equal(result.record.kind, 'full');
  assert.equal(result.record.noteCount, 2);

  const zip = readZip(await w.fs.readBytes(result.record.filePath));
  assert.equal(zip.ok, true);
  const mdNames: string[] = zip.entries.filter((e) => e.name.endsWith('.md') && e.name.startsWith('notes/')).map((e) => e.name);
  assert.equal(mdNames.length, 2);
  assert.ok(!mdNames.some((n) => n.includes('已删除')));
});

test('export-service: 附件字节缺失不阻断导出，链接保持原样并登记 unresolved', async () => {
  const w = await makeWorld();
  // 只建引用关系，故意不写 blob 记录/字节（模拟文件丢失场景）
  const note: Note = await w.notes.create({
    title: '缺附件',
    contentMd: `正文 attachment://${SHA_A}`,
    source: NoteSource.CLIPBOARD,
  });
  const result = await w.service.exportSingle(note.id);
  assert.deepEqual(result.unresolved, [SHA_A]);
  const zip = readZip(await w.fs.readBytes(result.record.filePath));
  const md = zip.entries.find((e) => e.name.endsWith('.md'));
  assert.ok(utf8Decode(md!.data).includes(`attachment://${SHA_A}`));
});

test('export-service: 记录保留策略 —— 超出上限的旧记录连同产物文件一起清理', async () => {
  const w = await makeWorld();
  const { noteId } = await seedNoteWithAsset(w, '轮转', 'bytes');

  const paths: string[] = [];
  for (let i: number = 0; i < EXPORT_RECORD_KEEP + 3; i++) {
    w.clock.advance(1000);
    const r = await w.service.exportSingle(noteId);
    paths.push(r.record.filePath);
  }

  const records = await w.service.listRecords(EXPORT_RECORD_KEEP * 4);
  assert.equal(records.length, EXPORT_RECORD_KEEP);
  // 最旧的 3 条产物已删除，最近的还在
  for (let i: number = 0; i < 3; i++) {
    assert.equal(await w.fs.exists(paths[i]), false, `old artifact ${paths[i]} should be removed`);
  }
  assert.equal(await w.fs.exists(paths[paths.length - 1]), true);
});
