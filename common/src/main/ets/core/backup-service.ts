/**
 * 备份打包 / 恢复端到端编排（S4-1；设计 §4.2「可恢复备份」与 §8 G5）。
 *
 * 打包协议（沙箱内暂存校验后才算完成）：
 *   快照 DB → manifest + blob 写入暂存目录 → 暂存自检（parseManifest + dryRun）
 *   → 构建 ZIP（STORE 模式，见 zip.ts）→ 原子落盘 → 回读 ZIP 再校验 → 清暂存
 *
 * 恢复协议（先校验暂存再导入，原子替换）：
 *   读 ZIP → readZip 结构校验（路径越界/超大解压/加密与压缩条目/CRC）
 *   → 解压到暂存目录 → parseManifest 语义校验（格式版本/字段黑名单/引用完整性）
 *   → dryRun + 逐 blob 摘要核对 → blob 进 CAS（内容寻址，崩溃最坏=孤儿文件）
 *   → 单事务整库替换（原子性的落点）→ 恢复扫描（verifyHash）→ 清暂存
 *
 * 崩溃安全论证（G5 演练验证，tools/probes/g5-restore-drill.ts）：
 *   - 事务提交前任何时刻被杀：DB 保持原状（SQLite 回滚/日志恢复），
 *     CAS 里多出的是内容寻址的孤儿文件，由启动恢复扫描收口；
 *   - 事务提交后被杀：库已是新数据，blob 文件先于引用落盘，引用完整；
 *   - 因此**不存在**"半新半旧"的可观察状态。
 *
 * 演练注入点：`RestoreHooks.onPhase` / `ExportHooks.onPhase` 仅用于 G5 恢复演练
 * 与故障注入测试在各阶段边界模拟进程被杀，正常路径不传。
 */

import {
  BackupManifest,
  MAX_RESTORE_TOTAL_BYTES,
  ParseResult,
  RestoreDryRun,
  RestoreIssue,
  buildManifest,
  dryRunRestore,
  parseManifest,
  serializeManifest,
} from './backup';
import { AtomicWriter, TEMP_SUFFIX_MARKER } from './atomicfs';
import { BlobCas } from './blob-cas';
import { utf8ByteLength, utf8Decode, utf8Encode, toHex } from './bytes';
import { CONTENT_SCHEMA_VERSION } from './model';
import { FileKind, IClock, IFileStore, IHasher, ILogger, IRandom, LogLevel } from './ports';
import { ZipEntryData, ZipEntryInput, ZipReadResult, buildZip, readZip } from './zip';
import { BackupRepository, BackupSnapshot } from './data/backup-repository';
import { IRdbExecutor } from './data/rdb';
import { BlobRepository } from './data/blob-repository';
import { StartupRecoveryReport, runStartupRecovery } from './data/recovery';

/** 备份包内条目命名空间：根下只允许 manifest.json，其余一律在 blobs/ 下 */
export const MANIFEST_ENTRY: string = 'manifest.json';
const BLOB_ENTRY_PREFIX: string = 'blobs/';

/** manifest.json 自身的解析上限（防清单本体撑爆内存） */
export const MAX_MANIFEST_BYTES: number = 64 * 1024 * 1024;

/** ZIP 容器开销的宽松上限（条目头 + 中央目录），用于读入前的快速拒绝 */
const ZIP_OVERHEAD_SLACK_BYTES: number = 16 * 1024 * 1024;

export type RestorePhase = 'staged' | 'validated' | 'blobs-staged' | 'tx-open' | 'tx-written' | 'db-replaced' | 'scanned';
export type ExportPhase = 'staged' | 'zip-built' | 'zip-written';

export interface RestoreHooks {
  onPhase?(phase: RestorePhase): Promise<void>;
}

export interface ExportHooks {
  onPhase?(phase: ExportPhase): Promise<void>;
}

export interface BackupServiceDeps {
  readonly db: IRdbExecutor;
  readonly fs: IFileStore;
  readonly hasher: IHasher;
  readonly clock: IClock;
  readonly random: IRandom;
  readonly logger: ILogger;
  /** 沙箱 files 根目录（blob CAS 与 backups/ 都挂在其下） */
  readonly root: string;
  readonly appVersion: string;
}

export interface BackupExportResult {
  readonly zipPath: string;
  readonly noteCount: number;
  readonly blobCount: number;
  readonly totalBytes: number;
}

