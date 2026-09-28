import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_FORMAT_VERSION,
  blocksToMarkdown,
  buildManifest,
  dryRunRestore,
  parseManifest,
  rewriteAttachmentLinks,
  serializeManifest,
  BackupInput,
} from '../../common/src/main/ets/core/backup';
import {
  AttachmentRole,
  BlockType,
  BlobRecord,
  BlobStatus,
  DocumentBlock,
  Note,
  NoteAttachment,
  NoteSource,
} from '../../common/src/main/ets/core/model';
import { blobRelativePath } from '../../common/src/main/ets/core/blob-cas';
import { uuidv7 } from '../../common/src/main/ets/core/id';
import { FixedClock, MemoryFileStore, SequentialRandom } from './support/platform';

const clock = new FixedClock(1759000000000);
const rand = new SequentialRandom();

function newId(): string {
  return uuidv7(clock, rand);
}

function makeNote(id: string): Note {
  return {
    id,
    title: '标题',
    contentMd: '# 标题',
    contentType: 'text/markdown',
    source: NoteSource.CLIPBOARD,
    revision: 1,
    contentSchemaVersion: 1,
    pinned: false,
    createdAtMs: 1759000000000,
    updatedAtMs: 1759000000000,
  };
}

function makeInput(schemaVersion = 1): BackupInput {
  const noteId = newId();
  const sha = 'd'.repeat(64);
  const blob: BlobRecord = {
    sha256: sha,
    relativePath: blobRelativePath(sha),
    mime: 'image/png',
    size: 12,
    status: BlobStatus.REFERENCED,
  };
  const att: NoteAttachment = { noteId, blobSha256: sha, role: AttachmentRole.INLINE_IMAGE, ordinal: 0 };
  return {
    contentSchemaVersion: schemaVersion,
    appVersion: '0.1.0',
    exportedAtMs: 1759000000000,
    notes: [makeNote(noteId)],
    tags: [{ id: 'tag-1', name: '工作' }],
    noteTags: [{ noteId, tagId: 'tag-1' }],
    blobs: [blob],
    noteAttachments: [att],
  };
}

test('buildManifest / serializeManifest / parseManifest 往返成立', () => {
  const input = makeInput();
  const manifest = buildManifest(input);
  assert.equal(manifest.formatVersion, BACKUP_FORMAT_VERSION);
  const parsed = parseManifest(serializeManifest(manifest), 1);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.manifest?.notes.length, 1);
});

test('parseManifest 拒绝未知格式版本（不猜测兼容性）', () => {
  const json = JSON.stringify({ ...JSON.parse(serializeManifest(buildManifest(makeInput()))), formatVersion: 99 });
  const r = parseManifest(json, 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'unsupported_format_version'));
});

test('parseManifest 拒绝比当前应用更新的 schema（防降级导入损坏数据）', () => {
  const manifest = buildManifest(makeInput(5));
  const r = parseManifest(serializeManifest(manifest), 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'schema_too_new'));
});

test('parseManifest 对旧 schema 给出迁移告警而非错误', () => {
  const r = parseManifest(serializeManifest(buildManifest(makeInput(1))), 3);
  // 备份 schema 1 < 应用 schema 3 → 迁移告警，可继续
  assert.ok(r.issues.some((i) => i.code === 'schema_migration_required'));
  assert.equal(r.ok, true);
});

test('parseManifest 拒绝路径越界的附件（防目录穿越）', () => {
  const input = makeInput();
  const manifest = buildManifest({
    ...input,
    blobs: [{ ...input.blobs[0], relativePath: '../../etc/passwd' }],
  });
  const r = parseManifest(serializeManifest(manifest), 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'unsafe_blob_path'));
});

test('parseManifest 拒绝悬空引用（附件指向不存在 blob / 笔记）', () => {
  const input = makeInput();
  const manifest = buildManifest({
    ...input,
    noteAttachments: [{ noteId: input.notes[0].id, blobSha256: 'e'.repeat(64), role: input.noteAttachments[0].role, ordinal: 0 }],
  });
  const r = parseManifest(serializeManifest(manifest), 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'dangling_attachment_blob'));
});

