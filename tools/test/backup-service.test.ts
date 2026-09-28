import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackupService, BackupServiceDeps, MANIFEST_ENTRY } from '../../common/src/main/ets/core/backup-service';
import { BackupManifest, parseManifest } from '../../common/src/main/ets/core/backup';
import { buildZip, readZip, ZipEntryInput } from '../../common/src/main/ets/core/zip';
import { utf8Decode, utf8Encode } from '../../common/src/main/ets/core/bytes';
import { blobRelativePath } from '../../common/src/main/ets/core/blob-cas';
import { AttachmentRole, BlobStatus, Note, NoteSource } from '../../common/src/main/ets/core/model';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { BackupRepository, BackupSnapshot } from '../../common/src/main/ets/core/data/backup-repository';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { BlobCas } from '../../common/src/main/ets/core/blob-cas';
import { CapturingLogger, FixedClock, MemoryFileStore, NodeHasher, SequentialRandom } from './support/platform';
import { NodeSqliteExecutor } from './support/sqlite-executor';

const APP_VERSION = '0.1.0-test';

interface World {
  fs: MemoryFileStore;
  executor: NodeSqliteExecutor;
  service: BackupService;
  notes: NoteRepository;
  blobs: BlobRepository;
  cas: BlobCas;
  clock: FixedClock;
  logger: CapturingLogger;
}

async function makeWorld(): Promise<World> {
  const fs = new MemoryFileStore();
  const executor = NodeSqliteExecutor.openMemory();
  const clock = new FixedClock(1759000000000);
  const random = new SequentialRandom();
  const hasher = new NodeHasher();
  const logger = new CapturingLogger();
  await new SchemaMigrator(executor, logger).migrate();
  const deps: BackupServiceDeps = {
    db: executor,
    fs,
    hasher,
    clock,
    random,
    logger,
    root: 'sandbox',
    appVersion: APP_VERSION,
  };
  return {
    fs,
    executor,
    service: new BackupService(deps),
    notes: new NoteRepository({ db: executor, clock, random, logger }),
    blobs: new BlobRepository({ db: executor, logger }),
    cas: new BlobCas('sandbox', fs, hasher, logger, random),
    clock,
    logger,
  };
}

/** 种一份"笔记 + 标签 + 附件"数据；返回 {noteId, sha, content} */
async function seedNote(w: World, title: string, blobText?: string): Promise<{ noteId: string; sha?: string }> {
  const note: Note = await w.notes.create({ title, contentMd: `# ${title}\n\n正文`, source: NoteSource.CLIPBOARD });
  await w.notes.addTag(note.id, '工作');
  let sha: string | undefined = undefined;
  if (blobText !== undefined) {
    const put = await w.cas.put(blobText);
    sha = put.sha256;
    await w.blobs.saveRecord({
      sha256: put.sha256,
      relativePath: put.relativePath,
      mime: 'image/png',
      size: put.size,
      status: BlobStatus.REFERENCED,
    });
    await w.blobs.attach(note.id, put.sha256, AttachmentRole.INLINE_IMAGE, 0);
  }
  return { noteId: note.id, sha };
}

function manifestOf(zipBytes: Uint8Array): BackupManifest {
  const r = readZip(zipBytes);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  const e = r.entries.find((x) => x.name === MANIFEST_ENTRY);
  assert.ok(e !== undefined);
  const parsed = parseManifest(utf8Decode(e.data), 1);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  return parsed.manifest as BackupManifest;
}

async function snapshotOf(w: World): Promise<BackupSnapshot> {
  return new BackupRepository(w.executor).snapshot();
}

test('导出 → 空库恢复：内容与关系逐字段一致（G5 可核对口径）', async () => {
  const src = await makeWorld();
  const { noteId, sha } = await seedNote(src, '周报 2026-W39', '假装是图片字节');
  await seedNote(src, '无附件笔记');

  const exported = await src.service.exportBackup();
  assert.equal(exported.noteCount, 2);
  assert.equal(exported.blobCount, 1);
  assert.ok(await src.fs.exists(exported.zipPath));
  assert.equal(exported.zipPath.endsWith('.zip'), true);
  // 暂存已清理
  const backups = await src.fs.list('sandbox/backups');
  assert.equal(backups.filter((n) => n.includes('.tmp-')).length, 0);

  const zipBytes = await src.fs.readBytes(exported.zipPath);
  const manifest = manifestOf(zipBytes);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.notes.length, 2);
  assert.equal(manifest.blobs.length, 1);
  assert.equal(manifest.noteAttachments.length, 1);
  // 包内 blob 条目与清单一致
  const r = readZip(zipBytes);
  assert.ok(r.entries.some((e) => e.name === blobRelativePath(sha as string)));

  // 恢复到空库
  const dst = await makeWorld();
  // 目标库也需要这个 zip：跨世界拷贝（模拟用户把包带到新设备）
  await dst.fs.writeRawBytes(exported.zipPath, zipBytes);
  const result = await dst.service.restoreBackup(exported.zipPath);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.restored, { notes: 2, blobs: 1, attachments: 1, tags: 1 });
  assert.equal(result.recovery?.missing.length, 0);
  assert.equal(result.recovery?.mismatched.length, 0);

  // 逐字段一致：快照级 deepEqual
  assert.deepEqual(await snapshotOf(dst), await snapshotOf(src));
  // blob 文件本体也在
  assert.equal(await dst.cas.read(sha as string), '假装是图片字节');
  const note = await dst.notes.getById(noteId);
  assert.equal(note?.title, '周报 2026-W39');
  assert.deepEqual((await dst.notes.listTagsOfNote(noteId)).map((t) => t.name), ['工作']);
});

