/**
 * 备份/恢复入口接线层本机用例（WHY-131 条件 A；WHY-104 验收问题清单第 1 条）。
 *
 * 验收 grep 曾验证「BackupService 全仓库无 entry 调用方」导致真机不可触发备份/恢复。
 * 本文件钉住两层事实：
 *
 *  1. 行为层：交付源码 BackupEntryCore（与 hvigor 编译同一文件）注入内存平台假实现
 *     驱动 —— 打包→交接、选包→拷入沙箱→restoreBackup 既有原子替换路径、
 *     取消/校验拒绝的诚实降级（取消 ≠ 失败，拒绝不改动现有数据）；
 *  2. 接线层：设置页/AppServices 确实接上了入口（源码断言，防止再次「无调用方」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { BackupService } from '../../common/src/main/ets/core/backup-service';
import { NoteSource } from '../../common/src/main/ets/core/model';
import {
  BackupEntryCore,
  BackupEntryDeps,
  BackupExportOutcome,
  RestoreOutcome,
} from '../../entry/src/main/ets/services/BackupEntryCore';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import {
  CapturingLogger,
  FixedClock,
  MemoryFileStore,
  NodeHasher,
  SequentialRandom,
} from './support/platform';

const BASE_MS = 1_759_000_000_000;
const ROOT = '/test-files';

interface Fixture {
  db: NodeSqliteExecutor;
  notes: NoteRepository;
  backup: BackupService;
  fs: MemoryFileStore;
  shared: { path: string; name: string }[];
  /** 选择器返回值队列（undefined = 用户取消） */
  pickQueue: Array<string | undefined>;
  copyCalls: string[];
  core: BackupEntryCore;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const fs = new MemoryFileStore();
  const notes = new NoteRepository({
    db,
    clock: new FixedClock(BASE_MS),
    random: new SequentialRandom(),
    logger,
  });
  const backup = new BackupService({
    db,
    fs,
    hasher: new NodeHasher(),
    clock: new FixedClock(BASE_MS),
    random: new SequentialRandom(),
    logger,
    root: ROOT,
    appVersion: '0.1.0-test',
  });
  const f = {
    db,
    notes,
    backup,
    fs,
    shared: [] as { path: string; name: string }[],
    pickQueue: [] as Array<string | undefined>,
    copyCalls: [] as string[],
    core: undefined as unknown as BackupEntryCore,
  };
  const deps: BackupEntryDeps = {
    backup: async () => backup,
    shareBackupZip: async (zipPath: string, name: string): Promise<boolean> => {
      f.shared.push({ path: zipPath, name });
      return true;
    },
    pickBackupZip: async (): Promise<string | undefined> => f.pickQueue.shift(),
    copyPickedZipIntoBackups: async (sourceUri: string): Promise<string> => {
      // 平台拷贝假实现：URI 字节原样进沙箱 backups/（与 BackupEntry.ets 同一口径）
      f.copyCalls.push(sourceUri);
      const dest = `${ROOT}/backups/picked-test.zip`;
      await fs.mkdirp(`${ROOT}/backups`);
      await fs.writeRawBytes(dest, await fs.readBytes(sourceUri));
      return dest;
    },
    logger,
  };
  f.core = new BackupEntryCore(deps);
  return f;
}

test('立即备份：打包落盘 backups/ 并经分享面板交接（面板口径独立记录）', async () => {
  const f = await makeFixture();
  await f.notes.create({ title: '甲', contentMd: '内容甲', source: NoteSource.MANUAL });
  await f.notes.create({ title: '乙', contentMd: '内容乙', source: NoteSource.MANUAL });

  const outcome: BackupExportOutcome = await f.core.exportAndShare();

  assert.equal(outcome.noteCount, 2);
  assert.equal(outcome.shared, true);
  assert.ok(outcome.zipPath.startsWith(`${ROOT}/backups/clipnote-backup-`), outcome.zipPath);
  assert.ok(outcome.totalBytes > 0);
  assert.deepEqual(f.shared, [{
    path: outcome.zipPath,
    name: outcome.zipPath.slice(outcome.zipPath.lastIndexOf('/') + 1),
  }]);
});

