import { router } from '@kit.ArkUI';
import {
  DevicePermissionStatus,
  ExportRecord,
  PasteboardPermissionState,
  PermissionStatusReport,
  describeExportRecord,
} from 'common';
import { AppServices } from '../services/AppServices';

/**
 * 设置页（S2-4 任务 3：权限状态区 + 能力边界说明）。
 *
 * 三条纪律：
 *  1. 状态展示 ≠ 安全判定。应用查得到/查不到的只是"系统记录"，且系统级剪贴板策略
 *     （设置 → 隐私和安全 → 剪贴板，默认"使用前每次询问"）应用看不到也改不了，
 *     文案必须如实说明这一点；
 *  2. "查不到"就写"查不到"，不得渲染成"未授权"误导用户；
 *  3. 能力边界文案是产品事实（设计 §4.1：UI 显示能力边界；普通定时器不当后台保障）：
 *     不后台采集、不回补历史、当前不使用通知。
 */

@Entry
@Component
struct Settings {
  @State pasteboardLine: string = '剪贴板读取：查询中…';
  @State notificationLine: string = '通知栏消息：查询中…';
  @State notice: string = '';
  /** 最近导出记录（S4-2；只读展示，元数据无正文） */
  @State exportLines: string[] = [];
  @State exporting: boolean = false;

  private readonly perm: DevicePermissionStatus = new DevicePermissionStatus();
  private readonly svc: AppServices = AppServices.get();

  aboutToAppear(): void {
    this.refresh();
    this.loadExportRecords();
  }

  /** 最近导出记录（设置页展示口径：每条一行，时间倒序，最多 5 条） */
  private async loadExportRecords(): Promise<void> {
    try {
      const svc = await this.svc.exportService();
      const records: ExportRecord[] = await svc.listRecords(5);
      this.exportLines = records.map((r: ExportRecord) => describeExportRecord(r));
    } catch (err) {
      // 数据层未就绪等场景：记录区留空即可，不伪装成"无导出历史"
      this.exportLines = [];
    }
  }

  /**
   * 全量可读导出（S4-2 设置页入口）：全部未删除笔记 + 附件打 ZIP，经系统分享面板交接。
   * 文案纪律（V1.4 F06）：这是**可读导出**，不是备份——不含恢复信息，不能用于恢复。
   */
  private async exportAll(): Promise<void> {
    if (this.exporting) {
      return;
    }
    this.exporting = true;
    try {
      const result = await this.svc.exportAndShare([], 'full');
      this.notice = result.unresolved.length > 0
        ? `已导出 ${result.record.noteCount} 篇。${result.unresolved.length} 个附件未能带上（链接保留原样）。`
        : `已导出 ${result.record.noteCount} 篇，正在拉起系统分享面板…`;
      await this.loadExportRecords();
    } catch (err) {
      this.notice = `导出失败：${String(err)}`;
    } finally {
      this.exporting = false;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const report: PermissionStatusReport = await this.perm.fetch();
      if (report.pasteboardState === PasteboardPermissionState.GRANTED) {
        this.pasteboardLine = '剪贴板读取权限：已授权（"直接读取"入口不弹窗；' +
          '"粘贴"安全控件本来就不需要这项权限）';
      } else if (report.pasteboardState === PasteboardPermissionState.DENIED) {
        this.pasteboardLine = '剪贴板读取权限：未授权（"直接读取"入口会触发系统弹窗或被拦截；' +
          '首选的"粘贴"安全控件不受影响）';
      } else {
        this.pasteboardLine = '剪贴板读取权限：状态查不到（系统接口限制，应用无法直接查询；这不等于"未授权"）';
      }
      if (!report.notificationKnown) {
        this.notificationLine = '通知栏消息：查不到（本应用当前不发送任何通知，此开关不影响任何功能）';
      } else if (report.notificationEnabled) {
        this.notificationLine = '通知栏消息：开（本应用当前不发送任何通知，无实际影响）';
      } else {
        this.notificationLine = '通知栏消息：关（本应用当前不发送任何通知，无实际影响）';
      }
    } catch (err) {
      this.pasteboardLine = '剪贴板读取权限：查不到（应用无查询权限；这不等于"未授权"）';
      this.notificationLine = '通知栏消息：查不到（本应用当前不发送任何通知）';
    }
  }

