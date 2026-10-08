import { abilityAccessCtrl, bundleManager, common, Permissions, Want } from '@kit.AbilityKit';
import { notificationManager } from '@kit.NotificationKit';
import { PasteboardPermissionState, PermissionStatusProbe, PermissionStatusReport } from '../core/ports';
import { AppContextHolder } from './app-context';

const PERM_READ_PASTEBOARD: string = 'ohos.permission.READ_PASTEBOARD';

/**
 * 权限状态读取（S2-4 任务 3：设置页"权限状态区"）。
 *
 * 口径：这里只做**状态展示**，不是安全判定，也不是安全边界（见 ports.ts）。
 * 所有系统调用都可能受限（201 等），失败语义统一落到 UNKNOWN / 查不到，
 * UI 必须按"查不到"如实措辞，不得渲染成"未授权"误导用户。
 *
 * 应用查不到也改不了"设置 → 隐私和安全 → 剪贴板"的策略开关（G1 报告 §1：
 * 默认"使用前每次询问"），该事实由设置页文案承担说明义务。
 */
export class DevicePermissionStatus implements PermissionStatusProbe {
  async fetch(): Promise<PermissionStatusReport> {
    let bundleName: string = '';
    let state: PasteboardPermissionState = PasteboardPermissionState.UNKNOWN;
    try {
      const info: bundleManager.BundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      bundleName = info.name;
      const tokenID: number = info.appInfo.accessTokenId;
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const ps: abilityAccessCtrl.GrantStatus =
        atManager.checkAccessTokenSync(tokenID, PERM_READ_PASTEBOARD as Permissions);
      if (ps === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        state = PasteboardPermissionState.GRANTED;
      } else if (ps === abilityAccessCtrl.GrantStatus.PERMISSION_DENIED) {
        state = PasteboardPermissionState.DENIED;
      }
    } catch (err) {
      // 受限/接口差异 → UNKNOWN。不猜、不装、不吞成"未授权"
    }

    let notificationEnabled: boolean = false;
    let notificationKnown: boolean = false;
    try {
      // V0.1 不发送任何通知；此项仅为状态透明，关闭与否不影响功能（UI 措辞需一致）
      notificationEnabled = await notificationManager.isNotificationEnabled();
      notificationKnown = true;
    } catch (err) {
      notificationKnown = false;
    }

    const report: PermissionStatusReport = {
      pasteboardState: state,
      notificationEnabled: notificationEnabled,
      notificationKnown: notificationKnown,
      bundleName: bundleName,
    };
    return report;
  }

  /**
   * 拉起系统设置的本应用详情页。
   * 'application_info_entry' + pushParams=bundleName 为社区通行写法，未见官方条目直述，
   * 列入真机验证项（G1 §8）；任何失败都返回 false，由 UI 给"手动打开 设置→应用→…"文案。
   */
  async openAppSettings(): Promise<boolean> {
    const ctx: common.UIAbilityContext | undefined = AppContextHolder.get();
    if (ctx === undefined) {
      return false;
    }
    try {
      const bundleName: string = bundleManager
        .getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
        .name;
      const want: Want = {
        bundleName: 'com.huawei.hmos.settings',
        abilityName: 'com.huawei.hmos.settings.MainAbility',
        uri: 'application_info_entry',
        parameters: { pushParams: bundleName },
      };
      await ctx.startAbility(want);
      return true;
    } catch (err) {
      return false;
    }
  }
}