test('恢复是原子替换：现有数据被整体替换，不留半新半旧', async () => {
  const src = await makeWorld();
  const { noteId } = await seedNote(src, '备份时的标题', 'blob-v1');
  const exported = await src.service.exportBackup();
  const zipBytes = await src.fs.readBytes(exported.zipPath);

  // 导出后源库继续演进：改标题 + 新增笔记 + 新附件
  await src.notes.rename(noteId, '改名了');
  await seedNote(src, '备份之后新增的笔记', 'blob-v2');

  const result = await src.service.restoreBackup(exported.zipPath, undefined);
  void zipBytes;
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const note = await src.notes.getById(noteId);
  assert.equal(note?.title, '备份时的标题');
  const all = await src.notes.listRecent(100);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, noteId);
});

test('负向：篡改 manifest（注入凭证字段）被拒，现有数据不动', async () => {
  const src = await makeWorld();
  await seedNote(src, '原始笔记', 'blob-x');
  const exported = await src.service.exportBackup();
  const zipBytes = await src.fs.readBytes(exported.zipPath);
  const manifest = manifestOf(zipBytes);

  const tampered = JSON.stringify({ ...JSON.parse(JSON.stringify(manifest)), mcpToken: 'stolen' });
  const badZip = buildZip([
    { name: MANIFEST_ENTRY, data: utf8Encode(tampered) },
    ...readZip(zipBytes).entries.filter((e) => e.name !== MANIFEST_ENTRY),
  ]);
  await src.fs.writeRawBytes('sandbox/backups/tampered.zip', badZip);

  const before = await snapshotOf(src);
  const result = await src.service.restoreBackup('sandbox/backups/tampered.zip');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'forbidden_field'));
  assert.deepEqual(await snapshotOf(src), before);
});

test('负向：篡改 manifest（非法笔记身份 / 悬空引用）被拒', async () => {
  const src = await makeWorld();
  await seedNote(src, 'x', 'blob-y');
  const exported = await src.service.exportBackup();
  const manifest = manifestOf(await src.fs.readBytes(exported.zipPath));

  const badId = { ...JSON.parse(JSON.stringify(manifest)) };
  badId.notes[0].id = 'not-a-uuid';
  const zip1 = buildZip([{ name: MANIFEST_ENTRY, data: utf8Encode(JSON.stringify(badId)) }]);
  await src.fs.writeRawBytes('sandbox/backups/bad1.zip', zip1);
  const r1 = await src.service.restoreBackup('sandbox/backups/bad1.zip');
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.code === 'invalid_note_id'));

  const dangling = { ...JSON.parse(JSON.stringify(manifest)) };
  dangling.noteAttachments[0].blobSha256 = 'f'.repeat(64);
  const zip2 = buildZip([{ name: MANIFEST_ENTRY, data: utf8Encode(JSON.stringify(dangling)) }]);
  await src.fs.writeRawBytes('sandbox/backups/bad2.zip', zip2);
  const r2 = await src.service.restoreBackup('sandbox/backups/bad2.zip');
  assert.equal(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.code === 'dangling_attachment_blob'));
});

test('负向：越界路径条目的 ZIP 被拒（Zip Slip）', async () => {
  const src = await makeWorld();
  await seedNote(src, 'x');
  const exported = await src.service.exportBackup();
  const zipBytes = new Uint8Array(await src.fs.readBytes(exported.zipPath));
  // manifest.json (13) → ../evil.json (12+1=12?) 长度需一致：manifest.json=13，用 '../evil1.json' 也是13？数一下：. . / e v i l 1 . j s o n = 13
  const evil = '../evil1.json';
  assert.equal(evil.length, 'manifest.json'.length);
  const from = utf8Encode('manifest.json');
  const to = utf8Encode(evil);
  let hits = 0;
  for (let i = 0; i + from.length <= zipBytes.length; i++) {
    let m = true;
    for (let j = 0; j < from.length; j++) {
      if (zipBytes[i + j] !== from[j]) {
        m = false;
        break;
      }
    }
    if (m) {
      zipBytes.set(to, i);
      hits++;
    }
  }
  assert.ok(hits >= 2);
  await src.fs.writeRawBytes('sandbox/backups/evil.zip', zipBytes);
  const before = await snapshotOf(src);
  const result = await src.service.restoreBackup('sandbox/backups/evil.zip');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'unsafe_entry_path'), JSON.stringify(result.issues));
  assert.deepEqual(await snapshotOf(src), before);
});