export interface RestoreCounts {
  readonly notes: number;
  readonly blobs: number;
  readonly attachments: number;
  readonly tags: number;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly issues: RestoreIssue[];
  readonly restored?: RestoreCounts;
  /** 替换提交后的恢复扫描报告（verifyHash 开启，G5 口径） */
  readonly recovery?: StartupRecoveryReport;
}

export class BackupService {
  private readonly writer: AtomicWriter;
  private readonly repo: BackupRepository;
  private readonly cas: BlobCas;

  constructor(private readonly deps: BackupServiceDeps) {
    this.writer = new AtomicWriter(deps.fs, deps.random, deps.logger);
    this.repo = new BackupRepository(deps.db);
    this.cas = new BlobCas(deps.root, deps.fs, deps.hasher, deps.logger, deps.random);
  }

  // ---------------------------------------------------------------------------
  // 打包
  // ---------------------------------------------------------------------------

  async exportBackup(hooks?: ExportHooks): Promise<BackupExportResult> {
    const fs: IFileStore = this.deps.fs;
    const backupRoot: string = this.backupRoot();
    await fs.mkdirp(backupRoot);
    await this.sweepStaging();

    const snapshot: BackupSnapshot = await this.repo.snapshot();
    const manifest: BackupManifest = buildManifest({
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      appVersion: this.deps.appVersion,
      exportedAtMs: this.deps.clock.nowMs(),
      notes: snapshot.notes,
      tags: snapshot.tags,
      noteTags: snapshot.noteTags,
      blobs: snapshot.blobs,
      noteAttachments: snapshot.noteAttachments,
    });
    const manifestJson: string = serializeManifest(manifest);

    // 1. 暂存：manifest + 全部 blob 文件
    const staging: string = `${backupRoot}/export${TEMP_SUFFIX_MARKER}${toHex(this.deps.random.nextBytes(8))}`;
    try {
      await this.writer.write(`${staging}/${MANIFEST_ENTRY}`, manifestJson);
      for (let i: number = 0; i < manifest.blobs.length; i++) {
        const rel: string = manifest.blobs[i].relativePath;
        const content: string = await fs.readText(`${this.deps.root}/${rel}`);
        await this.writer.write(`${staging}/${rel}`, content);
      }
      await this.emitExport(hooks, 'staged');

      // 2. 暂存自检：校验的是落盘后的暂存，不是内存对象
      const stagedManifest: ParseResult = parseManifest(
        await fs.readText(`${staging}/${MANIFEST_ENTRY}`),
        CONTENT_SCHEMA_VERSION,
      );
      if (!stagedManifest.ok || stagedManifest.manifest === undefined) {
        throw new Error(`backup staging self-check failed: ${JSON.stringify(stagedManifest.issues)}`);
      }
      const dry: RestoreDryRun = await dryRunRestore(stagedManifest.manifest, fs, staging);
      if (!dry.ok) {
        throw new Error(`backup staging dry-run failed: missing=${dry.missingBlobs.length} mismatched=${dry.sizeMismatches.length}`);
      }

      // 3. 从暂存构建 ZIP（STORE 模式）
      const entries: ZipEntryInput[] = [];
      entries.push({ name: MANIFEST_ENTRY, data: utf8Encode(manifestJson) });
      for (let i: number = 0; i < manifest.blobs.length; i++) {
        const rel: string = manifest.blobs[i].relativePath;
        entries.push({ name: rel, data: utf8Encode(await fs.readText(`${staging}/${rel}`)) });
      }
      const zipBytes: Uint8Array = buildZip(entries);
      await this.emitExport(hooks, 'zip-built');

      // 4. 原子落盘 + 回读校验（只有校验通过的包才算完成）
      const zipPath: string = `${backupRoot}/clipnote-backup-${manifest.exportedAtMs}-${toHex(this.deps.random.nextBytes(4))}.zip`;
      await this.writer.writeBytes(zipPath, zipBytes);
      const written: ZipReadResult = readZip(await fs.readBytes(zipPath));
      if (!written.ok || written.entries.length !== entries.length) {
        await fs.remove(zipPath);
        throw new Error(`backup post-write verify failed: ${JSON.stringify(written.issues)}`);
      }
      await this.emitExport(hooks, 'zip-written');

      this.deps.logger.log(LogLevel.INFO, 'backup_export_done', {
        notes: manifest.notes.length,
        blobs: manifest.blobs.length,
        bytes: zipBytes.length,
      });
      return {
        zipPath,
        noteCount: manifest.notes.length,
        blobCount: manifest.blobs.length,
        totalBytes: zipBytes.length,
      };
    } finally {
      await this.removeTree(staging);
    }
  }

