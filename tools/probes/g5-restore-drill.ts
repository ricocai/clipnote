/**
 * G5 恢复演练（S4-1；设计 §8 G5「数据恢复」阻断性门槛）。
 *
 * 演练口径（G5 原文）：
 *   「各保存阶段杀进程、磁盘满、共享附件、备份恢复 →
 *     已确认保存的数据可恢复；无被引用但缺失的文件；恢复后内容与关系一致」
 *
 * 本脚本覆盖其中的"备份恢复 × 各阶段杀进程"：
 *   - 父进程编排：建源库 → 导出备份包 → 对恢复的**每个阶段边界**各起一个子进程，
 *     子进程在该阶段用 SIGKILL 自杀（真实的进程被杀，不是异常模拟）；
 *   - 每个杀灭点后，父进程重开目标库验证不变量：
 *     ① 启动恢复扫描（verifyHash）必须干净：无"被引用但缺失"、无摘要不符；
 *     ② 库要么完整保持旧数据、要么完整等于备份内容 —— 不存在半新半旧；
 *     ③ 重跑恢复可收敛到备份内容，扫描依然干净；
 *   - 导出侧同样演练（杀进程不得损坏源数据、不得留下"看似完成"的坏包）。
 *
 * 事务中途被杀的场景由 SQLite 日志恢复承载：子进程在 BEGIN 与 COMMIT 之间被杀，
 * 父进程重开库时由 SQLite 自动回滚 —— 这正是要验证的行为。
 *
 * 用法：npm run drill:g5（产物在 tools/.g5-tmp/，报告写入 tools/report/g5-restore-drill.md）
 */

import { execFile } from 'node:child_process';
import * as fss from 'node:fs';
import * as path from 'node:path';

import { BackupService, RestorePhase, ExportPhase } from '../../common/src/main/ets/core/backup-service';
import { readZip } from '../../common/src/main/ets/core/zip';
import { AttachmentRole, BlobStatus, Note, NoteSource } from '../../common/src/main/ets/core/model';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { BackupRepository, BackupSnapshot } from '../../common/src/main/ets/core/data/backup-repository';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { StartupRecoveryReport, runStartupRecovery } from '../../common/src/main/ets/core/data/recovery';
import { BlobCas } from '../../common/src/main/ets/core/blob-cas';
import { CapturingLogger, NodeFileStore, NodeHasher, SequentialRandom } from '../test/support/platform';
import { NodeSqliteExecutor } from '../test/support/sqlite-executor';
import { IClock } from '../../common/src/main/ets/core/ports';

// 编译产物在 dist/tools/probes/ 下；向上三级回到真实 tools/ 目录
const TOOLS_DIR: string = path.resolve(__dirname, '..', '..', '..');
const WORK_ROOT: string = path.join(TOOLS_DIR, '.g5-tmp');
const REPORT_PATH: string = path.join(TOOLS_DIR, 'report', 'g5-restore-drill.md');

class SystemClock implements IClock {
  nowMs(): number {
    return Date.now();
  }
}

interface World {
  dir: string;
  executor: NodeSqliteExecutor;
  service: BackupService;
  notes: NoteRepository;
  blobs: BlobRepository;
  cas: BlobCas;
  logger: CapturingLogger;
}

function dbPathOf(dir: string): string {
  return path.join(dir, 'db', 'clipnote.rdb');
}

function filesRootOf(dir: string): string {
  return path.join(dir, 'files');
}

async function openWorld(dir: string): Promise<World> {
  fss.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fss.mkdirSync(filesRootOf(dir), { recursive: true });
  const executor = NodeSqliteExecutor.openFile(dbPathOf(dir));
  const logger = new CapturingLogger();
  await new SchemaMigrator(executor, logger).migrate();
  const clock = new SystemClock();
  const random = new SequentialRandom();
  const hasher = new NodeHasher();
  const fsStore = new NodeFileStore();
  const cas = new BlobCas(filesRootOf(dir), fsStore, hasher, logger, random);
  const notes = new NoteRepository({ db: executor, clock, random, logger });
  const blobs = new BlobRepository({ db: executor, logger });
  const service = new BackupService({
    db: executor,
    fs: fsStore,
    hasher,
    clock,
    random,
    logger,
    root: filesRootOf(dir),
    appVersion: '0.1.0-drill',
  });
  return { dir, executor, service, notes, blobs, cas, logger };
}

async function seedNote(w: World, title: string, blobText?: string): Promise<string> {
  const note: Note = await w.notes.create({ title, contentMd: `# ${title}\n\n${title} 正文`, source: NoteSource.CLIPBOARD });
  await w.notes.addTag(note.id, '演练');
  if (blobText !== undefined) {
    const put = await w.cas.put(blobText);
    await w.blobs.saveRecord({
      sha256: put.sha256,
      relativePath: put.relativePath,
      mime: 'image/png',
      size: put.size,
      status: BlobStatus.REFERENCED,
    });
    await w.blobs.attach(note.id, put.sha256, AttachmentRole.INLINE_IMAGE, 0);
  }
  return note.id;
}

