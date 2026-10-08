import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { G1ProbeEntry, G1ProbeLog } from '../probe/G1ProbeLog';
import { SCENE, probeClipboardRead, probePasteButtonRead, recordDeviceInfo } from '../probe/G1ProbeScenes';
import { AppServices } from '../services/AppServices';
import { Note, NoteService, ImageImportResult } from 'common';

// ---- 临时探针（Q1 排障用，验收后随 G1 设施一并移除）----
// 1x1 透明 PNG，验证 WebResourceResponse 构造（与 NoteRead.attachmentResponse 同写法）
const PROBE_PNG: number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0x50,
  0x0f, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xa9, 0x8c, 0x21, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];
const PROBE_HTML: string = 'data:text/html,<html><body><img src="attachment://probe" ' +
  'onload="document.title=\'LOADED\'" onerror="document.title=\'ERROR\'"></body></html>';

/** 与 NoteRead.attachmentResponse 完全相同的构造（setter + 显式 200 + 独立 ArrayBuffer） */
function probePngResponse(): WebResourceResponse {
  const bytes: Uint8Array = new Uint8Array(PROBE_PNG);
  const res: WebResourceResponse = new WebResourceResponse();
  res.setResponseCode(200);
  res.setReasonMessage('OK');
  res.setResponseMimeType('image/png');
  res.setResponseEncoding('utf-8');
  const buf: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  res.setResponseData(buf);
  return res;
}

/** 对照组：404 构造（与 NoteRead.blockedResponse 同写法） */
function probe404Response(): WebResourceResponse {
  const res: WebResourceResponse = new WebResourceResponse();
  res.setResponseMimeType('text/plain');
  res.setResponseEncoding('utf-8');
  res.setResponseCode(404);
  res.setReasonMessage('Not Found');
  res.setResponseHeader([]);
  res.setResponseData(new ArrayBuffer(0));
  return res;
}

/**
 * G1 临时探测页（WHY-90，临时设施，G1 验收后随探针模块一并移除）。
 *
 * 覆盖报告待复测项中"必须有用户在场"的场景：
 *   - 场景A：按钮手势触发主动读取（对照无手势的回前台读取）；
 *   - 场景B：PasteButton 安全控件免弹窗读取；
 *   - 分享接收与回前台读取由 EntryAbility 探针块自动记录，本页只展示日志。
 *
 * 页面不存状态：每次点开都从 G1ProbeLog 缓冲重读，保证展示与落盘 JSONL 一致。
 */
