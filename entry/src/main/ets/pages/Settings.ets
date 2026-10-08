import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  AppFeatureSettingsPatch,
  DevicePermissionStatus,
  ExportRecord,
  NotebookService,
  NotebookView,
  PasteboardPermissionState,
  PermissionStatusReport,
  describeExportRecord,
} from 'common';
import { PendingPairingView } from 'mcp';
import { AppServices } from '../services/AppServices';
import { McpGrantedClientView } from '../services/McpServiceCore';

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

/** 配对码剩余有效期提示（分钟级进一法；过期由 core 清扫） */
function ttlHint(expiresAtMs: number): string {
  const remainMs: number = expiresAtMs - Date.now();
  if (remainMs <= 0) {
    return '已过期';
  }
  const minutes: number = Math.ceil(remainMs / 60000);
  return `${minutes} 分钟内有效`;
}

@Entry
@Component
struct Settings {
  @State pasteboardLine: string = '剪贴板读取：查询中…';
  @State notificationLine: string = '通知栏消息：查询中…';
  @State notice: string = '';
  /** 最近导出记录（S4-2；只读展示，元数据无正文） */
  @State exportLines: string[] = [];
  @State exporting: boolean = false;
  /** 备份/恢复入口（WHY-131 条件 A）UI 态 */
  @State backupBusy: boolean = false;
  @State restoring: boolean = false;
  /** MCP 服务（S6-7）UI 态 */
  @State mcpEnabled: boolean = false;
  @State mcpRunning: boolean = false;
  @State mcpStatusLine: string = 'MCP 服务：查询中…';
  @State mcpAddressLine: string = '';
  @State mcpCodeLine: string = '';
  @State mcpPendings: PendingPairingView[] = [];
  @State mcpClients: McpGrantedClientView[] = [];
  /** 笔记本管理（Feature 1）：列表 + 新建/重命名/设默认/删除 */
  @State notebookViews: NotebookView[] = [];
  @State newNotebookName: string = '';
  @State renamingNotebookId: string = '';
  @State renameNotebookText: string = '';
  /** 功能开关（第二批 Feature 6/9） */
  @State clipboardAutoInbox: boolean = true;
  @State inboxBatchSaveToDefault: boolean = true;
  @State sequentialPlayback: boolean = false;

  private readonly perm: DevicePermissionStatus = new DevicePermissionStatus();
  private readonly svc: AppServices = AppServices.get();

  aboutToAppear(): void {
    this.refresh();
    this.loadExportRecords();
    this.refreshNotebooks().catch((err: Error) => {
      this.notice = `笔记本读取失败：${String(err)}`;
    });
    this.refreshMcp().catch((err: Error) => {
      this.notice = `MCP 状态读取失败：${String(err)}`;
    });
    this.svc.settingsStore().load().then((settings): void => {
      this.clipboardAutoInbox = settings.clipboardAutoInbox;
      this.inboxBatchSaveToDefault = settings.inboxBatchSaveToDefault;
      this.sequentialPlayback = settings.sequentialPlayback;
      // 全局播放的连读开关同步（避免每次连读查询 preferences）
      this.svc.globalPlayback().refreshSettings(settings.sequentialPlayback);
    }).catch((): void => undefined);
  }

  // -------------------------------------------------------------------------
  // 功能开关（第二批 Feature 6/9）
  // -------------------------------------------------------------------------

