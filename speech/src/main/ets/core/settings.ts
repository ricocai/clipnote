/**
 * 音色/语速设置的领域模型与持久化端口（S5-1）。
 *
 * 设定值来自两类来源：用户设置页（写入持久化）与持久化存储自身的旧数据
 * （可能损坏/越界）。两者都经 `sanitizeTtsVoiceSettings` 收敛到合法域，
 * 坏值回退默认而不是向上抛错——朗读设置损坏不应阻断朗读能力本身。
 *
 * 合法域依据 G4 探测（tools/report/g4-tts-probe.md）：speed 0.5–2、
 * volume 0–2（0 无声）；person 官方口径仅 0（聆小珊）确认，故仅约束非负整数，
 * 多音色枚举属 TTS-2 真机项。
 */

export const SPEED_MIN: number = 0.5;
export const SPEED_MAX: number = 2;

/** 用户可设置的音色/语速（person=系统发音人，speed=合成语速） */
export interface TtsVoiceSettings {
  readonly person: number;
  readonly speed: number;
}

export const DEFAULT_TTS_SETTINGS: TtsVoiceSettings = { person: 0, speed: 1 };

/** 语速收敛到 [SPEED_MIN, SPEED_MAX]；非有限数回退默认 */
export function clampSpeed(speed: number): number {
  if (typeof speed !== 'number' || !isFinite(speed)) {
    return DEFAULT_TTS_SETTINGS.speed;
  }
  if (speed < SPEED_MIN) {
    return SPEED_MIN;
  }
  if (speed > SPEED_MAX) {
    return SPEED_MAX;
  }
  return speed;
}

/** 收敛任意来源的设置数据；person 要求非负整数，speed 走 clampSpeed */
export function sanitizeTtsVoiceSettings(raw: { person?: unknown; speed?: unknown }): TtsVoiceSettings {
  let person: number = DEFAULT_TTS_SETTINGS.person;
  if (typeof raw.person === 'number' && isFinite(raw.person) && raw.person >= 0 && Math.floor(raw.person) === raw.person) {
    person = raw.person;
  }
  const speed: number = clampSpeed(typeof raw.speed === 'number' ? (raw.speed as number) : DEFAULT_TTS_SETTINGS.speed);
  return { person, speed };
}

/** 设置持久化端口；鸿蒙侧用 @kit.ArkData preferences 实现（adapters/），本机用内存实现 */
export interface TtsSettingsStore {
  load(): Promise<TtsVoiceSettings>;
  save(settings: TtsVoiceSettings): Promise<void>;
}

/** 进程内实现：供本机 node 验证与 ohosTest 注入 */
export class InMemoryTtsSettingsStore implements TtsSettingsStore {
  private settings: TtsVoiceSettings = DEFAULT_TTS_SETTINGS;

  async load(): Promise<TtsVoiceSettings> {
    return this.settings;
  }

  async save(settings: TtsVoiceSettings): Promise<void> {
    this.settings = sanitizeTtsVoiceSettings(settings);
  }
}
