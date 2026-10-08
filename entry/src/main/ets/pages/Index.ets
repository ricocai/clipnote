import { router } from '@kit.ArkUI';
import {
  CaptureKind,
  CaptureResult,
  ClipEntry,
  ClipKind,
  ClipboardItem,
  DEFAULT_INBOX_CAPACITY,
  DEFAULT_SHARE_POLICY,
  ForegroundCheck,
  ForegroundPromptController,
  INBOX_LIST_LIMIT,
  InboxService,
  Note,
  Sensitivity,
  ShareIntakeSummary,
  ShareRejectReason,
  SystemPasteboardProbe,
  sensitivityReasonLabel,
} from 'common';
import { EVENT_FOREGROUND } from '../EntryEvents';
import { AppServices } from '../services/AppServices';
import { ShareNoticeBus } from '../share/share-intake';
import { flatPreview, relativeTimeLabel } from '../ui/Format';

// ---------------------------------------------------------------------------
// 展示模型与映射（纯展示语义，无业务规则；格式化助手见 ui/Format.ets）
// ---------------------------------------------------------------------------

/** 收件箱行的展示模型（UI 态与领域模型分离，避免 UI 直接依赖领域字段演化） */
interface InboxRow {
  readonly id: string;
  readonly icon: string;
  readonly kindLabel: string;
  readonly preview: string;
  readonly sensitivity: Sensitivity;
  readonly sensitivityLabel: string;
  readonly timeLabel: string;
  readonly entryLabel: string;
  readonly truncated: boolean;
  readonly originalByteLength: number;
}

function kindIcon(kind: ClipKind): string {
  switch (kind) {
    case ClipKind.URL:
      return '🔗';
    case ClipKind.CODE:
      return '💻';
    case ClipKind.TABLE:
      return '📊';
    case ClipKind.IMAGE:
      return '🖼️';
    case ClipKind.FILE:
      return '📎';
    default:
      return '📄';
  }
}

function kindLabel(kind: ClipKind): string {
  switch (kind) {
    case ClipKind.URL:
      return '链接';
    case ClipKind.CODE:
      return '代码';
    case ClipKind.TABLE:
      return '表格';
    case ClipKind.IMAGE:
      return '图片';
    case ClipKind.FILE:
      return '文件';
    default:
      return '文本';
  }
}

function entryLabel(entry: ClipEntry): string {
  switch (entry) {
    case ClipEntry.FOREGROUND_WATCH:
      return '前台监听';
    case ClipEntry.RETURN_TO_FOREGROUND:
      return '回前台';
    case ClipEntry.SHARE:
      return '分享';
    case ClipEntry.PASTE_BUTTON:
      return '粘贴按钮';
    case ClipEntry.DESKTOP_CARD:
      return '桌面卡片';
    default:
      return '手动粘贴';
  }
}

function sensitivityLabelOf(s: Sensitivity): string {
  if (s === Sensitivity.HIGH) {
    return '强特征敏感';
  }
  if (s === Sensitivity.SUSPECTED) {
    return '疑似敏感';
  }
  return '';
}

function toRow(item: ClipboardItem): InboxRow {
  return {
    id: item.id,
    icon: kindIcon(item.kind),
    kindLabel: kindLabel(item.kind),
    preview: flatPreview(item.rawText, 120),
    sensitivity: item.sensitivity,
    sensitivityLabel: sensitivityLabelOf(item.sensitivity),
    timeLabel: relativeTimeLabel(item.capturedAtMs),
    entryLabel: entryLabel(item.entry),
    truncated: item.truncated,
    originalByteLength: item.originalByteLength,
  };
}

function sensitivityColor(s: Sensitivity): string {
  return s === Sensitivity.HIGH ? '#D4380D' : '#FA8C16';
}

