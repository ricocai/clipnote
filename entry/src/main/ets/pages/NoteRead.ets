import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import {
  ATTACHMENT_SCHEME,
  attachmentRefOf,
  DocumentBlock,
  parseDocument,
} from 'common';
import { AppServices } from '../services/AppServices';
import { ArkWebMarkdownTokenizer } from '../reader/ArkWebMarkdownTokenizer';

/**
 * MD 阅读页（S3-2；设计 §4.3 单一解析入口 / §4.4 渲染隔离 / G6）。
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

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, string> | undefined;
    if (params !== undefined && params !== null) {
      const v: string | undefined = params['noteId'];
      if (v !== undefined && v !== null) {
        this.noteId = v;
      }
    }
    this.loadNote();
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
        Text('编辑')
          .fontSize(15)
          .fontColor('#1F6FEB')
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