test('选包恢复：选包→拷入沙箱→restoreBackup 原子替换，数据整体还原', async () => {
  const f = await makeFixture();
  const note = await f.notes.create({ title: '原始', contentMd: '恢复前内容', source: NoteSource.MANUAL });
  const exported = await f.backup.exportBackup();

  // 破坏性改动：污染原笔记 + 新增噪声 —— 恢复后必须整体还原
  await f.notes.update(note.id, '被污染', '已污染正文');
  const noise = await f.notes.create({ title: '噪声', contentMd: '不应存在', source: NoteSource.MANUAL });

  f.pickQueue.push(exported.zipPath);
  const outcome: RestoreOutcome = await f.core.pickAndRestore();

  assert.equal(outcome.kind, 'restored');
  if (outcome.kind === 'restored') {
    assert.equal(outcome.notes, 1);
    assert.equal(outcome.tags, 0);
  }
  assert.deepEqual(f.copyCalls, [exported.zipPath]);
  const restored = await f.notes.getById(note.id);
  assert.equal(restored?.title, '原始');
  assert.equal(restored?.contentMd, '恢复前内容');
  assert.equal(await f.notes.getById(noise.id), undefined);
});

test('取消选择不是错误：cancelled 且不触发拷贝', async () => {
  const f = await makeFixture();
  f.pickQueue.push(undefined);
  const outcome: RestoreOutcome = await f.core.pickAndRestore();
  assert.deepEqual(outcome, { kind: 'cancelled' });
  assert.deepEqual(f.copyCalls, []);
});

test('非法备份包被恢复协议拒绝：failed 带 issue 码，现有数据未被改动', async () => {
  const f = await makeFixture();
  const note = await f.notes.create({ title: '存量', contentMd: '恢复前内容', source: NoteSource.MANUAL });
  const fakeZip = `${ROOT}/backups/not-a-backup.zip`;
  await f.fs.mkdirp(`${ROOT}/backups`);
  await f.fs.writeRawBytes(fakeZip, new Uint8Array([1, 2, 3, 4]));

  f.pickQueue.push(fakeZip);
  const outcome: RestoreOutcome = await f.core.pickAndRestore();

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind === 'failed') {
    assert.ok(outcome.detail.length > 0, outcome.detail);
  }
  const after = await f.notes.getById(note.id);
  assert.equal(after?.contentMd, '恢复前内容');
});

test('接线层：设置页/AppServices 已接 BackupEntry，恢复只走 BackupService.restoreBackup', () => {
  const read = (rel: string): string =>
    fsSync.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf8');
  const settings = read('entry/src/main/ets/pages/Settings.ets');
  const appServices = read('entry/src/main/ets/services/AppServices.ets');
  const core = read('entry/src/main/ets/services/BackupEntryCore.ts');
  const adapter = read('entry/src/main/ets/services/BackupEntry.ets');

  // 设置页存在备份/恢复两个入口，且接线到 AppServices.backupEntry()
  assert.ok(settings.includes('立即备份（生成可恢复备份包）'), '设置页缺备份入口');
  assert.ok(settings.includes('从备份包恢复'), '设置页缺恢复入口');
  assert.ok(settings.includes('backupEntry().exportAndShare()'), '备份未接线到 backupEntry');
  assert.ok(settings.includes('backupEntry().pickAndRestore()'), '恢复未接线到 backupEntry');
  assert.ok(settings.includes('不是导出'), '导出 ≠ 备份文案缺失（V1.4 F06）');

  // 装配层经 AppDataRuntime.getBackupService 取既有服务（不新造 BackupService）
  assert.ok(appServices.includes('backupEntry()'), 'AppServices 未暴露 backupEntry');
  assert.ok(appServices.includes('getBackupService('), '未复用既有 BackupService 装配');

  // 恢复语义只有一份：编排内核调 restoreBackup，平台适配层不碰 manifest/恢复逻辑
  assert.ok(core.includes('restoreBackup('), 'BackupEntryCore 未走 restoreBackup');
  assert.ok(!adapter.includes('restoreBackup('), '平台适配层不得内联恢复逻辑');
});
