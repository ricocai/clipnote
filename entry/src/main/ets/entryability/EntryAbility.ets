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
import { G1ProbeLog } from '../probe/G1ProbeLog';
import { probeForegroundRead, probeShareUriCopy, probeShareWant, recordDeviceInfo } from '../probe/G1ProbeScenes';

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
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onForeground');
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
  }
}
