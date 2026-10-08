import { common } from '@kit.AbilityKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { fileUri } from '@kit.CoreFileKit';
import { systemShare } from '@kit.ShareKit';

import { ShareHandoff } from '../core/ports';

/**
 * Share Kit 系统分享面板（S4-2「系统分享交接」）。
 *
 * 口径（设计 §4.4 数据交接）：
 *  - 沙箱路径不直接外发，先经 fileUri.getUriFromPath 转成 file:// URI，
 *    由系统分享面板向接收方授予临时读权限——应用自己不复制到公共目录；
 *  - 只拉起面板；用户在面板里选不选接收方、接收方存不存，都不回流本应用
 *    （导出事实以 ExportRecord 为准）。
 *
 * 平台 API 编译口径声明（同 G1/S3-2 纪律）：本文件未经设备编译，按 API 12
 * （5.0.0(12)）Share Kit 文档口径编写；真机编译若遇签名差异，以 SDK 报错为准修正。
 */
export class SystemShareHandoff implements ShareHandoff {
  private readonly context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  async shareFile(absPath: string, displayName: string): Promise<boolean> {
    const data: systemShare.SharedData = new systemShare.SharedData({
      utd: utd.UniformDataType.ZIP_ARCHIVE,
      uri: fileUri.getUriFromPath(absPath),
      title: displayName,
      description: 'ClipNote 拾记 · 可读导出包（非备份，不能用于恢复）',
    });
    const controller: systemShare.ShareController = new systemShare.ShareController(data);
    await controller.show(this.context, {
      previewMode: systemShare.SharePreviewMode.DETAIL,
      selectionMode: systemShare.SelectionMode.SINGLE,
    });
    return true;
  }

  /**
   * 纯文本分享（第二批 Feature 8）：单篇笔记 markdown 原文直接经系统分享面板交接，
   * 不落盘、不记导出记录——纯文本交接不是「导出产物」（设计口径：导出 ≠ 备份，
   * 分享 ≠ 导出）。attachment:// 链接由调用方先重写为 [图片] 占位再传入。
   */
  async shareText(title: string, text: string): Promise<boolean> {
    const data: systemShare.SharedData = new systemShare.SharedData({
      utd: utd.UniformDataType.PLAIN_TEXT,
      content: text,
      title,
      description: 'ClipNote 拾记 · 笔记分享',
    });
    const controller: systemShare.ShareController = new systemShare.ShareController(data);
    await controller.show(this.context, {
      previewMode: systemShare.SharePreviewMode.DETAIL,
      selectionMode: systemShare.SelectionMode.SINGLE,
    });
    return true;
  }
}
