import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common, Want } from '@kit.AbilityKit';
import {
  ATTACHMENT_SCHEME,
  attachmentRefOf,
  CONTENT_TYPE_HTML,
  HtmlAuditEvent,
  LogLevel,
  Note,
  NoteSource,
  sanitizeHtml,
} from 'common';
import { AppServices } from '../services/AppServices';

/**
 * 受控 HTML 展示页（S3-3；设计 §4.4 信任域分离 / G6 渲染隔离，阻断性门槛）。
 *
 * 三道防线（互不依赖，任一独立成立恶意内容都无法执行）：
 *  1. 清洗（common/core/htmlsafe.ts）：笔记原文先静态化 —— 元素白名单、无脚本、
 *     无事件属性、无 iframe/表单/重定向、URL 协议白名单（仅 attachment:// 与
 *     data:image/*）—— 产出与审计事件后才进 Web；
 *  2. 平台开关（下方 Web 组件）：javaScriptAccess(false) 硬断脚本执行、
 *     fileAccess(false) 断文件通道（onlineImageAccess 不得关闭，会先于拦截器
 *     吞掉 attachment:// 请求——真机验收 Q1 根因；远程图由防线 3 CSP 兜底）；
 *  3. CSP（rawfile/htmlview/htmlview.html meta）：script-src 'self'、
 *     img-src attachment: data:、default-src 'none' 断其余一切。
 *
 * 资源拦截（onInterceptRequest）：
 *  - attachment://：只服务「清洗后文档引用的摘要 ∩ 本篇已授权附件」预载表，
 *    查不到一律 404（不区分存在性，防侧信道）；
 *  - http(s)/file 等一切非包内资源：404 并写审计 —— 默认离线，测试可观察网络为零；
 *  - resource://rawfile/（可信壳自身资产）：走默认加载。
 *
 * 只读语义：本页无任何编辑入口；导出是**数据交接**（原始 HTML 经系统分享交给
 * 用户选择的应用，显式用户动作），与编辑无关。来源标识如实展示 note.source。
 *
 * 审计（设计 §4.5.5 口径：类别 + 截断细节，不记正文）：
 *  - 打开：html_view_opened（来源/正文大小/拦截计数）；
 *  - 清洗拦截：html_view_blocked（按类别计数 + 至多 5 条样例）；
 *  - 渲染期拦截：html_view_request_blocked（被 404 的 URL 前缀）。
 *
 * 平台 API 编译口径声明（同 S3-2 纪律）：本文件未经设备编译，按 API 12（5.0.0(12)）
 * 文档口径编写；真机编译若遇签名差异，以 SDK 报错为准修正调用形态。
 */

/** 审计样例条数上限（详情截断由 htmlsafe 层保证，这里只限条数防日志洪峰） */
const AUDIT_SAMPLE_LIMIT: number = 5;

const SOURCE_LABELS: Record<string, string> = {
  'clipboard': '剪贴板',
  'share': '系统分享',
  'manual': '手动创建',
  'import': '导入',
  'mcp': 'MCP',
};

function sourceLabel(source: NoteSource): string {
  const key: string = String(source);
  const label: string | undefined = SOURCE_LABELS[key];
  return label === undefined ? key : label;
}

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
  // 显式拷贝出独立 ArrayBuffer（Uint8Array .buffer 视图的桥接层类型检查/偏移风险）
  const buf: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  res.setResponseData(buf);
  return res;
}

@Entry
@Component
struct HtmlRead {
  @State title: string = '';
  @State notice: string = '';
  @State sourceLabel: string = '';
  @State blockedCount: number = 0;
  @State ready: boolean = false;

  private noteId: string = '';
  private rawHtml: string = '';
  /** 清洗产物：进入 Web 的唯一内容通道 */
  private sanitizedHtml: string = '';
  /** 本篇已授权附件：摘要 → 预载字节（G6 只按授权附件 ID 服务） */
  private attachmentBytes: Map<string, Uint8Array> = new Map();
  /** 本篇已授权附件：摘要 → 登记 MIME（入库事实源，不做嗅探） */
  private attachmentMime: Map<string, string> = new Map();