test('parseManifest 拒绝非 UUID v7 的笔记身份', () => {
  const input = makeInput();
  const manifest = buildManifest({
    ...input,
    notes: [{ ...input.notes[0], id: 'note-1' }],
    noteAttachments: [],
  });
  const r = parseManifest(serializeManifest(manifest), 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'invalid_note_id'));
});

test('parseManifest 二次防御：拒绝备份中出现凭证字段（默认排除设备密钥与 MCP Token）', () => {
  const manifest = buildManifest(makeInput());
  const withSecret = {
    ...JSON.parse(serializeManifest(manifest)),
    mcpToken: 'should-not-be-here',
  };
  const r = parseManifest(JSON.stringify(withSecret), 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'forbidden_field'));
});

test('parseManifest 拒绝超大解压（条目数上限）', () => {
  const input = makeInput();
  const many: Note[] = [];
  for (let i = 0; i < 50001; i++) {
    many.push(makeNote(newId()));
  }
  const r = parseManifest(serializeManifest(buildManifest({ ...input, notes: many, noteAttachments: [] })), 1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'too_many_entries'));
});

test('dryRunRestore 在导入前发现缺失与大小不符的附件', async () => {
  const input = makeInput();
  const manifest = buildManifest(input);
  const fs = new MemoryFileStore();

  const empty = await dryRunRestore(manifest, fs, 'sandbox');
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missingBlobs, ['d'.repeat(64)]);

  const sha = 'd'.repeat(64);
  fs.seed(`sandbox/${blobRelativePath(sha)}`, 'x'.repeat(12)); // size 12，匹配
  const ok = await dryRunRestore(manifest, fs, 'sandbox');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.checks[0].sizeMatches, true);

  fs.seed(`sandbox/${blobRelativePath(sha)}`, 'x'.repeat(5)); // 截断
  const truncated = await dryRunRestore(manifest, fs, 'sandbox');
  assert.equal(truncated.ok, false);
  assert.deepEqual(truncated.sizeMismatches, [sha]);
});

test('可读导出：附件链接被重写为包内相对路径，未解析的引用被登记而不是改成坏链', () => {
  const known = 'd'.repeat(64);
  const unknown = 'f'.repeat(64);
  const md = `![图](attachment://${known})\n\n![缺](attachment://${unknown})`;
  const r = rewriteAttachmentLinks(md, (sha) => (sha === known ? `attachments/${sha}.png` : undefined));
  assert.ok(r.markdown.includes(`attachments/${known}.png`));
  assert.ok(r.markdown.includes(`attachment://${unknown}`));
  assert.deepEqual(r.unresolved, [unknown]);
});

test('blocksToMarkdown 复用块模型，保证屏幕/朗读/导出一致', () => {
  const blocks: DocumentBlock[] = [
    { id: '1', type: BlockType.HEADING, level: 2, range: { startLine: 0, endLine: 1, startOffset: 0, endOffset: 5 }, text: '标题', docRevision: 1 },
    { id: '2', type: BlockType.PARAGRAPH, level: 0, range: { startLine: 1, endLine: 2, startOffset: 5, endOffset: 10 }, text: '正文', docRevision: 1 },
    { id: '3', type: BlockType.CODE, level: 0, range: { startLine: 2, endLine: 3, startOffset: 10, endOffset: 20 }, text: 'const a = 1;', docRevision: 1 },
    { id: '4', type: BlockType.THEMATIC_BREAK, level: 0, range: { startLine: 3, endLine: 4, startOffset: 20, endOffset: 21 }, text: '', docRevision: 1 },
  ];
  const md = blocksToMarkdown(blocks);
  assert.ok(md.includes('## 标题'));
  assert.ok(md.includes('正文'));
  assert.ok(md.includes('```\nconst a = 1;\n```'));
  assert.ok(md.trim().endsWith('---'));
});
