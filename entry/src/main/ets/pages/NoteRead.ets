import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import {
  ATTACHMENT_SCHEME,
  attachmentRefOf,
  DocumentBlock,
  parseDocument,
} from 'common';
import {
  AvSessionControls,
  PlaybackState,
  SpeechPlaybackController,
  SpeechPlan,
  SpeechPlanItem,
  planSpeech,
} from 'speech';
import { AppServices } from '../services/AppServices';
import { ArkWebMarkdownTokenizer } from '../reader/ArkWebMarkdownTokenizer';

/**
 * MD 阅读页（S3-2 + S5-2 朗读接线；设计 §4.3 单一解析入口 / §4.4 渲染隔离 / §4.6 朗读 / G6）。
 *
 * 朗读链路（S5-2，调度全部在 speech HAR 内核，本页只做装配与回调）：
 *  块模型 → planSpeech（规范化 + ≤300 字切段 + 块锚点）→ SpeechPlaybackController
 *  （有界队列 + 代际切换）→ 系统离线引擎（playType=1 直接播报）。
 * 高亮：onSegmentStart 回映射块下标 → reader.js highlight(data-cl-i 锚点)。
 * 播控：AvSessionControls（通知栏/锁屏指令、焦点中断 → interrupt 段边界暂停）。
 * 进度口径：TTS-0 段播完按整段字符数回报，段落级高亮够用；段内进度属
 * playType=0 PCM 真机项（G4 §5-5），本页不实现。
 *
 * 渲染链路（一次解析，块模型复用）：
 *   笔记原文 → ArkWeb 内 markdown-it（reader.html 可信页）→ 桥接 Schema JSON
 *   → mdTokensFromJson → parseDocument → DocumentBlock[] → bridge.js 渲染进 DOM。
 *
 * G6 隔离口径（阻断性门槛，本页是落地边界）：
 *  - 可信域分离：页面与全部脚本随应用包发布（resource://rawfile/reader/），
 *    笔记正文是不可信输入，只经块模型 + 全量转义进入 DOM（reader.js buildReaderHtml）；
 *  - CSP：reader.html 内 meta 锁定 script-src 'self'、img-src attachment:/data:、
 *    default-src 'none'；内容中的图片/样式不会自动联网；
 *  - attachment:// 只按「本篇笔记已授权附件摘要」服务：进入页面前已预载
 *    （摘要 → 字节 + 登记 MIME），onInterceptRequest 同步查表，查不到一律 404；
 *    网页不可能传入任意沙箱路径（路径由摘要派生，网页只见 attachment://<sha>）；
 *  - 远程 http(s) 请求一律拦截为 404（默认离线，测试可观察网络请求为零）。
 *
 * 平台 API 编译口径声明（同 G1/S3-1 纪律）：本文件未经设备编译，按 API 12（5.0.0(12)）
 * 文档口径编写；真机编译若遇签名差异，以 SDK 报错为准修正调用形态。
 */

/** 未授权/缺失附件与远程请求的拦截响应：404 + 空体（不区分存在性，避免侧信道） */
function blockedResponse(): webview.WebResourceResponse {
  return new webview.WebResourceResponse('text/plain', 'utf-8', 404, 'Not Found', [], new Uint8Array(0));
}

@Entry
@Component
struct NoteRead {
  @State title: string = '';
  @State notice: string = '';
  @State ready: boolean = false;

  private noteId: string = '';
  private markdown: string = '';
  private revision: number = 1;
  /** 本篇已授权附件：摘要 → 预载字节；G6 只按授权附件 ID 服务 */
  private attachmentBytes: Map<string, Uint8Array> = new Map();
  /** 本篇已授权附件：摘要 → 登记 MIME（入库事实源，不做嗅探） */
  private attachmentMime: Map<string, string> = new Map();

  private readonly svc: AppServices = AppServices.get();
  private readonly controller: webview.WebviewController = new webview.WebviewController();
  private readonly tokenizer: ArkWebMarkdownTokenizer = new ArkWebMarkdownTokenizer();
  private renderStarted: boolean = false;