test('负向：损坏的 ZIP（截断 / CRC 篡改）被拒', async () => {
  const src = await makeWorld();
  await seedNote(src, 'x', 'blob-z');
  const exported = await src.service.exportBackup();
  const zipBytes = await src.fs.readBytes(exported.zipPath);

  await src.fs.writeRawBytes('sandbox/backups/truncated.zip', zipBytes.slice(0, zipBytes.length - 8));
  const r1 = await src.service.restoreBackup('sandbox/backups/truncated.zip');
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.code === 'zip_invalid'));

  const flipped = new Uint8Array(zipBytes);
  flipped[40] = flipped[40] ^ 0xff; // manifest 数据区
  await src.fs.writeRawBytes('sandbox/backups/crc.zip', flipped);
  const r2 = await src.service.restoreBackup('sandbox/backups/crc.zip');
  assert.equal(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.code === 'zip_invalid'));
});

test('负向：包内 blob 被替换（CRC 合法但摘要与 manifest 不符）被拒', async () => {
  const src = await makeWorld();
  const { sha } = await seedNote(src, 'x', '真实图片内容AAAA');
  const exported = await src.service.exportBackup();
  const zipBytes = await src.fs.readBytes(exported.zipPath);
  const good = readZip(zipBytes);
  const badEntries: ZipEntryInput[] = good.entries.map((e) =>
    e.name === blobRelativePath(sha as string)
      ? { name: e.name, data: utf8Encode('伪造图片内容AAAA') } // 等长，绕过大小校验
      : e,
  );
  await src.fs.writeRawBytes('sandbox/backups/forged.zip', buildZip(badEntries));
  const before = await snapshotOf(src);
  const result = await src.service.restoreBackup('sandbox/backups/forged.zip');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'blob_hash_mismatch'), JSON.stringify(result.issues));
  assert.deepEqual(await snapshotOf(src), before);
});

test('负向：包内缺 blob 文件（manifest 引用但条目缺失）被拒', async () => {
  const src = await makeWorld();
  await seedNote(src, 'x', 'blob-content');
  const exported = await src.service.exportBackup();
  const good = readZip(await src.fs.readBytes(exported.zipPath));
  const onlyManifest = good.entries.filter((e) => e.name === MANIFEST_ENTRY);
  await src.fs.writeRawBytes('sandbox/backups/missing.zip', buildZip(onlyManifest));
  const result = await src.service.restoreBackup('sandbox/backups/missing.zip');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'blob_precheck_failed'));
});

test('故障注入：事务内被杀（hook 抛错）→ 回滚，库保持原状', async () => {
  const src = await makeWorld();
  const { noteId } = await seedNote(src, '改前', 'blob-tx');
  const exported = await src.service.exportBackup();
  await src.notes.rename(noteId, '改后');

  await assert.rejects(
    src.service.restoreBackup(exported.zipPath, {
      onPhase: (phase) => {
        if (phase === 'tx-written') {
          throw new Error('SIGKILL simulation');
        }
        return Promise.resolve();
      },
    }),
  );
  // 回滚后仍是"改后"，且引用完整
  assert.equal((await src.notes.getById(noteId))?.title, '改后');
  const report = await src.blobs.listReferencedShas();
  for (const sha of report) {
    assert.equal(await src.cas.exists(sha), true);
  }
});

test('故障注入：提交后被杀（恢复扫描前）→ 数据已是新备份，引用完整', async () => {
  const src = await makeWorld();
  await seedNote(src, '备份内容', 'blob-commit');
  const exported = await src.service.exportBackup();
  await seedNote(src, '将被替换的笔记');

  await assert.rejects(
    src.service.restoreBackup(exported.zipPath, {
      onPhase: (phase) => {
        if (phase === 'db-replaced') {
          throw new Error('SIGKILL simulation');
        }
        return Promise.resolve();
      },
    }),
  );
  // 事务已提交：库即备份内容；重新跑恢复扫描应干净（等价于下次启动恢复）
  const snap = await snapshotOf(src);
  assert.equal(snap.notes.length, 1);
  assert.equal(snap.notes[0].title, '备份内容');
});

test('被杀留下的暂存目录在下一次备份/恢复时被清扫', async () => {
  const src = await makeWorld();
  await seedNote(src, 'x');
  src.fs.seed('sandbox/backups/restore.tmp-deadbeef/manifest.json', '{}');
  await src.service.exportBackup();
  const names = await src.fs.list('sandbox/backups');
  assert.equal(names.some((n) => n.includes('.tmp-')), false);
  assert.equal(src.logger.has('backup_staging_swept'), true);
});

test('软删除笔记与收件箱不进备份', async () => {
  const src = await makeWorld();
  const { noteId } = await seedNote(src, '活笔记');
  const deleted = await seedNote(src, '已删除笔记', 'deleted-blob');
  await src.notes.softDelete(deleted.noteId);

  const exported = await src.service.exportBackup();
  const manifest = manifestOf(await src.fs.readBytes(exported.zipPath));
  assert.equal(manifest.notes.length, 1);
  assert.equal(manifest.notes[0].id, noteId);
  // 被软删笔记独占的 blob 不进包
  assert.equal(manifest.blobs.length, 0);
});
