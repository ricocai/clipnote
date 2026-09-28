import { router } from '@kit.ArkUI';
import { PasteButtonOnClickResult } from '@kit.ArkUI';
import { G1ProbeEntry, G1ProbeLog } from '../probe/G1ProbeLog';
import { SCENE, probeClipboardRead, probePasteButtonRead, recordDeviceInfo } from '../probe/G1ProbeScenes';

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

  aboutToAppear(): void {
    recordDeviceInfo();
    this.refresh();
  }

  private refresh(): void {
    this.entries = G1ProbeLog.entries().slice().reverse();
    this.logPath = G1ProbeLog.path();
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
