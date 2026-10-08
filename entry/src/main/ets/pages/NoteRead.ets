import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import {
  ATTACHMENT_SCHEME,
  attachmentRefOf,
  DocumentBlock,
  parseDocument,
} from 'common';
import {
  AvSessionControls,
  DEFAULT_TTS_SETTINGS,
  PlaybackCommandSink,
  PlaybackState,
  SpeechPlaybackController,
  SpeechPlan,
  SpeechPlanItem,
  TtsEngineCapability,
  TtsVoiceSettings,
  TtsVoiceSettingsPatch,
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
 * 音色/语速（S5-4）：控制条内切换入口，直接接引擎层 updateSettings（收敛 →
 * preferences 持久化 → 段落边界生效，不新造状态机）；进页 capability() 预探测
 * （F-5 不可用置灰 + 文案 / F-6 启动即异步初始化预热），探测完成前一律置灰。
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
function blockedResponse(): WebResourceResponse {
  const res: WebResourceResponse = new WebResourceResponse();
  res.setResponseMimeType('text/plain');
  res.setResponseEncoding('utf-8');
  res.setResponseCode(404);
  res.setReasonMessage('Not Found');
  res.setResponseHeader([]);
  res.setResponseData(new Uint8Array(0).buffer as ArrayBuffer);
  return res;
}

/** 授权附件的拦截响应：按入库登记的 MIME 服务预载字节 */
function attachmentResponse(mime: string, bytes: Uint8Array): WebResourceResponse {
  const res: WebResourceResponse = new WebResourceResponse();
  // 状态行必须显式 200：缺省时 Web 内核按失败处理（真机实测图片不显示的根因之一）
  res.setResponseCode(200);
  res.setReasonMessage('OK');
  res.setResponseMimeType(mime);
  res.setResponseEncoding('utf-8');
  // 显式拷贝出独立 ArrayBuffer：Uint8Array 的 .buffer 视图在桥接层有原生类型检查
  // 风险（与 netstack send 实测同一纪律），且可杜绝视图偏移泄漏
  const buf: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  res.setResponseData(buf);
  return res;
}

/** 语速档位（SPEED_MIN~SPEED_MAX 域内常用值；离散档位比滑杆更不易误触，S5-4） */
const SPEED_OPTIONS: number[] = [0.75, 1, 1.25, 1.5, 2];

/** 音色选项：person 为系统发音人编号 */
interface VoiceOption {
  readonly person: number;
  readonly label: string;
}

/**
 * 阅读页 JS→ArkTS 桥（Q2b 段落双击起读）：经 javaScriptProxy 注入为
 * window.clipnoteBridge；bridge.js 的 dblclick 委托回调把 data-cl-i 块下标传回。
 */
class ReaderJsBridge {
  private readonly doubleTapHandler: (blockIndex: number) => void;

  constructor(doubleTapHandler: (blockIndex: number) => void) {
    this.doubleTapHandler = doubleTapHandler;
  }

  onBlockDoubleTap(blockIndex: number): void {
    this.doubleTapHandler(blockIndex);
  }
}

/** 可选音色：官方口径仅 person=0（聆小珊）确认（G4 探测 E2/E6），多音色枚举属 TTS-2 真机项 */
const VOICE_OPTIONS: VoiceOption[] = [{ person: 0, label: '聆小珊' }];

@Entry
@Component
struct NoteRead {
  @State title: string = '';
  @State notice: string = '';
  @State ready: boolean = false;
  /** 朗读计划就绪标记：plan 是普通字段，异步回调赋值后靠本 @State 触发 rebuild 显示控制条 */
  @State planReady: boolean = false;

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

  // ---- 朗读音色/语速（S5-4） ----
  /** TTS 可用性预探测结果（F-5/F-6）；探测完成前一律按不可用置灰（fail-safe） */
  @State ttsAvailable: boolean = false;
  @State ttsUnavailableReason: string = '';
  @State voicePerson: number = DEFAULT_TTS_SETTINGS.person;
  @State voiceSpeed: number = DEFAULT_TTS_SETTINGS.speed;

  /** Q2b：段落双击起读的 JS→ArkTS 桥（javaScriptProxy 注入 window.clipnoteBridge） */
  private readonly readerBridge: ReaderJsBridge = new ReaderJsBridge((blockIndex: number): void => {
    this.onBlockDoubleTap(blockIndex);
  });

  /**
   * 段落双击 = 从该段开始朗读（Q2b）：块下标 → 覆盖该块的第一个朗读项
   * （长段落被 ≤300 字切成多段时从首段起），seek 后确保进入播放态。
   * 引擎不可用/无计划时静默忽略（控制条已置灰提示，双击不另起提示）。
   */
  private onBlockDoubleTap(blockIndex: number): void {
    if (!this.ttsAvailable || this.plan === undefined || this.plan.items.length === 0) {
      return;
    }
    const items: readonly SpeechPlanItem[] = this.plan.items;
    let target: number = -1;
    for (let i: number = 0; i < items.length; i++) {
      if (items[i].blockIndex === blockIndex) {
        target = i;
        break;
      }
      if (items[i].blockIndex > blockIndex) {
        break; // 计划按块序排列，越过即不存在（如图片/分割线块无朗读项）
      }
    }
    if (target < 0) {
      return;
    }
    this.speechNotice = '';
    const ctl: SpeechPlaybackController = this.ensurePlayback();
    void ctl.seekToSegment(target).then((): void => {
      void ctl.play();
    });
  }

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
    void this.probeTts();
  }

  /**
   * TTS 可用性预探测（S5-4，F-5/F-6 口径）：进页即 capability()——探测同时完成
   * 「启动即异步初始化」预热（首声不再含建引擎开销）；不可用 → 控制条置灰 + 文案，
   * 可用 → 回读持久化音色/语速作控件初值（默认值沿用引擎层默认）。
   * 探测挂起即 bug：超时如实降级为「朗读不可用」，不得无声无息（真机验收教训）。
   */
  private async probeTts(): Promise<void> {
    /** 探测超时阈值（引擎创建/设置装载均属本地调用，8s 足够宽松） */
    const PROBE_TIMEOUT_MS: number = 8000;
    try {
      const engine = this.svc.speechEngine();
      const cap: TtsEngineCapability = await Promise.race([
        engine.capability(),
        new Promise<TtsEngineCapability>((resolve: (value: TtsEngineCapability) => void): void => {
          setTimeout((): void => {
            resolve({
              available: false,
              engineName: 'system-text-to-speech',
              offline: true,
              voiceCount: 0,
              reason: '引擎探测超时',
            });
          }, PROBE_TIMEOUT_MS);
        }),
      ]);
      if (!cap.available) {
        this.ttsUnavailableReason = cap.reason ?? '系统 TTS 不可用';
        return;
      }
      this.ttsAvailable = true;
      const saved: TtsVoiceSettings = await engine.updateSettings({});
      this.voicePerson = saved.person;
      this.voiceSpeed = saved.speed;
    } catch (err) {
      this.ttsUnavailableReason = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * 音色/语速切换（S5-4）：直接接引擎层 updateSettings——收敛 → preferences 持久化 →
   * 生效；播放中不中断在播段，新参数按段落边界生效（引擎段间回 idle 时重建，S5-1 语义），
   * 不新造状态机。控件回显以引擎返回的收敛值为准。
   */
  private async applyVoiceSettings(patch: TtsVoiceSettingsPatch): Promise<void> {
    const saved: TtsVoiceSettings = await this.svc.speechEngine().updateSettings(patch);
    this.voicePerson = saved.person;
    this.voiceSpeed = saved.speed;
  }

  aboutToDisappear(): void {
    void this.avControls.stop();
    void this.playback?.stop();
    this.highlightBlock(-1);
  }

  /** AVSession 播控（S5-2）：通知栏/锁屏指令映射到控制器；焦点中断 → 段边界暂停 */
  private attachAvSession(): void {
    const sink: PlaybackCommandSink = {
      play: (): void => {
        if (!this.ttsAvailable || !this.canSpeak()) {
          return; // 引擎不可用/无朗读计划时不触发（S5-4 禁用口径；play 对空计划会 throw）
        }
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
    };
    void this.avControls.start(
      getContext(this) as common.Context,
      sink,
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
      // 单个附件缺失（如 blob 文件丢失）不拖垮整篇：如实记日志、跳过该附件，
      // 其余内容照常渲染；缺失图片在拦截层走 MISS → 404 占位，hilog 留证。
      const images = await svc.listRenderableImages(this.noteId);
      let preloaded: number = 0;
      for (let i: number = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const bytes: Uint8Array = await this.svc.readAttachmentBytes(img.sha256);
          this.attachmentBytes.set(img.sha256, bytes);
          this.attachmentMime.set(img.sha256, img.mime);
          preloaded++;
        } catch (imgErr) {
          hilog.error(0xF1C1, 'ClipNoteRead', 'attachment preload failed sha=%{public}s err=%{public}s',
            img.sha256, String(imgErr));
        }
      }
      // Q1 验收期诊断：预载规模留证（images 与 preloaded 不一致即有附件没读出来）
      hilog.info(0xF1C1, 'ClipNoteRead', 'note loaded id=%{public}s images=%{public}d preloaded=%{public}d',
        this.noteId, images.length, preloaded);
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
    // 桥接约定（bridge.js）：入参是 JSON 文本，函数体内自行 JSON.parse。
    // 经 JS 源码拼接调用时实参会先被 JS 引擎解一层字符串字面量，
    // 因此这里必须再套一层 JSON.stringify（双重编码），桥内 parse 后才拿到原文/对象。
    this.controller.runJavaScript(`window.__clipnoteTokenize(${JSON.stringify(sourceJson)})`, (err: Error, payload: string) => {
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
        // plan 是普通字段且在本异步回调中赋值：必须显式触发一次 rebuild，
        // 否则「probeTts 先于 plan 完成」时序下控制条永远不出现（真机/模拟器实测）
        this.planReady = this.canSpeak();
        if (this.planReady) {
          this.speechOrdinal++;
          const ctl: SpeechPlaybackController = this.ensurePlayback();
          void ctl.load(this.plan as SpeechPlan).then((): void => {
            void this.avControls.updateMetadata(this.title, this.speechOrdinal);
          });
        }
        const blocksJson: string = JSON.stringify(blocks);
        this.controller.runJavaScript(
          `window.__clipnoteRender(${JSON.stringify(blocksJson)}, ${JSON.stringify(sourceJson)})`,
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
  private interceptRequest(event: OnInterceptRequestEvent): WebResourceResponse | undefined {
    const url: string = event.request.getRequestUrl();
    if (url.startsWith(ATTACHMENT_SCHEME)) {
      const sha: string | undefined = attachmentRefOf(url);
      if (sha !== undefined && this.attachmentBytes.has(sha)) {
        const bytes: Uint8Array = this.attachmentBytes.get(sha) as Uint8Array;
        const mime: string = this.attachmentMime.has(sha) ? (this.attachmentMime.get(sha) as string) : 'application/octet-stream';
        // Q1 验收期诊断（随 G1 探针一并移除）：拦截命中即留证，真机/模拟器可对 hilog
        hilog.info(0xF1C1, 'ClipNoteRead', 'attachment hit sha=%{public}s len=%{public}d mime=%{public}s',
          sha.slice(0, 12), bytes.byteLength, mime);
        return attachmentResponse(mime, bytes);
      }
      // 未命中（sha 非法或附件未预载）是图片不显示的最大嫌疑路径，必须留证
      hilog.error(0xF1C1, 'ClipNoteRead', 'attachment MISS url=%{public}s sha=%{public}s preloaded=%{public}d',
        url, sha === undefined ? 'illegal' : sha.slice(0, 12), this.attachmentBytes.size);
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

      // ---- 朗读控制条（S5-2 播控 + S5-4 音色/语速入口；调度在 speech 内核，本页仅按钮与状态） ----
      // planReady 是 rebuild 触发点（plan 为普通字段）；canSpeak() 复核计划非空
      if (this.planReady && this.canSpeak()) {
        Column({ space: 4 }) {
          Row({ space: 12 }) {
            if (this.playState === 'playing') {
              Text('暂停')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return;
                  }
                  void this.playback?.pause();
                })
              Text('停止')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return;
                  }
                  void this.playback?.stop();
                })
              Text('上一段')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return;
                  }
                  void this.playback?.prev();
                })
              Text('下一段')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return;
                  }
                  void this.playback?.next();
                })
            } else if (this.playState === 'paused') {
              Text('继续')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return;
                  }
                  this.speechNotice = '';
                  void this.playback?.play();
                })
              Text('停止')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return;
                  }
                  void this.playback?.stop();
                })
            } else {
              Text('朗读')
                .fontSize(15)
                .fontColor(this.ttsAvailable ? '#1F6FEB' : '#B0B0B0')
                .onClick(() => {
                  if (!this.ttsAvailable) {
                    return; // 探测失败不允许触发（F-5 置灰口径），杜绝 failed 态反复重试
                  }
                  this.speechNotice = '';
                  void this.ensurePlayback().play();
                })
            }
          }
          .width('100%')

          // ---- 音色切换（S5-4）：接引擎层 updateSettings，偏好持久化，段落边界生效 ----
          Row({ space: 8 }) {
            Text('音色')
              .fontSize(13)
              .fontColor('#8C8C8C')
            ForEach(VOICE_OPTIONS, (voice: VoiceOption) => {
              Text(voice.label)
                .fontSize(13)
                .fontColor(this.voicePerson === voice.person
                  ? '#FFFFFF'
                  : (this.ttsAvailable ? '#1F6FEB' : '#B0B0B0'))
                .backgroundColor(this.voicePerson === voice.person ? '#1F6FEB' : '#F0F0F0')
                .borderRadius(6)
                .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                .onClick(() => {
                  if (this.ttsAvailable) {
                    void this.applyVoiceSettings({ person: voice.person });
                  }
                })
            }, (voice: VoiceOption) => `voice-${voice.person}`)
          }
          .width('100%')

          // ---- 语速切换（S5-4）：档位在 SPEED_MIN~SPEED_MAX 合法域内，越界由引擎层收敛 ----
          Row({ space: 8 }) {
            Text('语速')
              .fontSize(13)
              .fontColor('#8C8C8C')
            ForEach(SPEED_OPTIONS, (speed: number) => {
              Text(`${speed}x`)
                .fontSize(13)
                .fontColor(this.voiceSpeed === speed
                  ? '#FFFFFF'
                  : (this.ttsAvailable ? '#1F6FEB' : '#B0B0B0'))
                .backgroundColor(this.voiceSpeed === speed ? '#1F6FEB' : '#F0F0F0')
                .borderRadius(6)
                .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                .onClick(() => {
                  if (this.ttsAvailable) {
                    void this.applyVoiceSettings({ speed: speed });
                  }
                })
            }, (speed: number) => `speed-${speed}`)
          }
          .width('100%')

          Text('双击正文段落可从该段开始朗读')
            .fontSize(11)
            .fontColor('#8C8C8C')
            .width('100%')

          if (!this.ttsAvailable) {
            Text(this.ttsUnavailableReason.length > 0
              ? `朗读不可用：${this.ttsUnavailableReason}`
              : '朗读引擎检测中…')
              .fontSize(12)
              .fontColor('#D4380D')
              .width('100%')
          }
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
          // 不得加 onlineImageAccess(false)：它会在到达 onInterceptRequest 之前吞掉
          // attachment:// 图片请求（不触发 onload/onerror、拦截器零命中）——真机验收
          // Q1「图片不显示」的根因（X7 模拟器场景E/F/G/H 二分实证，非权限问题）。
          // G6 禁远程图由两层兜底，不依赖该开关：
          //   ① reader.html CSP img-src attachment: data:（http(s) 图根本不发请求）
          //   ② interceptRequest 对 http(s) 一律 blockedResponse
          .domStorageAccess(false)
          .zoomAccess(false)
          .javaScriptProxy({
            object: this.readerBridge,
            name: 'clipnoteBridge',
            methodList: ['onBlockDoubleTap'],
            controller: this.controller,
          })
          .layoutWeight(1)
          .width('100%')
          .onPageEnd(() => {
            this.renderDocument();
          })
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
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
