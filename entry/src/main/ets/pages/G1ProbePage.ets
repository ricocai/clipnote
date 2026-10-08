import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { G1ProbeEntry, G1ProbeLog } from '../probe/G1ProbeLog';
import { SCENE, probeClipboardRead, probePasteButtonRead, recordDeviceInfo } from '../probe/G1ProbeScenes';

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

  /** Q1 探针：用与 NoteRead.attachmentResponse 完全相同的构造回 1x1 PNG，img.onload/onerror 写 title */
  private probeWebResponse(): void {
    this.webProbeOn = true;
    setTimeout(() => {
      this.webCtl.runJavaScript('document.title', (err: Error, result: string) => {
        const ok: boolean = result === '"LOADED"' || result === 'LOADED';
        G1ProbeLog.record('q1-web-response', ok, `img title=${String(result)} err=${String(err)}`);
        this.refresh();
      });
    }, 2000);
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

      Button('场景C（Q1 临时）：WebResourceResponse 图片响应构造')
        .width('100%')
        .onClick(() => {
          this.probeWebResponse();
        })

      if (this.webProbeOn) {
        Web({ src: PROBE_HTML, controller: this.webCtl })
          .width('100%')
          .height(60)
          .onInterceptRequest((event: OnInterceptRequestEvent) => {
            const url: string = event.request.getRequestUrl();
            if (url.startsWith('attachment://')) {
              // 对照实验（临时）：blockedResponse 构造（404 + 空体），img.onerror 应触发
              const res: WebResourceResponse = new WebResourceResponse();
              res.setResponseMimeType('text/plain');
              res.setResponseEncoding('utf-8');
              res.setResponseCode(404);
              res.setReasonMessage('Not Found');
              res.setResponseHeader([]);
              res.setResponseData(new ArrayBuffer(0));
              return res;
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