  /** 开关落盘；连读开关同步给全局播放（下一次读完生效） */
  private async toggleFeature(patch: AppFeatureSettingsPatch): Promise<void> {
    try {
      const merged = await this.svc.settingsStore().patch(patch);
      this.clipboardAutoInbox = merged.clipboardAutoInbox;
      this.inboxBatchSaveToDefault = merged.inboxBatchSaveToDefault;
      this.sequentialPlayback = merged.sequentialPlayback;
      this.svc.globalPlayback().refreshSettings(merged.sequentialPlayback);
    } catch (err) {
      this.notice = `设置保存失败：${String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // 笔记本管理（Feature 1）
  // -------------------------------------------------------------------------

  private async refreshNotebooks(): Promise<void> {
    const svc: NotebookService = await this.svc.notebookService();
    this.notebookViews = await svc.list();
  }

  private async createNotebook(): Promise<void> {
    const name: string = this.newNotebookName.trim();
    if (name.length === 0) {
      this.notice = '先输入笔记本名称。';
      return;
    }
    try {
      const svc: NotebookService = await this.svc.notebookService();
      await svc.create(name);
      this.newNotebookName = '';
      this.notice = `已创建笔记本「${name}」。`;
      await this.refreshNotebooks();
    } catch (err) {
      this.notice = `创建失败：${String(err)}`;
    }
  }

  private async setDefaultNotebook(id: string): Promise<void> {
    try {
      const svc: NotebookService = await this.svc.notebookService();
      await svc.setDefault(id);
      this.notice = '已切换默认笔记本（新建笔记将落入该笔记本）。';
      await this.refreshNotebooks();
    } catch (err) {
      this.notice = `切换失败：${String(err)}`;
    }
  }

  private startRenameNotebook(id: string, currentName: string): void {
    this.renamingNotebookId = id;
    this.renameNotebookText = currentName;
  }

  private async confirmRenameNotebook(): Promise<void> {
    const name: string = this.renameNotebookText.trim();
    if (name.length === 0) {
      this.notice = '名称不能为空。';
      return;
    }
    try {
      const svc: NotebookService = await this.svc.notebookService();
      await svc.rename(this.renamingNotebookId, name);
      this.renamingNotebookId = '';
      this.notice = '已重命名。';
      await this.refreshNotebooks();
    } catch (err) {
      this.notice = `重命名失败：${String(err)}`;
    }
  }

  private confirmDeleteNotebook(id: string, name: string, noteCount: number): void {
    AlertDialog.show({
      title: '删除笔记本',
      message: noteCount > 0
        ? `「${name}」内有 ${noteCount} 篇笔记（含垃圾桶条目），不能删除。请先把笔记移出或彻底删除。`
        : `确认删除空笔记本「${name}」？笔记归属不受影响（本操作仅删除空分组）。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: noteCount > 0
        ? undefined
        : {
            value: '删除',
            fontColor: '#D4380D',
            action: () => {
              this.deleteNotebook(id);
            },
          },
    });
  }

  private async deleteNotebook(id: string): Promise<void> {
    try {
      const svc: NotebookService = await this.svc.notebookService();
      await svc.delete(id);
      this.notice = '已删除笔记本。';
      await this.refreshNotebooks();
    } catch (err) {
      this.notice = `删除失败：${String(err)}`;
    }
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

  /**
   * 可恢复备份（WHY-131 条件 A；设计 §4.2）：打包 → 系统分享面板交接。
   * 面板没拉起不抹掉备份事实（包在沙箱 backups/ 下），两种结局都如实提示。
   */
  private async backupNow(): Promise<void> {
    if (this.backupBusy) {
      return;
    }
    this.backupBusy = true;
    try {
      const r = await this.svc.backupEntry().exportAndShare();
      this.notice = r.shared
        ? `备份完成：${r.noteCount} 篇笔记 / ${r.blobCount} 个附件，已拉起系统分享面板…`
        : `备份完成：${r.noteCount} 篇笔记 / ${r.blobCount} 个附件。分享面板未拉起，备份包仍在应用内。`;
    } catch (err) {
      this.notice = `备份失败：${String(err)}`;
    } finally {
      this.backupBusy = false;
    }
  }

  /** 选包恢复：先确认（整库替换不可撤销），再走 BackupService 既有原子替换路径 */
  private async restoreFromBackup(): Promise<void> {
    if (this.restoring) {
      return;
    }
    this.restoring = true;
    try {
      const outcome = await this.svc.backupEntry().pickAndRestore();
      if (outcome.kind === 'restored') {
        this.notice = `恢复完成：笔记 ${outcome.notes} 篇、附件 ${outcome.attachments} 个、标签 ${outcome.tags} 个。`;
      } else if (outcome.kind === 'failed') {
        this.notice = `恢复被拒绝：${outcome.detail}（备份包未通过校验，当前数据未被改动）`;
      }
      // cancelled：用户取消选择不是错误，不打扰
    } catch (err) {
      this.notice = `恢复失败：${String(err)}`;
    } finally {
      this.restoring = false;
    }
  }

  private confirmRestoreFromBackup(): void {
    AlertDialog.show({
      title: '从备份恢复',
      message: '恢复会用所选备份包整体替换当前全部笔记与附件（单事务原子替换，不可撤销）。'
        + '如果当前有还没备份的新内容，请先返回执行「立即备份」。',
      primaryButton: { value: '取消', action: () => undefined },
      secondaryButton: { value: '选择备份包', action: () => {
        this.restoreFromBackup();
      } },
    });
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

  // -------------------------------------------------------------------------
  // MCP 服务（S6-7；设计 §4.5.3/§4.5.5）
  // -------------------------------------------------------------------------

  /** 状态刷新：运行状态 / 连接地址与证书指纹 / 当前配对码 / 挂起请求 / 已授权客户端 */
  private async refreshMcp(): Promise<void> {
    const svc = this.svc.mcpService();
    this.mcpEnabled = svc.isEnabled();
    this.mcpRunning = svc.isRunning();
    if (svc.isRunning()) {
      const st = svc.state();
      const addr: string = await svc.localAddress();
      this.mcpStatusLine = `MCP 服务：运行中 · 端口 ${st.boundPort}`;
      const fp: string = svc.fingerprintDisplay();
      this.mcpAddressLine = `连接地址 ${addr.length > 0 ? addr : '（本机地址枚举失败，请查系统 WLAN IP）'}:${st.boundPort}` +
        (fp.length > 0 ? `\n证书指纹（TOFU 核对）${fp}` : '');
      const code = svc.currentPairingCode();
      this.mcpCodeLine = code === undefined ? '' : `当前配对码 ${code.code} · ${ttlHint(code.expiresAtMs)}`;
    } else {
      this.mcpStatusLine = 'MCP 服务：已停止';
      this.mcpAddressLine = '';
      this.mcpCodeLine = '';
    }
    this.mcpPendings = svc.pendingPairings();
    this.mcpClients = svc.grantedClients();
  }

  /** 开关切换：立即启/停；启动失败如实提示并回退开关（失败显式，绝不静默） */
  private async toggleMcp(on: boolean): Promise<void> {
    const svc = this.svc.mcpService();
    try {
      await svc.setEnabled(on);
      this.notice = on ? 'MCP 服务已开启（仅前台监听，退后台自动关闭）' : 'MCP 服务已关闭';
    } catch (err) {
      this.notice = `MCP 服务启动失败：${String(err)}`;
      hilog.error(0xF1C0, 'ClipNote', 'mcp start failed: %{public}s', err instanceof Error ? (err.stack ?? err.message) : String(err));
      try {
        await svc.setEnabled(false);
      } catch {
        // 回退失败仅记日志（服务未运行，无副作用可回退）
      }
    }
    await this.refreshMcp();
  }

  private async genPairingCode(): Promise<void> {
    const svc = this.svc.mcpService();
    if (!svc.isRunning()) {
      this.notice = '请先开启 MCP 服务再生成配对码';
      return;
    }
    try {
      svc.newPairingCode();
      this.notice = '';
    } catch (err) {
      this.notice = `生成配对码失败：${String(err)}`;
    }
    await this.refreshMcp();
  }

  /**
   * 确认配对：签发凭证并按首发口径授权（全部工具 + 全部标签集合）。
   * 访问令牌只在签发瞬间经弹窗展示一次（设计：令牌不进日志/正文/WebView）。
   */
  private async confirmMcpPairing(id: string): Promise<void> {
    try {
      const issued = await this.svc.mcpService().confirmPairing(id);
      if (issued === undefined) {
        this.notice = '该配对请求已失效（可能已被处理或过期）';
      } else {
        AlertDialog.show({
          title: '配对成功',
          message: '请把以下访问令牌粘贴到 Host 客户端（只显示这一次，关闭后无法找回）：\n\n' +
            issued.token,
          confirm: { value: '我已保存', action: () => undefined },
        });
      }
    } catch (err) {
      this.notice = `确认配对失败：${String(err)}`;
    }
    await this.refreshMcp();
  }

  private async rejectMcpPairing(id: string): Promise<void> {
    this.svc.mcpService().rejectPairing(id);
    await this.refreshMcp();
  }

  /** 撤销客户端：凭证与授权即时失效（下一次调用即拒，授权现场查表） */
  private async revokeMcpClient(clientId: string): Promise<void> {
    this.svc.mcpService().revokeClient(clientId);
    this.notice = '已撤销该客户端的访问凭证与授权';
    await this.refreshMcp();
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

      // 功能开关（第二批 Feature 6/9）：剪贴板直写 / 批量转存 / 顺序连读
      Text('功能开关')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Row({ space: 10 }) {
        Toggle({ type: ToggleType.Switch, isOn: this.clipboardAutoInbox })
          .onChange((on: boolean) => {
            void this.toggleFeature({ clipboardAutoInbox: on });
          })
        Column({ space: 2 }) {
          Text('回前台自动保存剪贴板')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
          Text('开启后回到前台时自动读取剪贴板并写入收件箱（同一内容只写一次）。'
            + '系统剪贴板策略默认「使用前每次询问」，可能弹授权框；'
            + '在 设置 → 隐私和安全 → 剪贴板 改为「始终允许」后不再打扰。')
            .fontSize(11)
            .fontColor('#8C8C8C')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      Row({ space: 10 }) {
        Toggle({ type: ToggleType.Switch, isOn: this.inboxBatchSaveToDefault })
          .onChange((on: boolean) => {
            void this.toggleFeature({ inboxBatchSaveToDefault: on });
          })
        Column({ space: 2 }) {
          Text('收件箱批量存为笔记')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
          Text('允许在收件箱多选后一键存为笔记（多个笔记本时选择目标）。关闭后收件箱隐藏批量保存入口，单条保存不受影响。')
            .fontSize(11)
            .fontColor('#8C8C8C')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      Row({ space: 10 }) {
        Toggle({ type: ToggleType.Switch, isOn: this.sequentialPlayback })
          .onChange((on: boolean) => {
            void this.toggleFeature({ sequentialPlayback: on });
          })
        Column({ space: 2 }) {
          Text('按笔记顺序依次朗读')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
          Text('当前笔记读完后，自动按笔记库顺序（置顶优先）接下一篇继续朗读，直到读完全部或手动停止。锁屏后可持续播放。')
            .fontSize(11)
            .fontColor('#8C8C8C')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')

      Divider()

      // 笔记本管理（Feature 1）：默认笔记本随库走；新建笔记落默认，笔记库顶部可过滤
      Text('笔记本')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('新建笔记落入默认笔记本；笔记库顶部可按笔记本过滤。非空笔记本（含垃圾桶条目）不能删除。')
        .fontSize(11)
        .fontColor('#8C8C8C')
        .width('100%')
      ForEach(this.notebookViews, (v: NotebookView) => {
        Column({ space: 4 }) {
          Row({ space: 8 }) {
            Text(`${v.notebook.name}${v.notebook.isDefault ? '（默认）' : ''}`)
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            Text(`${v.noteCount} 篇`)
              .fontSize(11)
              .fontColor('#8C8C8C')
          }
          .width('100%')
          Row({ space: 12 }) {
            if (!v.notebook.isDefault) {
              Text('设为默认')
                .fontSize(13)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  this.setDefaultNotebook(v.notebook.id);
                })
            }
            Text('重命名')
              .fontSize(13)
              .fontColor('#1F6FEB')
              .onClick(() => {
                this.startRenameNotebook(v.notebook.id, v.notebook.name);
              })
            if (!v.notebook.builtIn) {
              Text('删除')
                .fontSize(13)
                .fontColor('#D4380D')
                .onClick(() => {
                  this.confirmDeleteNotebook(v.notebook.id, v.notebook.name, v.noteCount);
                })
            }
          }
          .width('100%')
          if (this.renamingNotebookId === v.notebook.id) {
            Row({ space: 8 }) {
              TextInput({ text: this.renameNotebookText })
                .fontSize(13)
                .layoutWeight(1)
                .onChange((value: string) => {
                  this.renameNotebookText = value;
                })
              Text('确定')
                .fontSize(13)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  this.confirmRenameNotebook();
                })
              Text('取消')
                .fontSize(13)
                .fontColor('#8C8C8C')
                .onClick(() => {
                  this.renamingNotebookId = '';
                })
            }
            .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(10)
        .backgroundColor('#F5F5F5')
        .borderRadius(8)
      }, (v: NotebookView) => v.notebook.id)
      Row({ space: 8 }) {
        TextInput({ placeholder: '新笔记本名称', text: this.newNotebookName })
          .fontSize(13)
          .layoutWeight(1)
          .onChange((value: string) => {
            this.newNotebookName = value;
          })
        Button('新建')
          .fontSize(13)
          .height(32)
          .onClick(() => {
            this.createNotebook();
          })
      }
      .width('100%')

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

      Divider()

      // 可恢复备份（WHY-131 条件 A；设计 §4.2）：与「可读导出」是两条路径，文案必须区分
      Text('可恢复备份（不是导出）')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('生成含清单、格式版本与逐文件摘要校验的备份包，经系统分享面板保存到别处；'
        + '需要时可从备份包把数据完整恢复回本应用（恢复会整体替换当前数据）。'
        + '与上面的「可读导出」不同：导出是给人读的文件包，不能用于恢复。')
        .fontSize(12)
        .fontColor('#595959')
        .width('100%')
      Button(this.backupBusy ? '备份中…' : '立即备份（生成可恢复备份包）')
        .width('100%')
        .enabled(!this.backupBusy)
        .onClick(() => {
          this.backupNow();
        })
      Button(this.restoring ? '恢复中…' : '从备份包恢复…')
        .width('100%')
        .enabled(!this.restoring)
        .fontColor('#D4380D')
        .backgroundColor('#F5F5F5')
        .onClick(() => {
          this.confirmRestoreFromBackup();
        })

      // MCP 局域网服务（S6-7，设计 §4.5.3）：开关 + 配对 + 已授权客户端管理
      Text('MCP 局域网服务')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('让局域网内的 Host（如 Cherry Studio）经 MCP 协议读写笔记。仅前台监听、退后台即关；'
        + '传输为 TLS 自签证书，Host 侧请核对指纹。客户端须输入配对码完成配对，每次调用都会记入审计。')
        .fontSize(12)
        .fontColor('#595959')
        .width('100%')
      Row({ space: 10 }) {
        Toggle({ type: ToggleType.Switch, isOn: this.mcpEnabled })
          .onChange((on: boolean) => {
            this.toggleMcp(on);
          })
        Text(this.mcpStatusLine)
          .fontSize(13)
          .layoutWeight(1)
      }
      .width('100%')
      if (this.mcpRunning) {
        Text(this.mcpAddressLine)
          .fontSize(12)
          .fontColor('#1F6FEB')
          .width('100%')
        Row({ space: 8 }) {
          Button('生成配对码')
            .fontSize(12)
            .height(30)
            .onClick(() => {
              this.genPairingCode();
            })
          Button('刷新配对状态')
            .fontSize(12)
            .height(30)
            .backgroundColor('#F5F5F5')
            .fontColor('#333333')
            .onClick(() => {
              this.refreshMcp().catch((err: Error) => {
                this.notice = `MCP 状态读取失败：${String(err)}`;
              });
            })
        }
        .width('100%')
        if (this.mcpCodeLine.length > 0) {
          Text(this.mcpCodeLine)
            .fontSize(13)
            .fontColor('#237804')
            .width('100%')
        }
        if (this.mcpPendings.length > 0) {
          Text('待确认的配对请求（来自 Host 的配对码提交）')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          ForEach(this.mcpPendings, (p: PendingPairingView) => {
            Row({ space: 8 }) {
              Text(`${p.clientName}（${p.remoteAddress}）`)
                .fontSize(13)
                .layoutWeight(1)
              Button('确认')
                .fontSize(12)
                .height(30)
                .onClick(() => {
                  this.confirmMcpPairing(p.id);
                })
              Button('拒绝')
                .fontSize(12)
                .height(30)
                .backgroundColor('#F5F5F5')
                .fontColor('#333333')
                .onClick(() => {
                  this.rejectMcpPairing(p.id);
                })
            }
            .width('100%')
          }, (p: PendingPairingView) => p.id)
        }
        if (this.mcpClients.length > 0) {
          Text('已授权的客户端')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          ForEach(this.mcpClients, (c: McpGrantedClientView) => {
            Row({ space: 8 }) {
              Text(`${c.label.length > 0 ? c.label : c.clientId} · ${c.toolCount} 个工具 · ${c.collectionCount} 个集合`)
                .fontSize(13)
                .layoutWeight(1)
              Button('撤销')
                .fontSize(12)
                .height(30)
                .backgroundColor('#F5F5F5')
                .fontColor('#D4380D')
                .onClick(() => {
                  this.revokeMcpClient(c.clientId);
                })
            }
            .width('100%')
          }, (c: McpGrantedClientView) => c.clientId)
        }
      }

      // 垃圾桶（Feature 2）：已删笔记与已弃收件箱条目的恢复/彻底删除出口
      Text('垃圾桶')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('查看已删笔记与已弃收件箱条目（可恢复或彻底删除）')
        .fontSize(13)
        .fontColor('#1F6FEB')
        .width('100%')
        .onClick(() => {
          router.pushUrl({ url: 'pages/TrashPage' });
        })

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
