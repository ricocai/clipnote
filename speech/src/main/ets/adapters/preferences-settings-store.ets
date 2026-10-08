import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { TtsSettingsStore, TtsVoiceSettings, sanitizeTtsVoiceSettings } from '../core/settings';

/**
 * 音色/语速的 preferences 持久化（S5-1）。
 *
 * key：`person`（系统发音人）、`speed`（合成语速）。load 时一律经
 * sanitize 收敛——旧版本写入的越界/损坏值回退默认，不向上抛错。
 */
export class PreferencesTtsSettingsStore implements TtsSettingsStore {
  private readonly keyPerson: string = 'person';
  private readonly keySpeed: string = 'speed';

  private readonly context: common.Context;
  private readonly storeName: string;

  constructor(context: common.Context, storeName: string = 'tts_voice_settings') {
    this.context = context;
    this.storeName = storeName;
  }

  async load(): Promise<TtsVoiceSettings> {
    const prefs: preferences.Preferences = await preferences.getPreferences(this.context, this.storeName);
    // -1 = key 不存在；显式转 undefined 走默认，避免 -1 被 clamp/非负校验错误收敛
    const person: preferences.ValueType = await prefs.get(this.keyPerson, -1);
    const speed: preferences.ValueType = await prefs.get(this.keySpeed, -1);
    return sanitizeTtsVoiceSettings({
      person: typeof person === 'number' && person >= 0 ? person : undefined,
      speed: typeof speed === 'number' && speed > 0 ? speed : undefined,
    });
  }

  async save(settings: TtsVoiceSettings): Promise<void> {
    const clean: TtsVoiceSettings = sanitizeTtsVoiceSettings(settings);
    const prefs: preferences.Preferences = await preferences.getPreferences(this.context, this.storeName);
    await prefs.put(this.keyPerson, clean.person);
    await prefs.put(this.keySpeed, clean.speed);
    await prefs.flush();
  }
}