  // ---- 朗读（S5-2） ----
  private plan: SpeechPlan | undefined = undefined;
  private playback: SpeechPlaybackController | undefined = undefined;
  private readonly avControls: AvSessionControls = new AvSessionControls();
  private speechOrdinal: number = 0;
  @State playState: PlaybackState = 'idle';
  @State speechIndex: number = -1;
  @State speechNotice: string = '';

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, string> | undefined;
    if (params !== undefined && params !== null) {
      const v: string | undefined = params['noteId'];
      if (v !== undefined && v !== null) {
        this.noteId = v;
      }
    }
    this.loadNote();
    this.attachAvSession();
  }

  aboutToDisappear(): void {
    void this.avControls.stop();
    void this.playback?.stop();
    this.highlightBlock(-1);
  }

  /** AVSession 播控（S5-2）：通知栏/锁屏指令映射到控制器；焦点中断 → 段边界暂停 */
  private attachAvSession(): void {
    void this.avControls.start(
      getContext(this) as common.Context,
      {
        play: (): void => {
          this.speechNotice = '';
          void this.ensurePlayback().play();
        },
        pause: (): void => {
          void this.playback?.pause();
        },
        next: (): void => {
          void this.playback?.next();
        },
        prev: (): void => {
          void this.playback?.prev();
        },
        stop: (): void => {
          void this.playback?.stop();
        },
      },
      (reason: string): void => {
        void this.playback?.interrupt(reason);
        this.speechNotice = `已暂停：${reason}`;
      },
    );
  }

  /** 控制器惰性创建：回调全部 @State 绑定，调度逻辑不在本页（同 AppServices 纪律） */
  private ensurePlayback(): SpeechPlaybackController {
    if (this.playback === undefined) {
      this.playback = new SpeechPlaybackController(this.svc.speechEngine(), {
        onStateChange: (state: PlaybackState): void => {
          this.playState = state;
          if (state === 'ready') {
            this.speechIndex = -1;
            this.highlightBlock(-1);
          }
        },
        onSegmentStart: (item: SpeechPlanItem): void => {
          this.speechIndex = item.segment.index;
          this.highlightBlock(item.blockIndex);
        },
        onProgress: (): void => undefined,
        onSegmentFinish: (): void => undefined,
        onPlanComplete: (): void => {
          this.highlightBlock(-1);
        },
        onError: (reason: string): void => {
          this.speechNotice = `朗读失败：${reason}`;
        },
      });
    }
    return this.playback;
  }

  /** 段落级高亮：块下标 → reader.js 锚点（data-cl-i）；-1 清除。退页销毁后调用不致命 */
  private highlightBlock(blockIndex: number): void {
    try {
      this.controller.runJavaScript(
        `window.__clipnoteReader && window.__clipnoteReader.highlight(${blockIndex})`,
      );
    } catch {
      // Web 组件已销毁（退页竞态）：高亮丢失无妨
    }
  }

  private canSpeak(): boolean {
    return this.plan !== undefined && this.plan.items.length > 0;
  }

  private async loadNote(): Promise<void> {
    try {
      const svc = await this.svc.noteService();
      const note = await svc.getById(this.noteId);
      if (note === undefined) {
        this.notice = '笔记不存在或已删除。';
        return;
      }
      this.title = note.title;
      this.markdown = note.contentMd;
      this.revision = note.revision;
      // 预载本篇授权附件（字节 + MIME），拦截器同步查表；G6 不接受网页传入任意路径
      const images = await svc.listRenderableImages(this.noteId);
      for (let i: number = 0; i < images.length; i++) {
        const img = images[i];
        const bytes: Uint8Array = await this.svc.readAttachmentBytes(img.sha256);
        this.attachmentBytes.set(img.sha256, bytes);
        this.attachmentMime.set(img.sha256, img.mime);
      }
      this.ready = true;
      // Web 组件在 ready 后才进 build()，页面加载完成后 onPageEnd 驱动渲染
    } catch (err) {
      this.notice = `加载失败：${String(err)}`;
    }
  }

  /** 渲染链路：markdown-it 在 Web 内解析 → 块模型 → 渲染进 DOM（各步失败如实提示） */
  private renderDocument(): void {
    if (this.renderStarted) {
      return;
    }
    this.renderStarted = true;
    const sourceJson: string = JSON.stringify(this.markdown);
    this.controller.runJavaScript(`window.__clipnoteTokenize(${sourceJson})`, (err: Error, payload: string) => {
      if (err !== null && err !== undefined) {
        this.notice = `解析失败：${String(err)}`;
        return;
      }
      try {
        this.tokenizer.fetchFromBridge(payload);
        const blocks: DocumentBlock[] = parseDocument(this.tokenizer, this.markdown, {
          docRevision: this.revision,
        });
        // 朗读计划与渲染块模型同源（S5-2）：块数组就地规划，换篇即换计划，
        // 控制器作废旧代际；高亮锚点（blockIndex）与 data-cl-i 一致
        this.plan = planSpeech(blocks, this.markdown);
        if (this.canSpeak()) {
          this.speechOrdinal++;
          const ctl: SpeechPlaybackController = this.ensurePlayback();
          void ctl.load(this.plan as SpeechPlan).then((): void => {
            void this.avControls.updateMetadata(this.title, this.speechOrdinal);
          });
        }
        const blocksJson: string = JSON.stringify(blocks);
        this.controller.runJavaScript(
          `window.__clipnoteRender(${blocksJson}, ${sourceJson})`,
          (renderErr: Error) => {
            if (renderErr !== null && renderErr !== undefined) {
              this.notice = `渲染失败：${String(renderErr)}`;
            }
          },
        );
      } catch (parseErr) {
        this.notice = `解析失败：${String(parseErr)}`;
      }
    });
  }

  /**
   * 单篇可读导出（S4-2）：Markdown + 附件打 ZIP，经系统分享面板交接。
   * 与备份无关（导出 ≠ 备份，V1.4 F06）；附件缺失不阻断，如实提示保留原链接。
   */
  private async exportThis(): Promise<void> {
    try {
      const result = await this.svc.exportAndShare([this.noteId], 'single');
      this.notice = result.unresolved.length > 0
        ? `已导出。${result.unresolved.length} 个附件未能带上（正文中链接保留原样）。`
        : '已导出，正在拉起系统分享面板…';
    } catch (err) {
      this.notice = `导出失败：${String(err)}`;
    }
  }

  /**
   * 资源拦截（G6 核心边界）：
   *  - attachment://：只服务本篇已授权摘要（预载表命中），否则 404；
   *  - http(s)：一律 404（默认离线，内容不自动联网）；
   *  - 其余（页面自身的 resource:// 资产等）：走默认加载。
   */
  private interceptRequest(event: { request: webview.WebResourceRequest }): webview.WebResourceResponse | undefined {
    const url: string = event.request.getRequestUrl();
    if (url.startsWith(ATTACHMENT_SCHEME)) {
      const sha: string | undefined = attachmentRefOf(url);
      if (sha !== undefined && this.attachmentBytes.has(sha)) {
        const bytes: Uint8Array = this.attachmentBytes.get(sha) as Uint8Array;
        const mime: string = this.attachmentMime.has(sha) ? (this.attachmentMime.get(sha) as string) : 'application/octet-stream';
        return new webview.WebResourceResponse(mime, 'utf-8', bytes);
      }
      return blockedResponse();
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return blockedResponse();
    }
    return undefined;
  }

  build() {
    Column({ space: 10 }) {
      Row() {
        Text('‹ 返回')
          .fontSize(15)
          .fontColor('#1F6FEB')
          .onClick(() => {
            router.back();
          })
        Text(this.title)
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text('导出')
          .fontSize(15)
          .fontColor('#1F6FEB')
          .onClick(() => {
            this.exportThis();
          })
        Text('编辑')
          .fontSize(15)
          .fontColor('#1F6FEB')
          .margin({ left: 12 })
          .onClick(() => {
            router.pushUrl({ url: 'pages/NoteEdit', params: { 'noteId': this.noteId } });
          })
      }
      .width('100%')

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(13)
          .fontColor('#1F6FEB')
          .width('100%')
      }

      // ---- 朗读控制条（S5-2；调度在 speech 内核，本页仅按钮与状态） ----
      if (this.canSpeak()) {
        Column({ space: 4 }) {
          Row({ space: 12 }) {
            if (this.playState === 'playing') {
              Text('暂停')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  void this.playback?.pause();
                })
              Text('停止')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  void this.playback?.stop();
                })
              Text('上一段')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  void this.playback?.prev();
                })
              Text('下一段')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  void this.playback?.next();
                })
            } else if (this.playState === 'paused') {
              Text('继续')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  this.speechNotice = '';
                  void this.playback?.play();
                })
              Text('停止')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  void this.playback?.stop();
                })
            } else {
              Text('朗读')
                .fontSize(15)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  this.speechNotice = '';
                  void this.ensurePlayback().play();
                })
            }
          }
          .width('100%')

          if (this.playState === 'playing' || this.playState === 'paused') {
            Text(`朗读中 ${this.speechIndex + 1}/${(this.plan as SpeechPlan).items.length}`)
              .fontSize(12)
              .fontColor('#8C8C8C')
              .width('100%')
          }
          if (this.speechNotice.length > 0) {
            Text(this.speechNotice)
              .fontSize(12)
              .fontColor('#D4380D')
              .width('100%')
          }
        }
        .width('100%')
      }

      if (this.ready) {
        Web({ src: $rawfile('reader/reader.html'), controller: this.controller })
          .javaScriptAccess(true)
          .fileAccess(false)
          .onlineImageAccess(false)
          .domStorageAccess(false)
          .zoomAccess(false)
          .layoutWeight(1)
          .width('100%')
          .onPageEnd(() => {
            this.renderDocument();
          })
          .onInterceptRequest((event: { request: webview.WebResourceRequest }) => {
            return this.interceptRequest(event);
          })
      } else {
        Text('加载中…')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