@Entry
@Component
struct Index {
  @State inbox: InboxRow[] = [];
  @State pendingCount: number = 0;
  @State notice: string = '';
  @State dataReady: boolean = false;
  /** 待确认的敏感条目（只在内存，未落盘）；undefined 表示无待确认 */
  @State confirmItem: ClipboardItem | undefined = undefined;
  @State confirmLevel: string = '';
  @State confirmReasons: string = '';
  @State confirmPreview: string = '';
  /**
   * 「回前台提示条」的展示位（S2-4）。判定逻辑（何时弹/继续/停止）全部在
   * common 领域内核 ForegroundPromptController（Node 用例覆盖），这里只反映其结果。
   */
  @State promptOpen: boolean = false;

  private readonly svc: AppServices = AppServices.get();
  private inboxSvc: InboxService | undefined = undefined;
  /** 剪贴板唯一接触面（S2-4）：hasData 只探测布尔；readText 只在用户手势后调用 */
  private readonly probe: SystemPasteboardProbe = new SystemPasteboardProbe();
  private readonly fgPrompt: ForegroundPromptController = new ForegroundPromptController();
  /** 入口互斥：安全控件 / 直接读取（降级）/ 提示条，同一时间至多一条"读取"在途 */
  private readBusy: boolean = false;
  private fgChecking: boolean = false;
  private fgHandler: (() => void) | undefined = undefined;
  private readonly shareListener = (summary: ShareIntakeSummary): void => {
    this.applyShareSummary(summary);
  };

  aboutToAppear(): void {
    this.subscribeForeground();
    this.initData();
    this.checkForeground();
    // 分享结果接收（S2-3）：订阅即时投递 + drain 冷启动窗口期的积压
    ShareNoticeBus.subscribe(this.shareListener);
    this.drainShareNotices();
  }

  onPageShow(): void {
    // 从其他页面返回时复查。检测只是"读布尔"，且同一内容集内不重复弹（状态机保证），不会打扰
    this.checkForeground();
    // 分享拉起已运行实例时本页可能已在显示（不走 aboutToAppear），这里兜底取积压
    this.drainShareNotices();
    this.refreshInbox();
  }

  aboutToDisappear(): void {
    ShareNoticeBus.unsubscribe(this.shareListener);
    if (this.fgHandler === undefined) {
      return;
    }
    try {
      const host = this.getUIContext().getHostContext();
      if (host !== undefined && host !== null) {
        host.eventHub.off(EVENT_FOREGROUND, this.fgHandler);
      }
    } catch (err) {
      // 反订阅失败同样只影响自动提示，不打扰用户
    }
    this.fgHandler = undefined;
  }

  /** 订阅 EntryAbility.onForeground 广播（S2-4）。订阅失败只是失去自动提示，手动入口不受影响 */
  private subscribeForeground(): void {
    if (this.fgHandler !== undefined) {
      return;
    }
    this.fgHandler = (): void => {
      this.checkForeground();
    };
    try {
      const host = this.getUIContext().getHostContext();
      if (host !== undefined && host !== null) {
        host.eventHub.on(EVENT_FOREGROUND, this.fgHandler);
      }
    } catch (err) {
      // 订阅失败 = 只失去自动提示，不影响手动入口，不打扰用户
    }
  }

  /**
   * 回前台检查（S2-4 口径核心）：只探测"有没有内容"，**不读取、不落盘任何内容**。
   * 是否读取由用户点击提示条决定（用户手势）；"是否重复弹"由内核状态机回答。
   */
  private async checkForeground(): Promise<void> {
    if (this.fgChecking) {
      return;
    }
    this.fgChecking = true;
    try {
      const res: ForegroundCheck = await this.fgPrompt.checkOnForeground(this.probe);
      this.promptOpen = res !== ForegroundCheck.NONE;
    } finally {
      this.fgChecking = false;
    }
  }

  /** 提示条"查看并保存"：此刻才读取（用户手势），走统一采集管线 */
  private acceptPrompt(): void {
    if (!this.dataReady) {
      this.notice = '数据层尚未就绪，稍后再点。';
      return; // 保持提示条，不吃掉本集
    }
    this.fgPrompt.accept();
    this.promptOpen = false;
    this.readBoardAndCapture(ClipEntry.RETURN_TO_FOREGROUND);
  }

