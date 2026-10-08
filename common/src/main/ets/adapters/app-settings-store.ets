import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';

/**
 * 应用功能开关的 preferences 持久化（第二批功能 Feature 6/9）。
 *
 * 分层纪律：只做读写与类型收敛，不含业务规则（开关的语义由消费方实现）。
 * key 与 TtsVoiceSettingsStore 同一 preferences 使用纪律：损坏值回退默认，不向上抛错。
 */

/** 功能开关集合（第二批功能口径） */
export interface AppFeatureSettings {
  /** Feature 6 主开关：回前台自动读取剪贴板并直接写入收件箱（默认开，用户已确认） */
  clipboardAutoInbox: boolean;
  /** Feature 6 第二开关：允许收件箱批量「存为笔记」落入默认笔记本（默认允许） */
  inboxBatchSaveToDefault: boolean;
  /** Feature 9 顺序连读：当前笔记读完自动接下一篇（默认关） */
  sequentialPlayback: boolean;
}

/** 开关 patch（全可选；未提供的不动） */
export interface AppFeatureSettingsPatch {
  clipboardAutoInbox?: boolean;
  inboxBatchSaveToDefault?: boolean;
  sequentialPlayback?: boolean;
}

/** 默认值：clipboardAutoInbox / inboxBatchSaveToDefault 用户已确认默认开，连读默认关 */
export const DEFAULT_APP_FEATURE_SETTINGS: AppFeatureSettings = {
  clipboardAutoInbox: true,
  inboxBatchSaveToDefault: true,
  sequentialPlayback: false,
};

export class AppSettingsStore {
  private readonly context: common.Context;
  private readonly storeName: string;
  private cache: AppFeatureSettings | undefined = undefined;

  constructor(context: common.Context, storeName: string = 'app_feature_settings') {
    this.context = context;
    this.storeName = storeName;
  }

  /** 读取（类型收敛；损坏/缺失回退默认）；首次后走内存缓存 */
  async load(): Promise<AppFeatureSettings> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    try {
      const prefs: preferences.Preferences =
        await preferences.getPreferences(this.context, this.storeName);
      const a: preferences.ValueType = await prefs.get('clipboard_auto_inbox', -1);
      const b: preferences.ValueType = await prefs.get('inbox_batch_save_default', -1);
      const c: preferences.ValueType = await prefs.get('sequential_playback', -1);
      const loaded: AppFeatureSettings = {
        clipboardAutoInbox: typeof a === 'boolean' ? a : DEFAULT_APP_FEATURE_SETTINGS.clipboardAutoInbox,
        inboxBatchSaveToDefault: typeof b === 'boolean' ? b : DEFAULT_APP_FEATURE_SETTINGS.inboxBatchSaveToDefault,
        sequentialPlayback: typeof c === 'boolean' ? c : DEFAULT_APP_FEATURE_SETTINGS.sequentialPlayback,
      };
      this.cache = loaded;
      return loaded;
    } catch {
      this.cache = DEFAULT_APP_FEATURE_SETTINGS;
      return DEFAULT_APP_FEATURE_SETTINGS;
    }
  }

  /** 局部更新（落盘 + 刷缓存），返回更新后的全量值 */
  async patch(changes: AppFeatureSettingsPatch): Promise<AppFeatureSettings> {
    const current: AppFeatureSettings = await this.load();
    const merged: AppFeatureSettings = {
      clipboardAutoInbox: changes.clipboardAutoInbox ?? current.clipboardAutoInbox,
      inboxBatchSaveToDefault: changes.inboxBatchSaveToDefault ?? current.inboxBatchSaveToDefault,
      sequentialPlayback: changes.sequentialPlayback ?? current.sequentialPlayback,
    };
    const prefs: preferences.Preferences =
      await preferences.getPreferences(this.context, this.storeName);
    await prefs.put('clipboard_auto_inbox', merged.clipboardAutoInbox);
    await prefs.put('inbox_batch_save_default', merged.inboxBatchSaveToDefault);
    await prefs.put('sequential_playback', merged.sequentialPlayback);
    await prefs.flush();
    this.cache = merged;
    return merged;
  }
}
