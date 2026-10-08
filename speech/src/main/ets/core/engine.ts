/**
 * 系统离线 TTS 引擎内核（S5-1，实现冻结接口 ITtsEngine）。
 *
 * 关键决策（均有 G4 探测依据，tools/report/g4-tts-probe.md）：
 *  1. **离线-only**：online 固定 1；capability 探测失败即显式 `available=false`+reason，
 *     init 拒绝——绝不静默转在线（设计 §4.6）。
 *  2. **无原生 pause/resume**（API 12~22 旧引擎）：按探测方案 A 实现——
 *     pause = stop + 记住当前段；resume = 以新代际重读该段（沿用原回调链）。
 *     恢复粒度为整段：段内偏移恢复依赖 playType=0 PCM 进度（G4 真机项 §5-5/§5-8）。
 *  3. **代际取消**：generation 必须严格自增；旧 requestId 的迟到回调一律丢弃，
 *     防止"上一段音频继续播放"（设计 §4.6）。
 *  4. **requestId 一次性**：内核单调签发、不复用（探测常见坑②）。
 *  5. **分段合成是调用方职责**（common/splitForSpeech，≤300 字，远低于系统 10000
 *     字符上限）：引擎内核不重复做整篇保护，保持职责单一。
 *
 * speak() 返回的 Promise 在**该段播完**时 resolve（onComplete）、出错时 reject、
 * 被 stop/pause/新代际取代时 resolve（视为正常取消，非错误）——
 * 调用方按段串行 await 即得到自然的逐段推进。
 */

import { SpeechSegment } from 'common/src/main/ets/core/speech';
import { ITtsEngine, TtsCallbacks, TtsEngineCapability, TtsSpeakRequest } from './contract';
import { CreateEngineParams, TtsEngineDriver, TtsDriverListener } from './driver';
import {
  DEFAULT_TTS_SETTINGS,
  TtsSettingsStore,
  TtsVoiceSettings,
  TtsVoiceSettingsPatch,
  sanitizeTtsVoiceSettings,
} from './settings';

/** 引擎对外可见生命周期状态（ohosTest 状态机用例直接断言本枚举） */
export type TtsEngineState =
  | 'uninitialized'
  | 'unavailable'
  | 'idle'
  | 'speaking'
  | 'paused'
  | 'released';

export const ENGINE_NAME: string = 'system-text-to-speech';
export const ENGINE_LANGUAGE: string = 'zh-CN';
/** 探测：volume 0–2（0 无声）、pitch 0.5–2；引擎直接播报取默认 1 */
const DEFAULT_VOLUME: number = 1;
const DEFAULT_PITCH: number = 1;

interface ActiveUtterance {
  readonly requestId: number;
  readonly generation: number;
  readonly segment: SpeechSegment;
  readonly speed: number;
  readonly callbacks: TtsCallbacks;
}

interface PendingCompletion {
  readonly generation: number;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/** 段边界暂停时暂存的在读段上下文（恢复时从段头重读） */
interface PausedSegment {
  readonly segment: SpeechSegment;
  readonly speed: number;
  readonly callbacks: TtsCallbacks;
}

export class SystemTtsEngine implements ITtsEngine {
  private stateValue: TtsEngineState = 'uninitialized';
  private cap: TtsEngineCapability | undefined = undefined;
  private settings: TtsVoiceSettings = DEFAULT_TTS_SETTINGS;
  private settingsLoaded: boolean = false;
  private engineCreated: boolean = false;
  private nextRequestId: number = 1;
  private lastGeneration: number = 0;
  private active: ActiveUtterance | undefined = undefined;
  private readonly pending = new Map<number, PendingCompletion>();
  private paused: PausedSegment | undefined = undefined;
  private readonly driver: TtsEngineDriver;
  private readonly settingsStore: TtsSettingsStore;

  constructor(
    driver: TtsEngineDriver,
    settingsStore: TtsSettingsStore = {
      load: (): Promise<TtsVoiceSettings> => Promise.resolve(DEFAULT_TTS_SETTINGS),
      save: (): Promise<void> => Promise.resolve(),
    },
  ) {
    this.driver = driver;
    this.settingsStore = settingsStore;
    const listener: TtsDriverListener = {
      onStart: (requestId: number): void => this.handleStart(requestId),
      onComplete: (requestId: number): void => this.handleComplete(requestId),
      onError: (requestId: number, code: number, message: string): void =>
        this.handleError(requestId, code, message),
    };
    this.driver.setListener(listener);
  }

  /** 当前生命周期状态（只读暴露，供 UI 状态绑定与测试断言） */
  get state(): TtsEngineState {
    return this.stateValue;
  }

