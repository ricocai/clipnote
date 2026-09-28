import TestRunner from '@ohos.application.testRunner';
import AbilityDelegatorRegistry from '@ohos.app.ability.abilityDelegatorRegistry';
import { Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xF1C0;
const TAG: string = 'OpenHarmonyTestRunner';

export default class OpenHarmonyTestRunner implements TestRunner {
  constructor() {}

  onPrepare(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'OpenHarmonyTestRunner onPrepare');
  }

  async onRun(): Promise<void> {
    hilog.info(DOMAIN, TAG, '%{public}s', 'OpenHarmonyTestRunner onRun');
    const delegator: AbilityDelegatorRegistry.AbilityDelegator =
      AbilityDelegatorRegistry.getAbilityDelegator();
    const testAbilityName: string = AbilityDelegatorRegistry.getArguments().parameters['-e class'];
    const monitor: AbilityDelegatorRegistry.AbilityMonitor = {
      abilityName: testAbilityName,
      onAbilityCreate: (data: AbilityDelegatorRegistry.AbilityMonitor): void => {
        hilog.info(DOMAIN, TAG, 'onAbilityCreateCallback, name: %{public}s', data.abilityName);
      },
    };
    AbilityDelegatorRegistry.addAbilityMonitor(monitor);
    const want: Want = {
      bundleName: AbilityDelegatorRegistry.getArguments().bundleName,
      abilityName: testAbilityName,
    };
    await delegator.startAbility(want);
    hilog.info(DOMAIN, TAG, '%{public}s', 'OpenHarmonyTestRunner onRun end');
  }
}
