import { common } from '@kit.AbilityKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { fileIo, fileUri, picker } from '@kit.CoreFileKit';
import { systemShare } from '@kit.ShareKit';
import {
  AppContextHolder,
  BackupService,
  CryptoRandom,
  HilogLogger,
  SandboxFileStore,
  toHex,
} from 'common';
import {
  BackupEntryCore,
  BackupExportOutcome,
  RestoreOutcome,
} from './BackupEntryCore';

/**
 * 备份/恢复入口（WHY-131 条件 A）：Harmony 适配 + 设置页接线面。
 *
 * 薄包装 —— 全部可测逻辑在平台无关的 BackupEntryCore（本机用例覆盖），
 * 本类只做三件平台相关的事：
 *  1. 系统文件选择器（DocumentViewPicker）让用户挑选备份 ZIP（只接受 .zip）；
 *  2. 把选中的（沙箱外）content URI 字节级原样拷进沙箱 backups/ 再交给恢复协议
 *     （备份包内 blob 可能是任意二进制，绝不经过文本解码）；
 *  3. 备份包经系统分享面板交接保存（与可读导出同一 Share Kit 通道，但描述文案
 *     区分「可恢复备份」——分享面板上的导出/备份口径不能互相误导）。
 *
 * 平台 API 编译口径声明（同 system-share.ets 纪律）：本文件未经设备编译，
 * 按 API 12（5.0.0(12)）Core File Kit / Share Kit 文档口径编写；
 * 真机编译若遇签名差异，以 SDK 报错为准修正。
 */

export interface BackupEntryDeps {
  readonly random: CryptoRandom;
  readonly logger: HilogLogger;
  /** BackupService 提供者（AppServices 注入；避免与 AppServices 模块循环依赖） */
  readonly backup: () => Promise<BackupService>;
}

/** 备份交接面板的描述文案（与可读导出的「非备份」文案区分，V1.4 F06） */
const BACKUP_SHARE_DESCRIPTION: string =
  'ClipNote 拾记 · 可恢复备份包（含清单与校验信息，可用于恢复，不是给人读的导出）';

const COPY_BUFFER_BYTES: number = 1024 * 1024;

export class BackupEntry {
  private core: BackupEntryCore | undefined = undefined;

  constructor(private readonly deps: BackupEntryDeps) {}

  /** 立即备份：打包 → 系统分享面板交接 */
  exportAndShare(): Promise<BackupExportOutcome> {
    return this.ensureCore().exportAndShare();
  }

  /** 选包恢复：选择器 → 拷入沙箱 → BackupService 既有原子替换路径 */
  pickAndRestore(): Promise<RestoreOutcome> {
    return this.ensureCore().pickAndRestore();
  }

  private ensureCore(): BackupEntryCore {
    if (this.core === undefined) {
      this.core = new BackupEntryCore({
        backup: this.deps.backup,
        shareBackupZip: async (zipPath: string, displayName: string): Promise<boolean> => {
          const ctx = AppContextOrThrow();
          const data: systemShare.SharedData = new systemShare.SharedData({
            utd: utd.UniformDataType.ZIP,
            uri: fileUri.getUriFromPath(zipPath),
            title: displayName,
            description: BACKUP_SHARE_DESCRIPTION,
          });
          const controller: systemShare.ShareController = new systemShare.ShareController(data);
          await controller.show(ctx, {
            previewMode: systemShare.SharePreviewMode.DETAIL,
            selectionMode: systemShare.SelectionMode.SINGLE,
          });
          return true;
        },
        pickBackupZip: async (): Promise<string | undefined> => {
          const ctx = AppContextOrThrow();
          const dp: picker.DocumentViewPicker = new picker.DocumentViewPicker(ctx);
          const uris: string[] = await dp.select({
            selectMode: picker.SelectMode.FILE_MODE,
            fileSuffixFilters: ['.zip'],
          });
          return uris.length > 0 ? uris[0] : undefined;
        },
        copyPickedZipIntoBackups: (sourceUri: string): Promise<string> =>
          this.copyUriIntoBackups(sourceUri),
        logger: this.deps.logger,
      });
    }
    return this.core;
  }

  /**
   * URI → 沙箱 backups/ 的原样字节拷贝（备份包内 blob 可能是任意二进制，
   * 字节级搬运，绝不经过文本解码）。
   */
  private async copyUriIntoBackups(sourceUri: string): Promise<string> {
    const root: string = AppContextHolder.filesDir();
    const dir: string = `${root}/backups`;
    await new SandboxFileStore().mkdirp(dir);
    const name: string = `picked-${toHex(this.deps.random.nextBytes(4))}.zip`;
    const dest: string = `${dir}/${name}`;

    const src: fileIo.File = fileIo.openSync(sourceUri, fileIo.OpenMode.READ_ONLY);
    try {
      const dst: fileIo.File = fileIo.openSync(
        dest,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC,
      );
      try {
        const buffer: ArrayBuffer = new ArrayBuffer(COPY_BUFFER_BYTES);
        let read: number = fileIo.readSync(src.fd, buffer);
        while (read > 0) {
          fileIo.writeSync(dst.fd, buffer, { offset: 0, length: read });
          read = fileIo.readSync(src.fd, buffer);
        }
      } finally {
        fileIo.closeSync(dst);
      }
    } finally {
      fileIo.closeSync(src);
    }
    return dest;
  }
}

function AppContextOrThrow(): common.UIAbilityContext {
  const ctx = AppContextHolder.get();
  if (ctx === undefined) {
    throw new Error('备份/恢复不可用：应用上下文未就绪');
  }
  return ctx;
}