@Entry
@Component
struct G1ProbePage {
  @State entries: G1ProbeEntry[] = [];
  @State logPath: string = '';
  /** Q1 临时探针：是否挂载 Web 验证组件 */
  @State webProbeOn: boolean = false;
  private webCtl: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    recordDeviceInfo();
    this.refresh();
  }

  private refresh(): void {
    this.entries = G1ProbeLog.entries().slice().reverse();
    this.logPath = G1ProbeLog.path();
  }

  /** Q1 探针：serve404=true 走 404 对照（期望 ERROR）；false 走 200 PNG（期望 LOADED） */
  private webProbeServe404: boolean = false;
  /** Q1 探针：主 frame 用 rawfile（resource: 域，与阅读页同源）还是 data:（默认） */
  private webProbeRawfile: boolean = false;
  /** Q1 探针：是否叠加阅读页全部 Web 开关（场景F 二分用） */
  private webProbeNoteReadFlags: boolean = false;
  /** Q1 探针：单开关二分（G=onlineImageAccess、H=fileAccess、其余=''不叠加） */
  private webProbeSingleFlag: string = '';

  /** Q1 探针：用与 NoteRead 完全相同的构造回 1x1 PNG（或 404 对照），img.onload/onerror 写 title */
  private probeWebResponse(serve404: boolean, rawfileMain: boolean = false, noteReadFlags: boolean = false, singleFlag: string = ''): void {
    this.webProbeServe404 = serve404;
    this.webProbeRawfile = rawfileMain;
    this.webProbeNoteReadFlags = noteReadFlags;
    this.webProbeSingleFlag = singleFlag;
    this.webProbeOn = false;
    // 先卸载再重挂 Web，强制重新发起请求（同 src 复用组件时不保证重载）
    setTimeout(() => {
      this.webProbeOn = true;
      setTimeout(() => {
        this.webCtl.runJavaScript('document.title', (err: Error, result: string) => {
          const title: string = String(result);
          const loaded: boolean = title.includes('LOADED');
          const errored: boolean = title.includes('ERROR');
          // 判定口径：200 组必须 LOADED；404 组必须 ERROR——两组合起来才证明
          // 「attachment:// 请求到达了拦截器」且「响应构造被内核接受」
          const ok: boolean = serve404 ? errored : loaded;
          const scene: string = noteReadFlags ? 'q1-web-nrflags' : (singleFlag.length > 0 ? `q1-web-flag-${singleFlag}` : (rawfileMain ? 'q1-web-rawfile' : (serve404 ? 'q1-web-404' : 'q1-web-200')));
          G1ProbeLog.record(scene, ok,
            `img title=${title} err=${String(err)} expect=${serve404 ? 'ERROR' : 'LOADED'} main=${rawfileMain ? 'resource' : 'data'} nrFlags=${noteReadFlags}`);
          this.refresh();
        });
      }, 2000);
    }, 100);
  }

  /**
   * Q1 端到端探针：走真实业务链路造一篇带图笔记并打开阅读页——
   * save → importImage（CAS 落盘 + 引用提交）→ NoteRead 渲染，
   * 阅读页拦截器 hit/miss 与预载规模全部进 hilog（tag ClipNoteRead）。
   */
  private async probeEndToEnd(): Promise<void> {
    try {
      const svc: NoteService = await AppServices.get().noteService();
      const note: Note = await svc.save({
        title: '探针-图片显示验证',
        contentMd: '# 探针\n\n下面应显示一个 1x1 像素点（几乎不可见，以 hilog 判定为准）。\n',
      });
      // importImage 只入附件库、不改正文（调用方责任），必须把返回的引用片段写回笔记，
      // 否则阅读页无图可渲染——探针就测了个寂寞（本轮实测踩中，已修正）
      const img: ImageImportResult = await svc.importImage(note.id, new Uint8Array(PROBE_PNG), 'image/png', '探针图');
      await svc.save({
        id: note.id,
        title: note.title,
        contentMd: note.contentMd + '\n' + img.markdownSnippet + '\n',
      });
      G1ProbeLog.record('q1-e2e-create', true, `noteId=${note.id} sha=${img.sha256.slice(0, 12)}，即将打开阅读页`);
      this.refresh();
      router.pushUrl({ url: 'pages/NoteRead', params: { 'noteId': note.id } });
    } catch (err) {
      G1ProbeLog.record('q1-e2e-create', false, `造数失败：${String(err)}`);
      this.refresh();
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        Button('返回')
          .onClick(() => {
            router.back();
          })
        Text('G1 探测（临时）')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
      }
      .width('100%')

      Text('每个按钮对应报告的一个待复测问题；结果同时写 hilog 与沙箱 JSONL，用 hdc 拉回后归档。')
        .fontSize(12)
        .fontColor('#8C8C8C')
        .width('100%')

      Button('场景A：手势触发读取剪贴板（枚举数据类型）')
        .width('100%')
        .onClick(async () => {
          await probeClipboardRead(SCENE.MANUAL_READ, 'manual-button');
          this.refresh();
        })

      // 场景B：安全控件。样式受系统校验（不可透明/遮挡/过小），这里用默认样式保证授权路径有效。
      PasteButton()
        .width('100%')
        .height(40)
        .onClick(async (event: ClickEvent, result: PasteButtonOnClickResult) => {
          G1ProbeLog.record(SCENE.PASTE_BUTTON, result === PasteButtonOnClickResult.SUCCESS,
            `pasteButton onClick result=${result}`);
          if (result === PasteButtonOnClickResult.SUCCESS) {
            await probePasteButtonRead();
          }
          this.refresh();
        })

      Text(`日志文件：${this.logPath}`)
        .fontSize(11)
        .fontColor('#8C8C8C')
        .width('100%')

      Button('场景C1（Q1）：attachment:// 200 PNG（期望 LOADED）')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse(false);
        })

      Button('场景C2（Q1 对照）：attachment:// 404（期望 ERROR）')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse(true);
        })

      Button('场景D（Q1 端到端）：造带图笔记并打开阅读页（看 hilog）')
        .width('100%')
        .onClick(() => {
          this.probeEndToEnd();
        })

      Button('场景E（Q1 决定性）：rawfile 主 frame + attachment 图（期望 LOADED）')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse(false, true);
        })

      Button('场景F（Q1 二分）：rawfile + 阅读页全部 Web 开关（期望定位元凶）')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse(false, true, true);
        })

      Button('场景G（Q1 单开关）：rawfile + 仅 onlineImageAccess(false)')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse(false, true, false, 'oia');
        })

      Button('场景H（Q1 单开关）：rawfile + 仅 fileAccess(false)')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse(false, true, false, 'fa');
        })

      if (this.webProbeOn && this.webProbeNoteReadFlags) {
        Web({ src: $rawfile('reader/probe-scheme.html'), controller: this.webCtl })
          .width('100%')
          .height(60)
          // 场景F：与 NoteRead 完全同参（javaScriptAccess/fileAccess/onlineImageAccess/
          // domStorageAccess/zoomAccess），逐个对回即定位阻断 attachment:// 的开关
          .javaScriptAccess(true)
          .fileAccess(false)
          .onlineImageAccess(false)
          .domStorageAccess(false)
          .zoomAccess(false)
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
            const url: string = event.request.getRequestUrl();
            if (url.startsWith('attachment://')) {
              return this.webProbeServe404 ? probe404Response() : probePngResponse();
            }
            return undefined;
          })
      }

      if (this.webProbeOn && !this.webProbeNoteReadFlags && this.webProbeSingleFlag === 'oia') {
        Web({ src: $rawfile('reader/probe-scheme.html'), controller: this.webCtl })
          .width('100%')
          .height(60)
          .onlineImageAccess(false)
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
            const url: string = event.request.getRequestUrl();
            if (url.startsWith('attachment://')) {
              return this.webProbeServe404 ? probe404Response() : probePngResponse();
            }
            return undefined;
          })
      }

      if (this.webProbeOn && !this.webProbeNoteReadFlags && this.webProbeSingleFlag === 'fa') {
        Web({ src: $rawfile('reader/probe-scheme.html'), controller: this.webCtl })
          .width('100%')
          .height(60)
          .fileAccess(false)
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
            const url: string = event.request.getRequestUrl();
            if (url.startsWith('attachment://')) {
              return this.webProbeServe404 ? probe404Response() : probePngResponse();
            }
            return undefined;
          })
      }

      if (this.webProbeOn && !this.webProbeNoteReadFlags && this.webProbeSingleFlag === '') {
        Web({ src: this.webProbeRawfile ? $rawfile('reader/probe-scheme.html') : PROBE_HTML, controller: this.webCtl })
          .width('100%')
          .height(60)
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
            const url: string = event.request.getRequestUrl();
            if (url.startsWith('attachment://')) {
              return this.webProbeServe404 ? probe404Response() : probePngResponse();
            }
            return undefined;
          })
      }

      List({ space: 6 }) {
        ForEach(this.entries, (entry: G1ProbeEntry) => {
          ListItem() {
            Column({ space: 2 }) {
              Text(`${entry.ts} [${entry.scene}] ${entry.ok ? 'OK' : 'FAIL'}`)
                .fontSize(12)
                .fontColor(entry.ok ? '#237804' : '#D4380D')
                .width('100%')
              Text(entry.detail)
                .fontSize(11)
                .fontColor('#595959')
                .width('100%')
            }
            .alignItems(HorizontalAlign.Start)
            .width('100%')
            .padding(8)
            .backgroundColor('#F5F5F5')
            .borderRadius(6)
          }
        }, (entry: G1ProbeEntry) => `${entry.ts}-${entry.scene}-${entry.detail.length}`)
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
