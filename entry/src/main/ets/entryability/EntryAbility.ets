import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { AppContextHolder } from 'common';

const DOMAIN: number = 0xF1C0;
const TAG: string = 'ClipNote';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    // 领域内核不依赖 AbilityKit：沙箱根路径在这里一次性交给适配层
    AppContextHolder.set(this.context);
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onCreate');
  }

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
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'ability onBackground');
  }
}