  /** 提示条"忽略"：本内容集内不再弹（设计 §4.1：拒绝授权后不得反复打扰） */
  private dismissPrompt(): void {
    this.fgPrompt.dismiss();
    this.promptOpen = false;
  }

  private async initData(): Promise<void> {
    try {
      this.inboxSvc = await this.svc.inboxService();
      await this.refreshInbox();
      this.dataReady = true;
    } catch (err) {
      this.notice = `数据层初始化失败：${String(err)}`;
    }
  }

  private async refreshInbox(): Promise<void> {
    if (this.inboxSvc === undefined) {
      return;
    }
    const items: ClipboardItem[] = await this.inboxSvc.listPending(INBOX_LIST_LIMIT);
    const rows: InboxRow[] = [];
    for (let i: number = 0; i < items.length; i++) {
      rows.push(toRow(items[i]));
    }
    this.inbox = rows;
    this.pendingCount = await this.inboxSvc.pendingCount();
  }

  /**
   * 显式用户操作才读取剪贴板（设计 §4.1 矩阵：不预设本应用拥有后台读取权）。
   * 失败必须如实提示，不静默吞掉 —— 权限/空内容/系统控件拦截是三种不同原因。
   * 三个入口共用本方法：提示条（回前台）、安全控件、直接读取（降级）。
   */
  private async readBoardAndCapture(entry: ClipEntry): Promise<void> {
    if (this.inboxSvc === undefined) {
      this.notice = '数据层尚未就绪，请稍后再试。';
      return;
    }
    if (this.readBusy) {
      return;
    }
    this.readBusy = true;
    try {
      // 用户已经用显式入口处理了当前内容（无论成败），收起并抑制同内容的提示条：
      // 失败场景若保留提示，会造成"再点→再弹窗→再拒"的骚扰链（设计：拒绝后不得反复打扰）
      this.fgPrompt.accept();
      this.promptOpen = false;
      const text: string = await this.probe.readText();
      if (text.length === 0) {
        this.notice = '剪贴板当前没有可保存的文本。';
        return;
      }
      const result: CaptureResult = await this.inboxSvc.capture({
        text: text,
        entry: entry,
      });
      await this.applyCapture(result);
    } catch (err) {
      // 不区分具体原因地"提示成功"是常见劣化：这里明确告知用户读取失败且未保存
      this.notice = `读取剪贴板失败，未保存任何内容。原因：${String(err)}`;
    } finally {
      this.readBusy = false;
    }
  }

  private async applyCapture(result: CaptureResult): Promise<void> {
    if (result.kind === CaptureKind.REJECTED) {
      this.notice = `未保存：${result.reasons.join('，')}`;
      return;
    }
    if (result.kind === CaptureKind.MERGED) {
      // Q4 持久化去重（近 2 日窗口）与 3 秒幂等窗的文案区分：窗口口径如实告知
      this.notice = result.reasons.indexOf('dedupe:persisted_within_2d') >= 0
          || result.reasons.indexOf('dedupe:note_within_2d') >= 0
        ? '近两日内已保存过相同内容，未产生重复条目。'
        : '内容与刚才保存的一致，已合并为同一条（未产生重复）。';
      return;
    }
    if (result.kind === CaptureKind.PENDING_CONFIRM) {
      // 敏感提示交互（设计 §4.1 落盘前提示）：展示检测器判定依据，交用户明确决定
      this.presentConfirm(result.item, result.reasons);
      return;
    }
    // PERSISTED
    await this.refreshInbox();
    if (result.evicted > 0) {
      this.notice = `已保存到收件箱；按容量/保留期策略清理了 ${result.evicted} 条旧内容。`;
    } else {
      this.notice = '已保存到收件箱。';
    }
  }

  /** 取出分享结果积压（冷启动/后台到达窗口期），逐条应用 */
  private drainShareNotices(): void {
    const backlog: ShareIntakeSummary[] = ShareNoticeBus.drain();
    for (let i: number = 0; i < backlog.length; i++) {
      this.applyShareSummary(backlog[i]);
    }
  }