  private openSettings(): void {
    this.perm.openAppSettings().then((ok: boolean) => {
      if (!ok) {
        this.notice = '未能拉起系统设置。可自行前往：设置 → 应用管理 → 拾记 ClipNote（权限项）。';
      }
    });
  }

  build() {
    Column({ space: 12 }) {
      Row() {
        Button('返回')
          .fontSize(14)
          .height(32)
          .backgroundColor('#F5F5F5')
          .fontColor('#333333')
          .onClick(() => {
            router.back();
          })
        Text('设置')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .margin({ left: 10 })
          .layoutWeight(1)
      }
      .width('100%')

      Text('权限状态（用于展示，不是安全保证）')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')

      Column({ space: 6 }) {
        Text(this.pasteboardLine)
          .fontSize(13)
          .width('100%')
        Text(this.notificationLine)
          .fontSize(13)
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding(12)
      .backgroundColor('#F5F5F5')
      .borderRadius(8)

      Button('前往系统设置（本应用详情页）')
        .width('100%')
        .onClick(() => {
          this.openSettings();
        })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(12)
          .fontColor('#D4380D')
          .width('100%')
      }

      Text('系统剪贴板策略：默认"使用前每次询问"；可在 系统设置 → 隐私和安全 → 剪贴板 改为"始终允许"。'
        + '本应用看不到也无法修改该策略，也不会自动读取——读取只发生在你点击之后。')
        .fontSize(11)
        .fontColor('#8C8C8C')
        .width('100%')

      Divider()

      Text('能力边界（如实）')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')

      Column({ space: 6 }) {
        Text('1. 后台、息屏或进程已终止时不会持续监听剪贴板；任何"检测"只发生在应用位于前台时。')
          .fontSize(12)
          .fontColor('#595959')
          .width('100%')
        Text('2. 回前台只做"检查并提示"：不自动读取、不自动落盘，也不补采在后台期间发生的历史复制。')
          .fontSize(12)
          .fontColor('#595959')
          .width('100%')
        Text('3. 不承诺保存你在其他应用复制过的每一条内容。想保存当前内容：用首页「粘贴」安全控件，'
          + '或从其他应用把内容分享到本应用。')
          .fontSize(12)
          .fontColor('#595959')
          .width('100%')
        Text('4. 你的点击触发的读取可能弹出系统权限窗口，也可以随时关闭采集相关行为'
          + '（设置 → 隐私和安全 → 剪贴板）。')
          .fontSize(12)
          .fontColor('#595959')
          .width('100%')
        Text('5. 敏感内容（口令/密钥等特征）默认不自动保存，会先给出确认提示；检测存在漏判，'
          + '提示不等于安全保证。')
          .fontSize(12)
          .fontColor('#595959')
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')

      Divider()

      // 可读导出（S4-2，V1.4 F06）：与"可恢复备份"是两条路径，文案必须区分
      Text('可读导出（不是备份）')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('把笔记导出为 Markdown / 受控静态 HTML + 附件 ZIP，经系统分享面板交接给其他工具。'
        + '导出包不含恢复所需的元数据与校验信息，不能用于把数据恢复回本应用；'
        + '可恢复备份请使用备份功能。')
        .fontSize(12)
        .fontColor('#595959')
        .width('100%')
      Button(this.exporting ? '导出中…' : '全量导出（Markdown/HTML + 附件 ZIP）')
        .width('100%')
        .enabled(!this.exporting)
        .onClick(() => {
          this.exportAll();
        })
      if (this.exportLines.length > 0) {
        Column({ space: 4 }) {
          Text('最近导出记录')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          ForEach(this.exportLines, (line: string) => {
            Text(line)
              .fontSize(12)
              .fontColor('#595959')
              .width('100%')
          }, (line: string) => line)
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
      }

      // MCP 访问审计（S6-1，设计 §4.5.5）：只读查询页，只展示元数据
      Text('MCP 访问审计')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('查看 Agent 客户端的调用记录（客户端、工具、对象、结果、时间；不含正文与令牌）')
        .fontSize(13)
        .fontColor('#1F6FEB')
        .width('100%')
        .onClick(() => {
          router.pushUrl({ url: 'pages/McpAuditPage' });
        })
    }
    .width('100%')
    .height('100%')
    .padding(16)
    .alignItems(HorizontalAlign.Start)
  }
}
