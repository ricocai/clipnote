/**
 * 备份/恢复入口编排内核（WHY-131 条件 A；设计 §4.2「可恢复备份」）。
 *
 * WHY-104 V0.1 验收问题清单第 1 条：BackupService 全仓库无 entry 调用方，真机上
 * 用户不可触发备份/恢复。本内核把「打包→交接」「选包→拷入沙箱→恢复」两段流程
 * 做成平台无关的薄编排，设置页（.ets，含 @kit.*）只做按钮接线；
 * 本机用例注入内存/假实现驱动同一源码（tools/test/backup-entry.test.ts）。
 *
 * 恢复纪律（不得破坏）：
 *  - 一律走既有 BackupService.restoreBackup 的「先校验→暂存→单事务原子替换」
 *    路径，本层不新造任何恢复逻辑（manifest 解析/dryRun/事务都在 BackupService 内）；
 *  - 用户经系统选择器选中的包在沙箱外（content URI），恢复协议只认沙箱内路径，
 *    因此先由平台适配器原样拷贝进 backups/ 再交给 BackupService；
 *  - 取消选择不是错误（cancelled 与 failed 区分，UI 不得把取消渲染成失败）。
 */

import {
  BackupExportResult,
  BackupService,
  ILogger,
  LogLevel,
  RestoreResult,
} from 'common';

export interface BackupEntryDeps {
  /** BackupService 提供者（AppServices 注入；数据层就绪后才可装配） */
  readonly backup: () => Promise<BackupService>;
  /** 拉起系统分享面板交接备份包；返回值只表示面板是否成功拉起 */
  readonly shareBackupZip: (zipPath: string, displayName: string) => Promise<boolean>;
  /** 系统文件选择器：让用户挑一个备份 ZIP；取消返回 undefined */
  readonly pickBackupZip: () => Promise<string | undefined>;
  /**
   * 把选择器返回的（沙箱外）URI 原样拷进沙箱 backups/ 下，返回沙箱绝对路径。
   * 字节级原样搬运，不得经文本解码（备份包内 blob 可能是任意二进制）。
   */
  readonly copyPickedZipIntoBackups: (sourceUri: string) => Promise<string>;
  readonly logger: ILogger;
}

/** 备份结果（shared=false 时备份包仍在 backups/ 下，备份事实不依赖面板行为） */
export interface BackupExportOutcome {
  readonly zipPath: string;
  readonly noteCount: number;
  readonly blobCount: number;
  readonly totalBytes: number;
  readonly shared: boolean;
}

/** 恢复结果三态：取消 / 成功（计数）/ 被恢复协议拒绝（当前数据未被改动） */
export type RestoreOutcome =
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'restored';
      readonly notes: number;
      readonly blobs: number;
      readonly attachments: number;
      readonly tags: number;
    }
  | { readonly kind: 'failed'; readonly detail: string };

export class BackupEntryCore {
  constructor(private readonly deps: BackupEntryDeps) {}

  /** 立即备份：打包 → 系统分享面板交接（导出 ≠ 备份的文案在 UI 层） */
  async exportAndShare(): Promise<BackupExportOutcome> {
    const result: BackupExportResult = await (await this.deps.backup()).exportBackup();
    const name: string = result.zipPath.slice(result.zipPath.lastIndexOf('/') + 1);
    const shared: boolean = await this.deps.shareBackupZip(result.zipPath, name);
    this.deps.logger.log(LogLevel.INFO, 'backup_entry_exported', {
      notes: result.noteCount,
      blobs: result.blobCount,
      bytes: result.totalBytes,
      shared,
    });
    return {
      zipPath: result.zipPath,
      noteCount: result.noteCount,
      blobCount: result.blobCount,
      totalBytes: result.totalBytes,
      shared,
    };
  }

  /**
   * 选包恢复：选择器 → 拷入沙箱 → BackupService.restoreBackup。
   * 校验拒绝（ok=false）收敛为 failed 并带 issue 码摘要；真异常上抛由 UI 如实提示。
   */
  async pickAndRestore(): Promise<RestoreOutcome> {
    const picked: string | undefined = await this.deps.pickBackupZip();
    if (picked === undefined) {
      return { kind: 'cancelled' };
    }
    const sandboxPath: string = await this.deps.copyPickedZipIntoBackups(picked);
    const result: RestoreResult = await (await this.deps.backup()).restoreBackup(sandboxPath);
    if (!result.ok || result.restored === undefined) {
      const detail: string = result.issues.map((i) => i.code).join('、') || 'unknown';
      this.deps.logger.log(LogLevel.WARN, 'backup_entry_restore_rejected', { detail });
      return { kind: 'failed', detail };
    }
    this.deps.logger.log(LogLevel.INFO, 'backup_entry_restored', { ...result.restored });
    return { kind: 'restored', ...result.restored };
  }
}