  /**
   * 分享结果的用户提示（S2-3 降级口径，S1-2 探测报告 §9）：
   * 保存/合并/拒绝各有如实文案；待确认的敏感条目复用落盘前确认面板。
   */
  private async applyShareSummary(summary: ShareIntakeSummary): Promise<void> {
    const parts: string[] = [];
    if (summary.persisted > 0) {
      parts.push(`已保存 ${summary.persisted} 条分享内容到收件箱`);
    }
    if (summary.merged > 0) {
      parts.push(`${summary.merged} 条与已保存内容重复，已合并`);
    }
    for (let i: number = 0; i < summary.rejections.length; i++) {
      const r = summary.rejections[i];
      if (r.reason === ShareRejectReason.UNSUPPORTED_TYPE) {
        parts.push('有内容因类型不支持未保存（当前仅支持文本与图片）');
      } else if (r.reason === ShareRejectReason.FILE_TOO_LARGE) {
        const mb: number = Math.floor(DEFAULT_SHARE_POLICY.maxFileBytes / 1024 / 1024);
        parts.push(`有文件超过 ${mb}MB 上限未保存`);
      } else if (r.reason === ShareRejectReason.URI_UNREADABLE) {
        parts.push('有文件读取失败（分享授权可能已过期），未保存');
      } else if (r.reason === ShareRejectReason.EMPTY_SHARE) {
        parts.push('分享内容为空，未保存');
      }
    }
    if (summary.rejectedContent.length > 0) {
      parts.push('有内容为空或超出长度上限，未保存');
    }
    if (parts.length > 0) {
      this.notice = `${parts.join('；')}。`;
    }
    if (summary.pendingConfirm.length > 0) {
      // 逐条交用户决定（与手动粘贴的敏感提示同一面板）；多条时先展示第一条
      this.presentConfirm(summary.pendingConfirm[0].item, summary.pendingConfirm[0].reasons);
    }
    if (summary.persisted > 0 || summary.evicted > 0) {
      await this.refreshInbox();
    }
  }

  private presentConfirm(item: ClipboardItem, reasons: string[]): void {
    const labels: string[] = [];
    for (let i: number = 0; i < reasons.length; i++) {
      const r: string = reasons[i];
      if (r.startsWith('sensitive:')) {
        labels.push(sensitivityReasonLabel(r.slice('sensitive:'.length)));
      }
    }
    const flat: string = item.rawText.split('\n').join(' ');
    this.confirmItem = item;
    this.confirmLevel = sensitivityLabelOf(item.sensitivity);
    this.confirmReasons = labels.length > 0 ? labels.join('、') : '未知特征';
    this.confirmPreview = flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
    this.notice = '';
  }

  private async confirmSaveSensitive(): Promise<void> {
    const item: ClipboardItem | undefined = this.confirmItem;
    if (item === undefined || this.inboxSvc === undefined) {
      return;
    }
    this.dismissConfirm();
    const evicted: number = await this.inboxSvc.confirmSave(item);
    await this.refreshInbox();
    this.notice = evicted > 0
      ? `已确认保存到收件箱；按容量/保留期策略清理了 ${evicted} 条旧内容。`
      : '已确认保存到收件箱。';
  }

  private declineSensitive(): void {
    const item: ClipboardItem | undefined = this.confirmItem;
    if (item === undefined || this.inboxSvc === undefined) {
      return;
    }
    this.inboxSvc.decline(item);
    this.dismissConfirm();
    this.notice = '已放弃，该内容未保存。';
  }

  private dismissConfirm(): void {
    this.confirmItem = undefined;
    this.confirmLevel = '';
    this.confirmReasons = '';
    this.confirmPreview = '';
  }

  private async acceptAsNote(id: string): Promise<void> {
    if (this.inboxSvc === undefined) {
      return;
    }
    try {
      const note: Note = await this.inboxSvc.acceptAsNote(id);
      // 与笔记页打通（S3-1）：转存结果如实播报，去向给可点的入口而不是让用户猜
      this.notice = `已存为笔记《${note.title}》，可在「笔记库」查看/编辑。`;
    } catch (err) {
      this.notice = `存为笔记失败：${String(err)}`;
    }
    await this.refreshInbox();
  }

