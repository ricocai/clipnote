/**
 * 启动恢复扫描（设计 §4.2「附件写入与恢复协议」第 2 条）。
 *
 * 原子写入协议的另一半：写入侧保证"文件先落地、引用后提交"，所以进程被杀的
 * 最坏结果是孤儿文件；本函数在 App 启动时收口这类残留：
 *
 *  1. 以 note_attachment 为引用事实源，核对磁盘 blob 文件；
 *  2. 临时残留（`.tmp-*`）由 BlobCas.reconcile 顺带清理；
 *  3. 孤儿（盘上有、无引用）→ blob.status 置 orphan_grace，进入 GC 宽限期，
 *     **宁可留孤儿，绝不删被引用文件**；
 *  4. 被引用但文件缺失 / 摘要不符 → 记 ERROR 级完整性事故并如实上报，
 *     不做任何自动修复（修不了：文件已经没了；这是 G5 的阻断项）。
 */

import { BlobSha256, BlobStatus } from '../model';
import { BlobReconcileReport, ILogger, LogLevel } from '../ports';
import { BlobCas } from '../blob-cas';
import { BlobRepository } from './blob-repository';

export interface StartupRecoveryDeps {
  readonly blobRepository: BlobRepository;
  readonly blobCas: BlobCas;
  readonly logger: ILogger;
}

export interface StartupRecoveryOptions {
  /** 逐文件重算摘要（代价高；G5 恢复演练开启，常规启动关闭） */
  readonly verifyHash?: boolean;
}

export interface StartupRecoveryReport {
  /** 被引用但文件缺失；非空即完整性事故 */
  readonly missing: readonly BlobSha256[];
  /** 摘要不符（仅 verifyHash=true 时可能非空） */
  readonly mismatched: readonly BlobSha256[];
  /** 扫描到的 blob 文件数 */
  readonly scanned: number;
  /** 本次被标记为 GC 宽限期的孤儿数 */
  readonly orphansMarkedGrace: number;
}

export async function runStartupRecovery(
  deps: StartupRecoveryDeps,
  options?: StartupRecoveryOptions,
): Promise<StartupRecoveryReport> {
  const verifyHash: boolean = options !== undefined && options.verifyHash === true;

  const referencedShas: BlobSha256[] = await deps.blobRepository.listReferencedShas();
  const referenced: Set<string> = new Set<string>(referencedShas);

  const report: BlobReconcileReport = await deps.blobCas.reconcile(referenced, {
    verifyHash,
    removeTempArtifacts: true,
  });

  let marked: number = 0;
  for (let i: number = 0; i < report.orphans.length; i++) {
    const sha: BlobSha256 = report.orphans[i];
    const record = await deps.blobRepository.get(sha);
    if (record !== undefined && record.status !== BlobStatus.ORPHAN_GRACE) {
      await deps.blobRepository.markStatus(sha, BlobStatus.ORPHAN_GRACE);
      marked++;
    }
  }

  if (report.missing.length > 0 || report.mismatched.length > 0) {
    // 完整性事故：只记摘要，不记内容（审计口径 §4.5.5）
    deps.logger.log(LogLevel.ERROR, 'startup_recovery_integrity_incident', {
      missing: report.missing.length,
      mismatched: report.mismatched.length,
    });
  }
  deps.logger.log(LogLevel.INFO, 'startup_recovery_done', {
    scanned: report.scanned,
    orphansMarkedGrace: marked,
    missing: report.missing.length,
    mismatched: report.mismatched.length,
  });

  return {
    missing: report.missing,
    mismatched: report.mismatched,
    scanned: report.scanned,
    orphansMarkedGrace: marked,
  };
}
