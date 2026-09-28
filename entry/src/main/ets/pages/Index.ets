import { pasteboard } from '@kit.BasicServicesKit';
import { router } from '@kit.ArkUI';
import {
  AppContextHolder,
  AppDataRuntime,
  BlobCas,
  CaptureKind,
  CaptureResult,
  ClipEntry,
  ClipIngestService,
  ClipKind,
  ClipboardItem,
  CryptoHasher,
  CryptoRandom,
  DEFAULT_INBOX_CAPACITY,
  HilogLogger,
  INBOX_LIST_LIMIT,
  InboxService,
  Note,
  SandboxFileStore,
  Sensitivity,
  SystemClock,
  sensitivityReasonLabel,
} from 'common';

/**
 * 依赖装配（最薄的一层）。
 *
 * 只做实例化与注入，不含任何业务规则 —— 业务规则全部在 common/core 内（由本机用例覆盖）。
 * 这样做的直接收益：UI 这一层（无法在本机自动化验证的部分）尽可能没有可出错的逻辑。
 */
export class AppServices {
  private static instance: AppServices | undefined = undefined;

  readonly clock: SystemClock = new SystemClock();
  readonly logger: HilogLogger = new HilogLogger();
  readonly random: CryptoRandom = new CryptoRandom();
  readonly hasher: CryptoHasher = new CryptoHasher();
  readonly fs: SandboxFileStore = new SandboxFileStore();
  readonly ingest: ClipIngestService;
  readonly blobs: BlobCas;

  private inboxSvc: InboxService | undefined = undefined;

  private constructor() {
    const root: string = AppContextHolder.filesDir();
    this.ingest = new ClipIngestService({
      clock: this.clock,
      hasher: this.hasher,
      random: this.random,
      logger: this.logger,
    });
    this.blobs = new BlobCas(`${root}/clipnote`, this.fs, this.hasher, this.logger, this.random);
  }

  static get(): AppServices {
    if (AppServices.instance === undefined) {
      AppServices.instance = new AppServices();
    }
    return AppServices.instance;
  }

  /** 收件箱服务：依赖数据层就绪（打开库 → 迁移 → 恢复扫描 → 保留期清理，见 AppDataRuntime） */
  async inboxService(): Promise<InboxService> {
    if (this.inboxSvc === undefined) {
      const rt: AppDataRuntime = await AppDataRuntime.whenReady();
      this.inboxSvc = new InboxService({
        ingest: this.ingest,
        inbox: rt.inbox,
        notes: rt.notes,
        clock: this.clock,
        logger: this.logger,
      });
    }
    return this.inboxSvc;
  }
}

// ---------------------------------------------------------------------------
// 展示模型与映射（纯展示语义，无业务规则）
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

function relativeTimeLabel(capturedAtMs: number): string {
  const diff: number = Date.now() - capturedAtMs;
  if (diff < 60 * 1000) {
    return '刚刚';
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / 60000)} 分钟前`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / 3600000)} 小时前`;
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / 86400000)} 天前`;
  }
  const d: Date = new Date(capturedAtMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function toRow(item: ClipboardItem): InboxRow {
  // 摘要折成单行展示，正文本身不改动
  const flat: string = item.rawText.split('\n').join(' ');
  const preview: string = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
  return {
    id: item.id,
    icon: kindIcon(item.kind),
    kindLabel: kindLabel(item.kind),
    preview,
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

  private readonly svc: AppServices = AppServices.get();
  private inboxSvc: InboxService | undefined = undefined;

  aboutToAppear(): void {
    this.initData();
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
   */
  private async captureFromPasteboard(): Promise<void> {
    if (this.inboxSvc === undefined) {
      this.notice = '数据层尚未就绪，请稍后再试。';
      return;
    }
    try {
      const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      const data: pasteboard.PasteData = await board.getData();
      const text: string = data.getPrimaryText();
      if (text.length === 0) {
        this.notice = '剪贴板当前没有可保存的文本。';
        return;
      }
      const result: CaptureResult = await this.inboxSvc.capture({
        text,
        entry: ClipEntry.MANUAL,
      });
      await this.applyCapture(result);
    } catch (err) {
      // 不区分具体原因地"提示成功"是常见劣化：这里明确告知用户读取失败且未保存
      this.notice = `读取剪贴板失败，未保存任何内容。原因：${String(err)}`;
    }
  }

  private async applyCapture(result: CaptureResult): Promise<void> {
    if (result.kind === CaptureKind.REJECTED) {
      this.notice = `未保存：${result.reasons.join('，')}`;
      return;
    }
    if (result.kind === CaptureKind.MERGED) {
      this.notice = '内容与刚才保存的一致，已合并为同一条（未产生重复）。';
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
      this.notice = `已存为笔记《${note.title}》。`;
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
      Text('拾记 ClipNote')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .width('100%')

      // 能力边界必须如实展示（设计 §4.1）：这里的措辞不是免责声明，而是产品事实
      Text('本应用不会在后台或息屏时持续监听剪贴板。请在需要时主动点击下方按钮保存。')
        .fontSize(12)
        .fontColor('#8C8C8C')
        .width('100%')

      Button('从剪贴板保存')
        .width('100%')
        .enabled(this.dataReady && this.confirmItem === undefined)
        .onClick(() => {
          this.captureFromPasteboard();
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

      // G1 PROBE（WHY-90 临时入口，G1 验收后移除）：真机执行探测场景页
      Text('G1 探测页（临时）')
        .fontSize(12)
        .fontColor('#8C8C8C')
        .width('100%')
        .textAlign(TextAlign.Center)
        .onClick(() => {
          router.pushUrl({ url: 'pages/G1ProbePage' });
        })

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