  // ---------------------------------------------------------------------------
  // 恢复
  // ---------------------------------------------------------------------------

  async restoreBackup(zipPath: string, hooks?: RestoreHooks): Promise<RestoreResult> {
    const fs: IFileStore = this.deps.fs;
    const issues: RestoreIssue[] = [];
    await fs.mkdirp(this.backupRoot());
    await this.sweepStaging();

    // 1. 结构校验（读入前先用文件大小快速拒绝明显超限的包）
    const zipStat = await fs.stat(zipPath);
    if (zipStat === undefined || zipStat.kind !== FileKind.FILE) {
      return this.reject(issues, 'zip_not_found', zipPath);
    }
    if (zipStat.size > MAX_RESTORE_TOTAL_BYTES + ZIP_OVERHEAD_SLACK_BYTES) {
      return this.reject(issues, 'total_too_large', `zip file ${zipStat.size} bytes`);
    }
    const zip: ZipReadResult = readZip(await fs.readBytes(zipPath));
    if (!zip.ok) {
      for (let i: number = 0; i < zip.issues.length; i++) {
        issues.push({ severity: 'error', code: zip.issues[i].code, detail: zip.issues[i].detail });
      }
      return this.reject(issues, 'zip_invalid', zipPath);
    }

    // 2. 解压到暂存（命名空间白名单：manifest.json + blobs/**）
    const staging: string = `${this.backupRoot()}/restore${TEMP_SUFFIX_MARKER}${toHex(this.deps.random.nextBytes(8))}`;
    try {
      let manifestText: string | undefined = undefined;
      for (let i: number = 0; i < zip.entries.length; i++) {
        const e: ZipEntryData = zip.entries[i];
        if (e.name === MANIFEST_ENTRY) {
          manifestText = utf8Decode(e.data);
        } else if (!e.name.startsWith(BLOB_ENTRY_PREFIX)) {
          return this.reject(issues, 'unexpected_entry', `entry "${e.name}" outside manifest/blobs namespace`);
        }
      }
      if (manifestText === undefined) {
        return this.reject(issues, 'manifest_missing', 'archive has no manifest.json');
      }
      if (utf8ByteLength(manifestText) > MAX_MANIFEST_BYTES) {
        return this.reject(issues, 'manifest_too_large', `${utf8ByteLength(manifestText)} bytes`);
      }
      for (let i: number = 0; i < zip.entries.length; i++) {
        const e: ZipEntryData = zip.entries[i];
        await this.writer.write(`${staging}/${e.name}`, utf8Decode(e.data));
      }
      await this.emit(hooks, 'staged');

      // 3. 语义校验：解析的是暂存落盘的 manifest（格式版本/字段黑名单/引用完整性在此拦截）
      const parsed: ParseResult = parseManifest(
        await fs.readText(`${staging}/${MANIFEST_ENTRY}`),
        CONTENT_SCHEMA_VERSION,
      );
      for (let i: number = 0; i < parsed.issues.length; i++) {
        issues.push(parsed.issues[i]);
      }
      if (!parsed.ok || parsed.manifest === undefined) {
        return this.reject(issues, 'manifest_invalid', 'see issues');
      }
      const manifest: BackupManifest = parsed.manifest;

      // 4. 导入前核对：存在性 + 大小 + 逐 blob 内容摘要（G5 口径）
      const dry: RestoreDryRun = await dryRunRestore(manifest, fs, staging);
      if (!dry.ok) {
        return this.reject(
          issues,
          'blob_precheck_failed',
          `missing=${dry.missingBlobs.length} mismatched=${dry.sizeMismatches.length}`,
        );
      }
      for (let i: number = 0; i < manifest.blobs.length; i++) {
        const rec = manifest.blobs[i];
        const content: string = await fs.readText(`${staging}/${rec.relativePath}`);
        const actual: string = await this.deps.hasher.sha256Hex(content);
        if (actual !== rec.sha256) {
          return this.reject(issues, 'blob_hash_mismatch', `blob ${rec.sha256.slice(0, 12)}… content digest mismatch`);
        }
      }
      await this.emit(hooks, 'validated');

      // 5. blob 进 CAS（文件先落地；内容寻址去重，被杀最坏=孤儿文件）
      for (let i: number = 0; i < manifest.blobs.length; i++) {
        const rec = manifest.blobs[i];
        if (!(await this.cas.exists(rec.sha256))) {
          await this.cas.put(await fs.readText(`${staging}/${rec.relativePath}`));
        }
      }
      await this.emit(hooks, 'blobs-staged');

      // 6. 单事务整库替换 —— 原子性的落点；崩溃由 SQLite 日志恢复兜底
      const db: IRdbExecutor = this.deps.db;
      await db.beginTransaction();
      try {
        await this.emit(hooks, 'tx-open');
        await this.repo.replaceAll(manifest);
        await this.emit(hooks, 'tx-written');
        await db.commit();
      } catch (err) {
        try {
          await db.rollback();
        } catch (rollbackErr) {
          // 回滚失败不掩盖原始错误（与 rdb.transact 同一口径）
        }
        throw err;
      }
      await this.emit(hooks, 'db-replaced');

      // 7. 恢复扫描（verifyHash 全量核对）—— 恢复完成的事实以这份报告为准
      const recovery: StartupRecoveryReport = await runStartupRecovery(
        { blobRepository: new BlobRepository({ db, logger: this.deps.logger }), blobCas: this.cas, logger: this.deps.logger },
        { verifyHash: true },
      );
      if (recovery.missing.length > 0 || recovery.mismatched.length > 0) {
        return this.reject(
          issues,
          'post_restore_integrity',
          `missing=${recovery.missing.length} mismatched=${recovery.mismatched.length}`,
        );
      }
      await this.emit(hooks, 'scanned');

      this.deps.logger.log(LogLevel.INFO, 'backup_restore_done', {
        notes: manifest.notes.length,
        blobs: manifest.blobs.length,
        tags: manifest.tags.length,
      });
      return {
        ok: true,
        issues,
        restored: {
          notes: manifest.notes.length,
          blobs: manifest.blobs.length,
          attachments: manifest.noteAttachments.length,
          tags: manifest.tags.length,
        },
        recovery,
      };
    } finally {
      await this.removeTree(staging);
    }
  }