/** 规范化快照（排序后序列化），用于"逐字段一致"比对 */
function canonical(s: BackupSnapshot): string {
  const by = <T>(arr: readonly T[], key: (x: T) => string): T[] =>
    arr.slice().sort((a: T, b: T) => (key(a) < key(b) ? -1 : 1));
  return JSON.stringify({
    notes: by(s.notes, (n) => n.id),
    tags: by(s.tags, (t) => t.id),
    noteTags: by(s.noteTags, (p) => `${p.noteId}/${p.tagId}`),
    blobs: by(s.blobs, (b) => b.sha256),
    noteAttachments: by(s.noteAttachments, (a) => `${a.noteId}/${a.blobSha256}/${a.role}`),
  });
}

async function snapshotCanonical(dir: string): Promise<string> {
  const w = await openWorld(dir);
  try {
    return canonical(await new BackupRepository(w.executor).snapshot());
  } finally {
    w.executor.close();
  }
}

interface RecoveryCheck {
  readonly clean: boolean;
  readonly missing: number;
  readonly mismatched: number;
}

async function recoveryCheck(dir: string): Promise<RecoveryCheck> {
  const w = await openWorld(dir);
  try {
    const report: StartupRecoveryReport = await runStartupRecovery(
      { blobRepository: w.blobs, blobCas: w.cas, logger: w.logger },
      { verifyHash: true },
    );
    return { clean: report.missing.length === 0 && report.mismatched.length === 0, missing: report.missing.length, mismatched: report.mismatched.length };
  } finally {
    w.executor.close();
  }
}

interface KillRun {
  readonly signal: string | null;
  readonly code: number | null;
}