  private async removeItem(id: string): Promise<void> {
    if (this.inboxSvc === undefined) {
      return;
    }
    await this.inboxSvc.remove(id);
    this.notice = '已删除。';
    await this.refreshInbox();
  }

  private confirmClearAll(): void {
    if (this.pendingCount === 0) {
      this.notice = '收件箱已经是空的。';
      return;
    }
    AlertDialog.show({
      title: '清空收件箱',
      message: `将删除全部 ${this.pendingCount} 条内容，且不可恢复。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '清空',
        fontColor: '#D4380D',
        action: () => {
          this.doClearAll();
        },
      },
    });
  }

  private async doClearAll(): Promise<void> {
    if (this.inboxSvc === undefined) {
      return;
    }
    const n: number = await this.inboxSvc.clearAll();
    this.notice = `已清空收件箱（${n} 条）。`;
    await this.refreshInbox();
  }

  build() {
    Column({ space: 12 }) {
      Row() {
        Text('拾记 ClipNote')
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Text('笔记库')
          .fontSize(13)
          .fontColor('#1F6FEB')
          .margin({ right: 12 })
          .onClick(() => {
            router.pushUrl({ url: 'pages/NoteList' });
          })
        Text('设置')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .onClick(() => {
            router.pushUrl({ url: 'pages/Settings' });
          })
      }
      .width('100%')

      // 回前台提示条（S2-4）：只反映"剪贴板里有内容"这一布尔事实，未读取内容
      if (this.promptOpen && this.confirmItem === undefined) {
        Column({ space: 8 }) {
          Text('检测到剪贴板里有内容可保存（尚未读取）')
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor('#1F6FEB')
            .width('100%')
          Text('点「查看并保存」后才会读取剪贴板并预览；忽略后本条不再重复出现，剪贴板内容变化后才会再次提示。')
            .fontSize(11)
            .fontColor('#8C8C8C')
            .width('100%')
          Row({ space: 12 }) {
            Button('查看并保存')
              .layoutWeight(1)
              .enabled(this.dataReady && !this.readBusy)
              .onClick(() => {
                this.acceptPrompt();
              })
            Button('忽略')
              .layoutWeight(1)
              .backgroundColor('#F5F5F5')
              .fontColor('#333333')
              .onClick(() => {
                this.dismissPrompt();
              })
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(12)
        .backgroundColor('#F0F6FF')
        .borderRadius(8)
        .border({ width: 1, color: '#B7D3F7' })
      }

      // 能力边界必须如实展示（设计 §4.1）：这里的措辞不是免责声明，而是产品事实
      Text('本应用不会在后台或息屏时持续监听剪贴板，也不补采回前台之前的历史复制。保存请在需要时主动操作。')
        .fontSize(12)
        .fontColor('#8C8C8C')
        .width('100%')

      // 首选路径：系统安全控件（S2-4；G1 探测报告 §5-⑤：可行且应为第一选择）。
      // 样式受系统校验（不可自定义图标/文本，透明、过小、被遮挡都会导致授权失败），保持默认样式。
      // SUCCESS 时已获临时授权，读取不弹窗、免 READ_PASTEBOARD；FAILED 不硬读、转降级入口。
      Text('首选：粘贴安全控件（点一下即存，通常无系统弹窗）')
        .fontSize(11)
        .fontColor('#8C8C8C')
        .width('100%')
      PasteButton()
        .width('100%')
        .height(40)
        .onClick((event: ClickEvent, result: PasteButtonOnClickResult) => {
          if (result === PasteButtonOnClickResult.SUCCESS) {
            this.readBoardAndCapture(ClipEntry.PASTE_BUTTON);
          } else {
            this.notice = '安全控件本次未授予临时读取权限（样式或系统策略限制）；可改用下方直接读取。';
          }
        })

      // 降级入口（G1 报告 §5-⑤链路最后一级）：普通按钮 + 系统弹窗。
      // 未授权时可能报 201，如实展示即可；不自动重试、不反复重试（拒绝授权后不得反复打扰）。
      Button('直接读取剪贴板并保存（降级，可能触发系统权限弹窗）')
        .width('100%')
        .fontSize(13)
        .backgroundColor('#F5F5F5')
        .fontColor('#333333')
        .enabled(this.dataReady && this.confirmItem === undefined && !this.readBusy)
        .onClick(() => {
          this.readBoardAndCapture(ClipEntry.MANUAL);
        })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(13)
          .fontColor('#1F6FEB')
          .width('100%')
      }

      // 敏感确认面板（落盘前提示，设计 §4.1）：检测器≠安全保证，措辞如实
      if (this.confirmItem !== undefined) {
        Column({ space: 8 }) {
          Text(`检测到${this.confirmLevel}内容，未自动保存`)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor('#D4380D')
            .width('100%')
          Text(`命中特征：${this.confirmReasons}`)
            .fontSize(12)
            .fontColor('#8C8C8C')
            .width('100%')
          Text(this.confirmPreview)
            .fontSize(13)
            .width('100%')
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text('敏感检测可能漏判，是否保存由你决定。')
            .fontSize(11)
            .fontColor('#8C8C8C')
            .width('100%')
          Row({ space: 12 }) {
            Button('仍要保存')
              .layoutWeight(1)
              .onClick(() => {
                this.confirmSaveSensitive();
              })
            Button('放弃')
              .layoutWeight(1)
              .backgroundColor('#F5F5F5')
              .fontColor('#333333')
              .onClick(() => {
                this.declineSensitive();
              })
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(12)
        .backgroundColor('#FFF7E6')
        .borderRadius(8)
        .border({ width: 1, color: '#FFD591' })
      }

      Row() {
        Text(`收件箱（${this.pendingCount}/${DEFAULT_INBOX_CAPACITY}）`)
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        Button('清空')
          .fontSize(12)
          .height(28)
          .backgroundColor('#F5F5F5')
          .fontColor('#D4380D')
          .onClick(() => {
            this.confirmClearAll();
          })
      }
      .width('100%')

      if (!this.dataReady) {
        Text('数据层初始化中…')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else if (this.inbox.length === 0) {
        Text('收件箱为空。保存的内容超过保留期会自动清理。')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else {
        List({ space: 8 }) {
          ForEach(this.inbox, (row: InboxRow) => {
            ListItem() {
              Column({ space: 4 }) {
                Row({ space: 6 }) {
                  Text(`${row.icon} ${row.kindLabel}`)
                    .fontSize(11)
                    .fontColor('#8C8C8C')
                  if (row.sensitivityLabel.length > 0) {
                    Text(row.sensitivityLabel)
                      .fontSize(11)
                      .fontColor(sensitivityColor(row.sensitivity))
                  }
                  if (row.truncated) {
                    Text('已截断')
                      .fontSize(11)
                      .fontColor('#8C8C8C')
                  }
                }
                Text(row.preview)
                  .fontSize(14)
                  .maxLines(3)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Row() {
                  Text(`${row.timeLabel} · ${row.entryLabel}`)
                    .fontSize(11)
                    .fontColor('#8C8C8C')
                    .layoutWeight(1)
                  Button('存为笔记')
                    .fontSize(12)
                    .height(26)
                    .onClick(() => {
                      this.acceptAsNote(row.id);
                    })
                  Button('删除')
                    .fontSize(12)
                    .height(26)
                    .backgroundColor('#F5F5F5')
                    .fontColor('#D4380D')
                    .margin({ left: 8 })
                    .onClick(() => {
                      this.removeItem(row.id);
                    })
                }
                .width('100%')
              }
              .alignItems(HorizontalAlign.Start)
              .width('100%')
              .padding(10)
              .backgroundColor('#F5F5F5')
              .borderRadius(8)
            }
          }, (row: InboxRow) => row.id)
        }
        .layoutWeight(1)
        .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