  // ---------------------------------------------------------------------------

  private backupRoot(): string {
    return `${this.deps.root}/backups`;
  }

  /** 清理上次被杀留下的暂存目录（名字含 `.tmp-` 标记；与 blob 临时文件同一约定） */
  private async sweepStaging(): Promise<void> {
    const root: string = this.backupRoot();
    const names: string[] = await this.deps.fs.list(root);
    for (let i: number = 0; i < names.length; i++) {
      if (names[i].indexOf(TEMP_SUFFIX_MARKER) >= 0) {
        await this.removeTree(`${root}/${names[i]}`);
        this.deps.logger.log(LogLevel.INFO, 'backup_staging_swept', { name: names[i] });
      }
    }
  }

  private async removeTree(path: string): Promise<void> {
    const fs: IFileStore = this.deps.fs;
    const st = await fs.stat(path);
    if (st === undefined) {
      return;
    }
    if (st.kind === FileKind.DIR) {
      const names: string[] = await fs.list(path);
      for (let i: number = 0; i < names.length; i++) {
        await this.removeTree(`${path}/${names[i]}`);
      }
    }
    try {
      await fs.remove(path);
    } catch (err) {
      this.deps.logger.log(LogLevel.WARN, 'backup_cleanup_failed', { path, reason: String(err) });
    }
  }

  private reject(issues: RestoreIssue[], code: string, detail: string): RestoreResult {
    issues.push({ severity: 'error', code, detail });
    this.deps.logger.log(LogLevel.WARN, 'backup_restore_rejected', { code });
    return { ok: false, issues };
  }

  private async emit(hooks: RestoreHooks | undefined, phase: RestorePhase): Promise<void> {
    if (hooks !== undefined && hooks.onPhase !== undefined) {
      await hooks.onPhase(phase);
    }
  }

  private async emitExport(hooks: ExportHooks | undefined, phase: ExportPhase): Promise<void> {
    if (hooks !== undefined && hooks.onPhase !== undefined) {
      await hooks.onPhase(phase);
    }
  }
}