  private readonly svc: AppServices = AppServices.get();
  private readonly controller: webview.WebviewController = new webview.WebviewController();
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
      const note: Note | undefined = await svc.getById(this.noteId);
      if (note === undefined) {
        this.notice = '笔记不存在或已删除。';
        return;
      }
      if (note.contentType !== CONTENT_TYPE_HTML) {
        this.notice = '该笔记不是 HTML 内容。';
        return;
      }
      this.title = note.title;
      this.sourceLabel = sourceLabel(note.source);
      this.rawHtml = note.contentMd;

      // 第一道防线：静态化清洗（产物 + 审计事件）
      const result = sanitizeHtml(this.rawHtml);
      this.sanitizedHtml = result.html;
      this.blockedCount = result.events.length;
      this.writeAudit(note, result.events);

      // 预载本篇授权附件（只服务「清洗后引用 ∩ 本篇 INLINE_IMAGE 附件」）
      const renderable = await svc.listRenderableImages(this.noteId);
      const authorized: Set<string> = new Set();
      for (let i: number = 0; i < renderable.length; i++) {
        authorized.add(renderable[i].sha256);
      }
      for (let i: number = 0; i < result.attachmentRefs.length; i++) {
        const sha: string = result.attachmentRefs[i];
        if (!authorized.has(sha)) {
          continue;
        }
        const bytes: Uint8Array = await this.svc.readAttachmentBytes(sha);
        this.attachmentBytes.set(sha, bytes);
        for (let k: number = 0; k < renderable.length; k++) {
          if (renderable[k].sha256 === sha) {
            this.attachmentMime.set(sha, renderable[k].mime);
          }
        }
      }
      this.ready = true;
      // Web 组件在 ready 后才进 build()，页面加载完成后 onPageEnd 驱动渲染
    } catch (err) {
      this.notice = `加载失败：${String(err)}`;
    }
  }

  /** 审计落日志（§4.5.5：类别 + 截断细节，不记正文；详情截断 htmlsafe 已保证） */
  private writeAudit(note: Note, events: HtmlAuditEvent[]): void {
    const counts: Record<string, number> = {};
    counts['tag_removed'] = 0;
    counts['attr_removed'] = 0;
    counts['url_blocked'] = 0;
    counts['css_blocked'] = 0;
    for (let i: number = 0; i < events.length; i++) {
      counts[events[i].kind] += 1;
    }
    const openedFields: Record<string, string | number | boolean> = {};
    openedFields['noteId'] = this.noteId;
    openedFields['source'] = String(note.source);
    openedFields['bytes'] = this.rawHtml.length;
    openedFields['blocked'] = events.length;
    this.svc.logger.log(LogLevel.INFO, 'html_view_opened', openedFields);
    if (events.length > 0) {
      const blockedFields: Record<string, string | number | boolean> = {};
      blockedFields['noteId'] = this.noteId;
      blockedFields['tag_removed'] = counts['tag_removed'];
      blockedFields['attr_removed'] = counts['attr_removed'];
      blockedFields['url_blocked'] = counts['url_blocked'];
      blockedFields['css_blocked'] = counts['css_blocked'];
      this.svc.logger.log(LogLevel.WARN, 'html_view_blocked', blockedFields);
      for (let i: number = 0; i < events.length && i < AUDIT_SAMPLE_LIMIT; i++) {
        const sampleFields: Record<string, string | number | boolean> = {};
        sampleFields['noteId'] = this.noteId;
        sampleFields['kind'] = events[i].kind;
        sampleFields['detail'] = events[i].detail;
        this.svc.logger.log(LogLevel.WARN, 'html_view_blocked_sample', sampleFields);
      }
    }
  }

  /** 渲染：清洗产物一次性注入可信壳（各步失败如实提示） */
  private renderDocument(): void {
    if (this.renderStarted) {
      return;
    }
    this.renderStarted = true;
    const payload: string = JSON.stringify({ html: this.sanitizedHtml });
    this.controller.runJavaScript(`window.__clipnoteSetHtml(${payload})`, (err: Error) => {
      if (err !== null && err !== undefined) {
        this.notice = `渲染失败：${String(err)}`;
      }
    });
  }

  /**
   * 资源拦截（G6 核心边界）：
   *  - attachment://：只服务预载授权表（清洗后引用 ∩ 本篇附件），否则 404 + 审计；
   *  - resource://rawfile/：可信壳自身资产，走默认加载；
   *  - 其余（http(s)/file/data:text 等一切外部或非包内资源）：一律 404 + 审计。
   */
  private interceptRequest(event: OnInterceptRequestEvent): WebResourceResponse | undefined {
    const url: string = event.request.getRequestUrl();
    if (url.startsWith(ATTACHMENT_SCHEME)) {
      const sha: string | undefined = attachmentRefOf(url);
      if (sha !== undefined && this.attachmentBytes.has(sha)) {
        const bytes: Uint8Array = this.attachmentBytes.get(sha) as Uint8Array;
        const mime: string = this.attachmentMime.has(sha) ? (this.attachmentMime.get(sha) as string) : 'application/octet-stream';
        return attachmentResponse(mime, bytes);
      }
      this.logRequestBlocked(url);
      return blockedResponse();
    }
    if (url.startsWith('resource://')) {
      return undefined;
    }
    this.logRequestBlocked(url);
    return blockedResponse();
  }

  /** 渲染期拦截审计（类别 + 截断 URL 前缀，不记正文） */
  private logRequestBlocked(url: string): void {
    const fields: Record<string, string | number | boolean> = {};
    fields['noteId'] = this.noteId;
    fields['url'] = url.slice(0, 64);
    this.svc.logger.log(LogLevel.WARN, 'html_view_request_blocked', fields);
  }

  /** 导出 = 数据交接：原始 HTML 经系统分享交给用户选择的应用（显式用户动作，与编辑无关） */
  private exportHtml(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const want: Want = {
        action: 'ohos.want.action.sendData',
        type: CONTENT_TYPE_HTML,
        parameters: {
          'ability.want.params.TEXT': this.rawHtml,
        },
      };
      ctx.startAbility(want);
      const exportedFields: Record<string, string | number | boolean> = {};
      exportedFields['noteId'] = this.noteId;
      exportedFields['bytes'] = this.rawHtml.length;
      this.svc.logger.log(LogLevel.INFO, 'html_view_exported', exportedFields);
    } catch (err) {
      this.notice = `导出失败：${String(err)}`;
    }
  }

  /**
   * 删除本篇（= 移入回收站，软删除；与列表页同一口径 §4.2）。
   * HTML 笔记是只读展示页，但它同样是"单篇笔记"的落点，删除入口不应只在列表里。
   */
  private confirmDelete(): void {
    const name: string = this.title.length > 0 ? this.title : '未命名笔记';
    AlertDialog.show({
      title: '移入回收站',
      message: `《${name}》将移入回收站，从列表消失；可在「回收站」中恢复。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '移入回收站',
        fontColor: '#D4380D',
        action: () => {
          this.doDelete();
        },
      },
    });
  }

  private async doDelete(): Promise<void> {
    try {
      const svc = await this.svc.noteService();
      await svc.moveToTrash(this.noteId);
      try {
        const st = router.getState();
        if (st !== undefined && st !== null && st.index > 0) {
          router.back();
          return;
        }
      } catch {
        // 栈状态异常：按栈底处理，兜底去笔记库
      }
      void router.replaceUrl({ url: 'pages/NoteList' });
    } catch (err) {
      this.notice = `删除失败：${String(err)}`;
    }
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
            this.exportHtml();
          })
        Text('删除')
          .fontSize(15)
          .fontColor('#D4380D')
          .margin({ left: 12 })
          .onClick(() => {
            this.confirmDelete();
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
        // 来源标识 + 只读语义 + 拦截计数（如实呈现，0 拦截也明示「无脚本静态展示」）
        Text() {
          Span(`来源：${this.sourceLabel} · 只读展示`)
          if (this.blockedCount > 0) {
            Span(` · 已静态化，拦截 ${this.blockedCount} 处活跃内容`)
              .fontColor('#D4380D')
          } else {
            Span(' · 纯静态内容，无脚本')
          }
        }
        .fontSize(12)
        .fontColor('#8C8C8C')
        .width('100%')

        Web({ src: $rawfile('htmlview/htmlview.html'), controller: this.controller })
          .javaScriptAccess(false)
          .fileAccess(false)
          // 同 NoteRead：不得加 onlineImageAccess(false)——它先于拦截器吞掉
          // attachment:// 请求（真机验收 Q1 根因，X7 二分实证）；远程图由
          // htmlview CSP img-src + interceptRequest 对 http(s) 回 404 双兜底
          .domStorageAccess(false)
          .zoomAccess(false)
          .layoutWeight(1)
          .width('100%')
          .onPageEnd(() => {
            this.renderDocument();
          })
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
            return this.interceptRequest(event);
          })
      } else if (this.notice.length === 0) {
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
