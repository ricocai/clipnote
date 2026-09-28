import { pasteboard } from '@kit.BasicServicesKit';
import { router } from '@kit.ArkUI';
import {
  BlobCas,
  ClipEntry,
  ClipIngestService,
  ClipboardItem,
  CryptoHasher,
  CryptoRandom,
  HilogLogger,
  IngestDecision,
  IngestOutcome,
  InboxState,
  InvertedIndex,
  SandboxFileStore,
  Sensitivity,
  SystemClock,
  AppContextHolder,
} from 'common';

/**
 * 依赖装配（最薄的一层）。
 *
 * 只做实例化与注入，不含任何业务规则 —— 业务规则全部在 common/core 内（已被 95 个本机用例覆盖）。
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
  readonly index: InvertedIndex = new InvertedIndex();
  readonly blobs: BlobCas;

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
}

/** 收件箱行的展示模型（UI 态与领域模型分离，避免 UI 直接依赖领域字段演化） */
interface InboxRow {
  readonly id: string;
  readonly kind: string;
  readonly preview: string;
  readonly needsConfirm: boolean;
  readonly flag: string;
}

interface SearchRow {
  readonly id: string;
  readonly snippet: string;
  readonly score: number;
}

function toRow(item: ClipboardItem): InboxRow {
  const preview: string = item.rawText.length > 120 ? `${item.rawText.slice(0, 120)}…` : item.rawText;
  let flag: string = '';
  if (item.sensitivity === Sensitivity.HIGH) {
    flag = '强特征敏感';
  } else if (item.sensitivity === Sensitivity.SUSPECTED) {
    flag = '疑似敏感';
  } else if (item.truncated) {
    flag = '已截断';
  }
  return {
    id: item.id,
    kind: item.kind as string,
    preview,
    needsConfirm: item.state === InboxState.AWAITING_CONFIRM,
    flag,
  };
}

@Entry
@Component
struct Index {
  @State inbox: InboxRow[] = [];
  @State searchRows: SearchRow[] = [];
  @State query: string = '';
  @State notice: string = '';

  private readonly svc: AppServices = AppServices.get();

  /**
   * 显式用户操作才读取剪贴板（设计 §4.1 矩阵：不预设本应用拥有后台读取权）。
   * 失败必须如实提示，不静默吞掉 —— 权限/空内容/系统控件拦截是三种不同原因。
   */
  private async captureFromPasteboard(): Promise<void> {
    try {
      const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      const data: pasteboard.PasteData = await board.getData();
      const text: string = data.getPrimaryText();
      if (text.length === 0) {
        this.notice = '剪贴板当前没有可保存的文本。';
        return;
      }
      const outcome: IngestOutcome = await this.svc.ingest.ingest({
        text,
        entry: ClipEntry.MANUAL,
      });
      this.applyOutcome(outcome);
    } catch (err) {
      // 不区分具体原因地"提示成功"是常见劣化：这里明确告知用户读取失败且未保存
      this.notice = `读取剪贴板失败，未保存任何内容。原因：${String(err)}`;
    }
  }

  private applyOutcome(outcome: IngestOutcome): void {
    if (outcome.decision === IngestDecision.REJECT) {
      this.notice = `未保存：${outcome.reasons.join('，')}`;
      return;
    }
    if (outcome.merged) {
      this.notice = '内容与刚才保存的一致，已合并为同一条（未产生重复）。';
      return;
    }
    this.inbox = [toRow(outcome.item)].concat(this.inbox);
    if (outcome.decision === IngestDecision.REQUIRE_CONFIRM) {
      this.notice = '内容疑似包含验证码/口令/密钥，**未自动保存**，请确认后再保存。';
    } else {
      this.notice = '已保存到收件箱。';
    }
    this.svc.index.put({ id: outcome.item.id, text: outcome.item.rawText });
  }

  private runSearch(): void {
    const hits = this.svc.index.search(this.query);
    const rows: SearchRow[] = [];
    for (let i: number = 0; i < hits.length; i++) {
      rows.push({
        id: hits[i].id,
        snippet: hits[i].snippet.text,
        score: hits[i].score,
      });
    }
    this.searchRows = rows;
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
        .onClick(() => {
          this.captureFromPasteboard();
        })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(13)
          .fontColor('#1F6FEB')
          .width('100%')
      }

      Row({ space: 8 }) {
        TextInput({ placeholder: '搜索已保存内容' })
          .layoutWeight(1)
          .onChange((value: string) => {
            this.query = value;
          })
        Button('搜索')
          .onClick(() => {
            this.runSearch();
          })
      }
      .width('100%')

      if (this.searchRows.length > 0) {
        List() {
          ForEach(this.searchRows, (row: SearchRow) => {
            ListItem() {
              Column({ space: 4 }) {
                Text(row.snippet).fontSize(14)
                Text(`相关度 ${row.score}`).fontSize(11).fontColor('#8C8C8C')
              }.alignItems(HorizontalAlign.Start).width('100%')
            }
          }, (row: SearchRow) => row.id)
        }
        .height(160)
        .width('100%')
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

      Text(`收件箱（${this.inbox.length}）`)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .width('100%')

      List({ space: 8 }) {
        ForEach(this.inbox, (row: InboxRow) => {
          ListItem() {
            Column({ space: 4 }) {
              Row({ space: 6 }) {
                Text(row.kind).fontSize(11).fontColor('#8C8C8C')
                if (row.flag.length > 0) {
                  Text(row.flag)
                    .fontSize(11)
                    .fontColor(row.needsConfirm ? '#D4380D' : '#8C8C8C')
                }
              }
              Text(row.preview).fontSize(14)
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
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
