import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { runStartupRecovery } from '../../common/src/main/ets/core/data/recovery';
import { transact } from '../../common/src/main/ets/core/data/rdb';
import { BlobCas, blobRelativePath } from '../../common/src/main/ets/core/blob-cas';
import {
  AttachmentRole,
  BlobStatus,
  NoteSource,
} from '../../common/src/main/ets/core/model';
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
  fs: MemoryFileStore;
  logger: CapturingLogger;
  notes: NoteRepository;
  blobs: BlobRepository;
  blobCas: BlobCas;
}

/** 装配"数据库 + 文件系统 + 附件 CAS"的最小运行环境（与鸿蒙 AppDataRuntime 同一套内核） */
async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const rand = new SequentialRandom();
  const fsStore = new MemoryFileStore();
  const hasher = new NodeHasher();
  const blobCas = new BlobCas('/sandbox', fsStore, hasher, logger, rand);
  return {
    db,
    fs: fsStore,
    logger,
    notes: new NoteRepository({ db, clock, random: rand, logger }),
    blobs: new BlobRepository({ db, logger }),
    blobCas,
  };
}

test('恢复扫描: 干净环境为空报告', async () => {
  const fx = await makeFixture();
  const report = await runStartupRecovery({
    blobRepository: fx.blobs,
    blobCas: fx.blobCas,
    logger: fx.logger,
  });
  assert.deepEqual(report.missing, []);
  assert.equal(report.scanned, 0);
  assert.equal(report.orphansMarkedGrace, 0);
  assert.ok(fx.logger.has('startup_recovery_done'));
});

test('恢复扫描: 被引用但文件缺失 → 完整性事故，如实上报且不自动修', async () => {
  const fx = await makeFixture();
  const note = await fx.notes.create({ title: 't', contentMd: 't', source: NoteSource.MANUAL });

  // 正常写入协议：文件先落地 → 事务提交引用
  const put = await fx.blobCas.put('图片字节');
  await transact(fx.db, async () => {
    await fx.blobs.saveRecord({
      sha256: put.sha256,
      relativePath: put.relativePath,
      mime: 'image/png',
      size: put.size,
      status: BlobStatus.ORPHAN_GRACE,
    });
    await fx.blobs.attach(note.id, put.sha256, AttachmentRole.INLINE_IMAGE, 0);
  });

  // 模拟"文件丢失"（G5 场景）
  fx.fs.drop(`/sandbox/${put.relativePath}`);

  const report = await runStartupRecovery({
    blobRepository: fx.blobs,
    blobCas: fx.blobCas,
    logger: fx.logger,
  });
  assert.deepEqual(report.missing, [put.sha256]);
  assert.ok(fx.logger.has('startup_recovery_integrity_incident'));
  // 不自动修：引用与记录保持原样，交由上层决策（G5 阻断项）
  assert.deepEqual(await fx.blobs.listReferencedShas(), [put.sha256]);
});

test('恢复扫描: 崩溃残留（临时文件 + 无引用孤儿）被清理/降级进宽限期', async () => {
  const fx = await makeFixture();

  // 模拟"临时写入完成、改名前进程被杀"：临时文件残留
  const sha = 'e'.repeat(64);
  const dir = blobRelativePath(sha).slice(0, blobRelativePath(sha).lastIndexOf('/'));
  fx.fs.seed(`/sandbox/${dir}/orphan.tmp-deadbeef`, 'partial');

  // 模拟"文件落地、DB 引用事务未提交"：孤儿文件 + 无引用
  const orphan = await fx.blobCas.put('未提交引用的附件');

  // 模拟"blob 记录还在 referenced，但引用行已不存在"的不一致状态
  const dangling = await fx.blobCas.put('记录残留');
  await fx.blobs.saveRecord({
    sha256: dangling.sha256,
    relativePath: dangling.relativePath,
    mime: 'image/png',
    size: dangling.size,
    status: BlobStatus.REFERENCED,
  });

  const report = await runStartupRecovery({
    blobRepository: fx.blobs,
    blobCas: fx.blobCas,
    logger: fx.logger,
  });

  assert.equal(report.scanned, 2);
  // 临时残留被清理
  assert.equal(await fx.fs.exists(`/sandbox/${dir}/orphan.tmp-deadbeef`), false);
  // 孤儿记录降级进 GC 宽限期，绝不直接删文件（宁可留孤儿）
  assert.equal(report.orphansMarkedGrace, 1); // 只有 dangling 在库里有记录
  assert.equal((await fx.blobs.get(dangling.sha256))?.status, BlobStatus.ORPHAN_GRACE);
  assert.equal(await fx.blobCas.exists(orphan.sha256), true);
  assert.deepEqual(report.missing, []);
});

test('恢复扫描: verifyHash 发现摘要不符', async () => {
  const fx = await makeFixture();
  const note = await fx.notes.create({ title: 't', contentMd: 't', source: NoteSource.MANUAL });
  const put = await fx.blobCas.put('原始内容');
  await transact(fx.db, async () => {
    await fx.blobs.saveRecord({
      sha256: put.sha256,
      relativePath: put.relativePath,
      mime: 'text/plain',
      size: put.size,
      status: BlobStatus.ORPHAN_GRACE,
    });
    await fx.blobs.attach(note.id, put.sha256, AttachmentRole.FILE, 0);
  });

  // 模拟文件内容被篡改/截断（文件名摘要保持不变）
  fx.fs.seed(`/sandbox/${put.relativePath}`, '被篡改的内容');

  const report = await runStartupRecovery(
    { blobRepository: fx.blobs, blobCas: fx.blobCas, logger: fx.logger },
    { verifyHash: true },
  );
  assert.deepEqual(report.mismatched, [put.sha256]);
  assert.ok(fx.logger.has('startup_recovery_integrity_incident'));
});