  /** 用户设置入口：收敛→持久化→应用到下一次引擎创建（idle 时即时废弃旧引擎） */
  async updateSettings(patch: TtsVoiceSettingsPatch): Promise<TtsVoiceSettings> {
    this.settings = sanitizeTtsVoiceSettings({
      person: patch.person !== undefined ? patch.person : this.settings.person,
      speed: patch.speed !== undefined ? patch.speed : this.settings.speed,
    });
    await this.settingsStore.save(this.settings);
    // 音色（person）只在引擎创建时生效；idle 时主动废弃旧引擎，下次 speak 用新音色重建
    if (this.engineCreated && this.stateValue === 'idle') {
      this.engineCreated = false;
    }
    return this.settings;
  }

  async capability(): Promise<TtsEngineCapability> {
    if (this.cap !== undefined) {
      return this.cap;
    }
    try {
      await this.ensureEngine();
      this.cap = {
        available: true,
        engineName: ENGINE_NAME,
        offline: true,
        voiceCount: 1,
      };
    } catch (err) {
      this.stateValue = 'unavailable';
      this.cap = {
        available: false,
        engineName: ENGINE_NAME,
        offline: true,
        voiceCount: 0,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    return this.cap;
  }

  async init(): Promise<void> {
    this.assertNotReleased();
    if (this.stateValue === 'unavailable') {
      throw new Error(`系统 TTS 不可用：${this.cap?.reason ?? '未知原因'}`);
    }
    await this.ensureEngine(); // 幂等：capability()/前次 init 已创建则直接返回
    if (this.stateValue === 'uninitialized') {
      this.stateValue = 'idle';
    }
  }

  async speak(request: TtsSpeakRequest, callbacks: TtsCallbacks): Promise<void> {
    this.assertNotReleased();
    if (this.stateValue === 'unavailable') {
      throw new Error(`系统 TTS 不可用：${this.cap?.reason ?? '未知原因'}`);
    }
    if (request.generation <= this.lastGeneration) {
      throw new Error(
        `generation ${request.generation} 未自增（last=${this.lastGeneration}）——代际取消语义要求严格递增（设计 §4.6）`,
      );
    }
    // 登记必须**先于一切 await**：调用方 fire-and-forget 播放（S5-2 控制器）时，
    // stop/pause/换代际可能在 speak 首个 await 前的微任务窗口到达——晚登记会让
    // stop 扑空（active 尚 undefined）、驱动样本成孤儿（实测暴露，S5-2 修复）。
    if (this.active !== undefined) {
      // 新代际说话：废弃在播样本（取消是正常路径，resolve 而非 reject）
      this.cancelActive();
    }
    this.paused = undefined; // 新代际取代暂停态
    this.lastGeneration = request.generation;

    const requestId: number = this.nextRequestId++;
    this.active = {
      requestId,
      generation: request.generation,
      segment: request.segment,
      speed: request.speed,
      callbacks,
    };
    this.stateValue = 'speaking';
    await new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
      this.pending.set(requestId, { generation: request.generation, resolve, reject });
      this.ensureEngine()
        .then((): void => {
          const completion: PendingCompletion | undefined = this.pending.get(requestId);
          if (completion === undefined) {
            return; // ensureEngine 期间已被 stop/pause/换代际结算（正常取消）
          }
          if (this.active === undefined || this.active.requestId !== requestId) {
            // 防御：pending 未结算但样本已不在 active（不应出现，兜底按取消结算）
            this.pending.delete(requestId);
            completion.resolve();
            return;
          }
          // 播报参数以「当前用户设置」为准（Q2a）：settings 是倍速的唯一权威来源，
          // 每段 speak 时读取——换倍速恰好按段落边界生效（S5-1 语义），无需重建引擎。
          // request.speed 是控制器缺省值（恒 1），不参与实际播报。
          this.driver.speak({
            requestId,
            text: request.segment.text,
            speed: this.settings.speed,
            volume: 1,
            pitch: 1,
          }).catch((err: Error) => {
            // 引擎连请求都未接受：本地结算，等 listener 只会更糟
            if (this.pending.delete(requestId)) {
              this.active = undefined;
              this.stateValue = 'idle';
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        })
        .catch((err: unknown): void => {
          if (this.pending.delete(requestId)) {
            this.active = undefined;
            this.stateValue = 'idle';
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
    });
  }

  async stop(generation: number): Promise<void> {
    this.assertNotReleased();
    // 幂等：过期/未命中代际的 stop 是安全空操作（来电中断等场景会盲目调用）
    if (this.active === undefined || this.active.generation !== generation) {
      return;
    }
    this.cancelActive();
    this.stateValue = 'idle';
  }

  async pause(generation: number): Promise<void> {
    this.assertNotReleased();
    if (this.active === undefined || this.active.generation !== generation) {
      throw new Error(`pause(${generation}) 未命中在播代际——当前没有可暂停的朗读`);
    }
    const current: ActiveUtterance = this.active;
    this.paused = { segment: current.segment, speed: current.speed, callbacks: current.callbacks };
    this.cancelActive(); // stop + 代际废弃；恢复走 resume 新代际
    this.stateValue = 'paused';
  }

  async resume(generation: number): Promise<void> {
    this.assertNotReleased();
    if (this.paused === undefined) {
      throw new Error('resume 前必须先 pause——当前没有暂停的段');
    }
    if (generation <= this.lastGeneration) {
      throw new Error(
        `resume 代际 ${generation} 未自增（last=${this.lastGeneration}）——续读必须开启新代际`,
      );
    }
    const paused = this.paused;
    this.paused = undefined;
    // 沿用 pause 前注册的回调链：UI 的进度/错误处理不感知"内部重读"
    await this.speak({ segment: paused.segment, generation, speed: paused.speed }, paused.callbacks);
  }

  async release(): Promise<void> {
    if (this.stateValue === 'released') {
      return;
    }
    if (this.active !== undefined) {
      this.cancelActive();
    }
    this.paused = undefined;
    if (this.engineCreated) {
      await this.driver.shutdown();
      this.engineCreated = false;
    }
    this.stateValue = 'released';
  }

  // ---- 内部 ----

  private assertNotReleased(): void {
    if (this.stateValue === 'released') {
      throw new Error('引擎已 release，禁止一切操作');
    }
  }

  private async ensureEngine(): Promise<void> {
    if (this.engineCreated) {
      return;
    }
    await this.loadSettingsOnce();
    const params: CreateEngineParams = {
      language: ENGINE_LANGUAGE,
      person: this.settings.person,
      speed: this.settings.speed,
      volume: DEFAULT_VOLUME,
      pitch: DEFAULT_PITCH,
    };
    await this.driver.create(params);
    this.engineCreated = true;
  }

  private async loadSettingsOnce(): Promise<void> {
    if (this.settingsLoaded) {
      return;
    }
    try {
      this.settings = sanitizeTtsVoiceSettings(await this.settingsStore.load());
    } catch {
      // 持久化损坏不阻断朗读：回退默认设置
      this.settings = DEFAULT_TTS_SETTINGS;
    }
    this.settingsLoaded = true;
  }

  /** 废弃在播样本：停驱动、结算 pending（resolve=正常取消）、清 active */
  private cancelActive(): void {
    const current: ActiveUtterance | undefined = this.active;
    if (current === undefined) {
      return;
    }
    this.active = undefined;
    this.driver.stop(current.requestId).catch((): void => undefined);
    const completion: PendingCompletion | undefined = this.pending.get(current.requestId);
    if (completion !== undefined) {
      this.pending.delete(current.requestId);
      completion.resolve();
    }
  }

  private handleStart(requestId: number): void {
    const current: ActiveUtterance | undefined = this.active;
    if (current === undefined || current.requestId !== requestId) {
      return; // 过期样本（代际已废弃），丢弃
    }
    current.callbacks.onReady(current.generation);
  }

  private handleComplete(requestId: number): void {
    const completion: PendingCompletion | undefined = this.pending.get(requestId);
    if (completion === undefined) {
      return; // 已被 stop/pause/新代际结算，迟到回调丢弃
    }
    this.pending.delete(requestId);
    const current: ActiveUtterance | undefined = this.active;
    if (current !== undefined && current.requestId === requestId) {
      this.active = undefined;
      this.stateValue = 'idle';
      // TTS-0 引擎直接播报（playType=1）拿不到样本级进度：段播完按整段字符数上报，
      // 段落级高亮够用；段内进度依赖 playType=0 PCM 路径（G4 真机项 §5-5）
      current.callbacks.onProgress(current.generation, current.segment.charCount);
    }
    completion.resolve();
  }

  private handleError(requestId: number, code: number, message: string): void {
    const completion: PendingCompletion | undefined = this.pending.get(requestId);
    if (completion === undefined) {
      return; // 已取消样本的错误迟到上报，丢弃
    }
    this.pending.delete(requestId);
    const current: ActiveUtterance | undefined = this.active;
    if (current !== undefined && current.requestId === requestId) {
      this.active = undefined;
      this.stateValue = 'idle';
      current.callbacks.onError(current.generation, `${code}: ${message}`);
    }
    completion.reject(new Error(`${code}: ${message}`));
  }
}