function runChild(args: string[]): Promise<KillRun> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-sqlite', __filename.replace(/\.ts$/, '.js'), 'child', ...args],
      { timeout: 60000 },
      (error) => {
        // 被杀的子进程：error 非空且带 signal；正常退出 error 为空。其余为真实失败。
        const err = error as { signal?: string | null; code?: number | null } | null;
        if (err !== null && err.signal === undefined) {
          reject(error);
          return;
        }
        resolve({ signal: err?.signal ?? null, code: err?.code ?? null });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 子进程：执行恢复/导出并在指定阶段 SIGKILL 自杀
// ---------------------------------------------------------------------------

async function childMain(): Promise<void> {
  const args: string[] = process.argv.slice(3);
  const get = (name: string): string => {
    const i: number = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) {
      throw new Error(`missing arg ${name}`);
    }
    return args[i + 1];
  };
  const mode: string = get('--mode');
  const target: string = get('--target');
  const killAt: string = get('--kill-at');
  const w = await openWorld(target);

  const suicide = (): void => {
    process.kill(process.pid, 'SIGKILL');
    // 兜底：SIGKILL 不可阻挡，这里只为类型完整
    throw new Error('unreachable');
  };

  if (mode === 'restore') {
    const zipPath: string = get('--zip');
    await w.service.restoreBackup(zipPath, {
      onPhase: (phase: RestorePhase) => {
        if (phase === killAt) {
          suicide();
        }
        return Promise.resolve();
      },
    });
  } else if (mode === 'export') {
    await w.service.exportBackup({
      onPhase: (phase: ExportPhase) => {
        if (phase === killAt) {
          suicide();
        }
        return Promise.resolve();
      },
    });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 父进程：编排与裁决
// ---------------------------------------------------------------------------

const RESTORE_KILL_POINTS: RestorePhase[] = ['staged', 'validated', 'blobs-staged', 'tx-open', 'tx-written', 'db-replaced', 'scanned'];
const EXPORT_KILL_POINTS: ExportPhase[] = ['staged', 'zip-built', 'zip-written'];

interface DrillRow {
  readonly scenario: string;
  readonly killed: boolean;
  readonly recoveryClean: boolean;
  readonly state: string;
  readonly converged: boolean;
}

async function parentMain(): Promise<void> {
  fss.rmSync(WORK_ROOT, { recursive: true, force: true });
  fss.mkdirSync(WORK_ROOT, { recursive: true });

  // 1. 源库：两条笔记 + 标签 + 两个附件
  const srcDir: string = path.join(WORK_ROOT, 'src');
  const src = await openWorld(srcDir);
  await seedNote(src, '季度复盘', 'png-bytes-复盘-封面');
  await seedNote(src, '读书笔记：分布式系统', 'png-bytes-书摘插图');
  const srcSnapshot: string = canonical(await new BackupRepository(src.executor).snapshot());
  const exported = await src.service.exportBackup();
  src.executor.close();
  const zipBytes: Uint8Array = fss.readFileSync(exported.zipPath);
  const zipPathShared: string = path.join(WORK_ROOT, 'shared-backup.zip');
  fss.writeFileSync(zipPathShared, zipBytes);

  const rows: DrillRow[] = [];
  let failures: number = 0;

  // 2. 恢复 × 每个阶段杀进程
  for (const phase of RESTORE_KILL_POINTS) {
    const target: string = path.join(WORK_ROOT, `restore-${phase}`);
    // 目标库先放一份"旧数据"（与备份不同），用于验证原子替换
    const tw = await openWorld(target);
    await seedNote(tw, `旧数据-${phase}`, `old-blob-${phase}`);
    const oldSnapshot: string = canonical(await new BackupRepository(tw.executor).snapshot());
    tw.executor.close();

    const run: KillRun = await runChild(['--mode', 'restore', '--target', target, '--zip', zipPathShared, '--kill-at', phase]);
    const killed: boolean = run.signal === 'SIGKILL';

    // 验证 ① 恢复扫描干净（进程重开，等价于 App 重启）
    const check: RecoveryCheck = await recoveryCheck(target);
    // 验证 ② 状态二选一：完整旧数据 XOR 完整备份内容
    const nowSnapshot: string = await snapshotCanonical(target);
    const intact: boolean = nowSnapshot === oldSnapshot;
    const replaced: boolean = nowSnapshot === srcSnapshot;
    const stateOk: boolean = intact !== replaced; // 恰好其一
    const state: string = intact ? '旧数据完整保留' : replaced ? '已完整替换为备份' : '!!! 半新半旧';

    // 验证 ③ 重跑恢复收敛到备份内容
    const cw = await openWorld(target);
    const redo = await cw.service.restoreBackup(zipPathShared);
    const redoSnapshot: string = canonical(await new BackupRepository(cw.executor).snapshot());
    cw.executor.close();
    const converged: boolean = redo.ok && redoSnapshot === srcSnapshot;

    const ok: boolean = killed && check.clean && stateOk && converged;
    if (!ok) {
      failures++;
    }
    rows.push({ scenario: `恢复 @ ${phase}`, killed, recoveryClean: check.clean, state, converged });
  }

  // 3. 导出 × 每个阶段杀进程：源数据不得受损，最终包要么不存在要么合法
  for (const phase of EXPORT_KILL_POINTS) {
    const srcCopy: string = path.join(WORK_ROOT, `export-${phase}`);
    fss.cpSync(srcDir, srcCopy, { recursive: true });
    const run: KillRun = await runChild(['--mode', 'export', '--target', srcCopy, '--kill-at', phase]);
    const killed: boolean = run.signal === 'SIGKILL';

    const check: RecoveryCheck = await recoveryCheck(srcCopy);
    const nowSnapshot: string = await snapshotCanonical(srcCopy);
    const intact: boolean = nowSnapshot === srcSnapshot;

    // 重跑导出必须成功（顺带清扫被杀留下的暂存目录）
    const ew = await openWorld(srcCopy);
    const redo = await ew.service.exportBackup();
    const redoZip: Uint8Array = fss.readFileSync(redo.zipPath);
    const redoValid: boolean = readZip(redoZip).ok;
    ew.executor.close();

    const ok: boolean = killed && check.clean && intact && redoValid;
    if (!ok) {
      failures++;
    }
    rows.push({ scenario: `导出 @ ${phase}`, killed, recoveryClean: check.clean, state: intact ? '源数据未受损' : '!!! 源数据被改动', converged: redoValid });
  }

  // 4. 报告
  const lines: string[] = [];
  lines.push('# G5 恢复演练报告（备份恢复 × 各阶段杀进程）');
  lines.push('');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 方法：每个阶段边界起独立子进程执行恢复/导出，并用 SIGKILL 真实杀进程；`);
  lines.push(`  父进程重开库验证：启动恢复扫描（verifyHash）干净、库状态二选一（旧数据完整 XOR 备份完整）、重跑可收敛。`);
  lines.push(`- 结论：**${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}**`);
  lines.push('');
  lines.push('| 场景 | 进程确实被杀 | 恢复扫描干净 | 状态裁决 | 重跑收敛 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${r.scenario} | ${r.killed ? '是' : '否'} | ${r.recoveryClean ? '是' : '否'} | ${r.state} | ${r.converged ? '是' : '否'} |`);
  }
  lines.push('');
  fss.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fss.writeFileSync(REPORT_PATH, lines.join('\n'));

  console.log(lines.join('\n'));
  if (failures > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------

const argv: string[] = process.argv.slice(2);
if (argv[0] === 'child') {
  childMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
} else {
  parentMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
