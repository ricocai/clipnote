import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import {
  AppContextHolder,
  AppDataRuntime,
  CryptoHasher,
  CryptoRandom,
  HilogLogger,
  SystemClock,
} from 'common';
import { AppServices } from '../services/AppServices';
import { G1ProbeLog } from '../probe/G1ProbeLog';
import { probeForegroundRead, probeShareUriCopy, probeShareWant, recordDeviceInfo } from '../probe/G1ProbeScenes';
import { EVENT_FOREGROUND } from '../EntryEvents';
import { handleSharedWant } from '../share/share-intake';

const DOMAIN: number = 0xF1C0;
const TAG: string = 'ClipNote';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    // 领域内核不依赖 AbilityKit：沙箱根路径在这里一次性交给适配层
    AppContextHolder.set(this.context);
    // 数据层接线（设计 §4.2）：打开库 → 迁移 → 启动恢复扫描。
    // 异步执行不阻塞首帧；数据就绪前 UI 不得进入依赖仓储的流程（见 AppDataRuntime 注释）。
    AppDataRuntime.init(
      this.context,
      new SystemClock(),
      new CryptoRandom(),
      new CryptoHasher(),
      new HilogLogger(),
    )
      .then(() => {
        hilog.info(DOMAIN, TAG, '%{public}s', 'data runtime ready');
      })
      .catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'data runtime init failed: %{public}s', String(err));
      });
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onCreate');
    // S2-3 分享接收：非分享 want 在 handleSharedWant 内直接返回；全程不抛、不阻塞启动
    handleSharedWant(want, 'onCreate');
    // ===== G1 PROBE BEGIN（WHY-90 临时设施，G1 验收后整体移除）=====
    // 只记录不拦截：任何探针异常都不允许影响正常启动路径。
    try {
      G1ProbeLog.init(this.context.filesDir);
      recordDeviceInfo();
      probeShareWant(want, 'onCreate');
      probeShareUriCopy(want);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'g1 probe onCreate failed: %{public}s', String(err));
    }
    // ===== G1 PROBE END =====
  }

  // ===== G1 PROBE BEGIN（WHY-90：分享已启动实例时走 onNewWant，探测后随探针块移除）=====
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    super.onNewWant(want, launchParam);
    // S2-3 分享接收（已运行实例的分享到达路径）
    handleSharedWant(want, 'onNewWant');
    try {
      probeShareWant(want, 'onNewWant');
      probeShareUriCopy(want);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'g1 probe onNewWant failed: %{public}s', String(err));
    }
  }
  // ===== G1 PROBE END =====

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '%{public}s', 'loadContent succeeded');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'windowStage destroyed');
  }

  onForeground(): void {
    // 设计 §4.1：回到前台只是"检查当前可读内容并提示保存"，**不是历史补采**，
    // 也不得在用户拒绝授权后反复打扰。因此这里不做任何自动读取动作。
    // S2-4：本层唯一动作是向页面广播"检查机会"事件；页面（Index）检测到内容也只弹
    // 提示条，读取必须等用户点击提示条（用户手势）才发生 —— 本层零读取、零落盘。
    this.context.eventHub.emit(EVENT_FOREGROUND);
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onForeground');
    // S6-7：MCP 仅前台监听 —— 回前台按开关启动服务并挂 30s 周期清扫；
    // 启动失败（如端口占用）显式记日志交设置页状态展示，不阻断回前台。
    AppServices.get().mcpService().enterForeground().catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'mcp enterForeground failed: %{public}s', String(err));
    });
    // ===== G1 PROBE BEGIN（WHY-90 临时设施）=====
    // 注意：这是一次"故意违反上面产品口径"的探测 —— 验证无手势时机下系统是否放行读取、
    // 默认授权策略下是否弹窗。探针块随 G1 验收移除后，恢复上方注释所述行为。
    probeForegroundRead().catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'g1 probe foreground read failed: %{public}s', String(err));
    });
    // ===== G1 PROBE END =====
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onBackground');
    // S6-7：退后台停 30s 清扫并关闭 MCP 服务（会话/配对/授权即刻清零）
    AppServices.get().mcpService().enterBackground().catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'mcp enterBackground failed: %{public}s', String(err));
    });
  }
}
