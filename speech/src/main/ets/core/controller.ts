/**
 * 朗读播放控制器（S5-2；设计 §4.6 管线后半段「有界队列 → 播放 → 按实际播放进度高亮」
 * 的调度内核，TTS-0 主路径）。
 *
 * 职责：计划装载 → 窗口化预取（有界队列）→ 逐段喂引擎 → 进度/状态回传 UI。
 * 零 @kit.*，本机 node 全量验证；AudioRenderer/AVSession 在 adapters/ 与 entry 接线。
 *
 * 关键决策：
 *  1. **段边界暂停**：pause = engine.stop（在播段作废，恢复时从该段头重读）。
 *     不沿用引擎内部的 pause/resume 状态对——冻结契约没有「取消已暂停段」操作，
 *     暂停后 seek/换文会让引擎内部 paused 段与控制器游标脱节（恢复会重读旧段）。
 *     段边界暂停在 TTS-0（整段粒度恢复，G4 方案 A）下行为一致且无此陷阱。
 *  2. **代际纪律**：每次换文/快进/恢复都自增 generation（设计 §4.6「废弃旧
 *     generation ID 的样本」）；引擎内核（S5-1）凭代际丢弃迟到回调，
 *     控制器凭 epoch 作废整轮 pump 循环——双保险防「旧文继续播」。
 *  3. **背压**：预取窗口 windowHigh（默认 2）段；refill 以 cursor 为基准清空重建，
 *     不变式「队列内段下标 ≥ cursor 且 size ≤ windowHigh」恒成立。
 *  4. **错误即停**：段合成/播报错误 → failed 态并上抛原因；failed 后允许
 *     从当前段重试（play），不自动循环重试。
 */

import { ITtsEngine, TtsCallbacks } from './contract';
import { SpeechPlan, SpeechPlanItem } from './planner';
import { SegmentQueue } from './queue';

export type PlaybackState =
  /** 未装载计划 */
  | 'idle'
  /** 已装载，未开始/已停止（游标在计划内） */
  | 'ready'
  | 'playing'
  | 'paused'
  /** 播完整个计划 */
  | 'completed'
  /** 段级错误中止 */
  | 'failed';

export interface PlaybackCallbacks {
  /** 状态机迁移（UI 绑定） */
  onStateChange(state: PlaybackState): void;
  /** 一段实际开播（高亮锚点：item.blockIndex） */
  onSegmentStart(item: SpeechPlanItem): void;
  /** 按实际播放进度回报（TTS-0 段播完一次性回报整段字符数，段内进度属 playType=0 真机项） */
  onProgress(item: SpeechPlanItem, playedChars: number): void;
  /** 一段正常播完 */
  onSegmentFinish(item: SpeechPlanItem): void;
  /** 整个计划播完 */
  onPlanComplete(): void;
  onError(reason: string): void;
}

export interface SpeechPlaybackOptions {
  /** 合成语速；默认 1（引擎设置里的语速由引擎自己装载，这里仅作请求缺省） */
  speed?: number;
  /** 预取窗口（高水位）：队列最多暂存的待发段数；默认 2 */
  windowHigh?: number;
}

export class SpeechPlaybackController {
  private planValue: SpeechPlan | undefined = undefined;
  private stateValue: PlaybackState = 'idle';
  private readonly queue: SegmentQueue;
  private readonly speed: number;
  /** 计划游标：下一段的全局下标（plan.items 有序，下标即 segment.index） */
  private cursor: number = 0;
  /** 引擎代际：严格自增，换文/快进/恢复各 +1 */
  private generation: number = 0;
  /** 控制器代际：作废整轮 pump（stop/seek/load/pause 时 +1） */
  private epoch: number = 0;
  /** 在播段及其代际；无在播段为 undefined */
  private activeItemValue: SpeechPlanItem | undefined = undefined;
  private activeGeneration: number | undefined = undefined;
  /** play() 返回的泵循环 Promise（去重与测试可等待） */
  private loop: Promise<void> | undefined = undefined;
  private lastErrorValue: string | undefined = undefined;
  private interruptReasonValue: string | undefined = undefined;

  constructor(
    private readonly engine: ITtsEngine,
    private readonly callbacks: PlaybackCallbacks,
    options?: SpeechPlaybackOptions,
  ) {
    const windowHigh: number = options?.windowHigh === undefined ? 2 : options.windowHigh;
    if (!Number.isInteger(windowHigh) || windowHigh <= 0) {
      throw new Error(`windowHigh 必须为正整数， got ${windowHigh}`);
    }
    this.speed = options?.speed === undefined ? 1 : options.speed;
    this.queue = new SegmentQueue(windowHigh);
  }

  // ---- 只读暴露 ----

  get state(): PlaybackState {
    return this.stateValue;
  }

  get plan(): SpeechPlan | undefined {
    return this.planValue;
  }

  /** 当前段的全局下标；无在播段时为游标位置 */
  get currentIndex(): number {
    if (this.activeItemValue !== undefined) {
      return this.activeItemValue.segment.index;
    }
    return this.cursor;
  }

  get currentItem(): SpeechPlanItem | undefined {
    return this.activeItemValue;
  }

  get lastError(): string | undefined {
    return this.lastErrorValue;
  }

  /** 最近一次中断原因（来电/焦点抢占等）；用户主动 play 后清除 */
  get lastInterruptReason(): string | undefined {
    return this.interruptReasonValue;
  }

  /** 预取窗口大小（队列容量，背压用例断言） */
  get windowSize(): number {
    return this.queue.capacity;
  }

  // ---- 控制面 ----

  /** 装载/换文：作废在 pump 与在播段，游标归零，按新计划重建窗口 */
  async load(plan: SpeechPlan): Promise<void> {
    await this.haltActive();
    this.planValue = plan;
    this.cursor = 0;
    this.lastErrorValue = undefined;
    this.interruptReasonValue = undefined;
    this.refill();
    this.setState(plan.items.length === 0 ? 'idle' : 'ready');
  }

  /**
   * 播放/恢复。返回的 Promise 在播完/停止/出错时结算——UI 可 fire-and-forget，
   * 测试可 await 全链路。failed 态允许重试（从 cursor 所在段继续）。
   */
  play(): Promise<void> {
    if (this.stateValue === 'playing') {
      return this.loop ?? Promise.resolve();
    }
    const plan: SpeechPlan = this.requirePlan();
    if (plan.items.length === 0) {
      return Promise.resolve();
    }
    if (this.stateValue === 'completed') {
      this.cursor = 0;
      this.refill();
    }
    this.interruptReasonValue = undefined;
    this.setState('playing');
    const loop: Promise<void> = this.pump();
    this.loop = loop;
    this.clearLoopWhenSettled(loop);
    return loop;
  }

  /** 段边界暂停：作废在播段，恢复时从该段头重读（决策 1） */
  async pause(): Promise<void> {
    if (this.stateValue !== 'playing') {
      return;
    }
    this.setState('paused');
    this.epoch++;
    const gen: number | undefined = this.activeGeneration;
    this.activeGeneration = undefined;
    if (this.activeItemValue !== undefined) {
      // 回到在播段头：恢复时重读该段
      this.cursor = this.activeItemValue.segment.index;
      this.activeItemValue = undefined;
    }
    this.refill();
    if (gen !== undefined) {
      await this.engine.stop(gen); // 在播 speak resolve 后，旧 pump 凭 epoch 退出
    }
  }

  /** 停止：作废一切，回到计划头（计划保留，可直接再播） */
  async stop(): Promise<void> {
    if (this.stateValue === 'idle' && this.planValue === undefined) {
      return;
    }
    await this.haltActive();
    this.cursor = 0;
    this.refill();
    if (this.planValue !== undefined && this.planValue.items.length > 0) {
      this.setState('ready');
    } else {
      this.setState('idle');
    }
  }

  /**
   * 跳到指定段。播放中：作废在播段并从目标段起播（generation 自增）；
   * 暂停/就绪：只移动游标，play 后生效。
   */
  async seekToSegment(index: number): Promise<void> {
    const plan: SpeechPlan = this.requirePlan();
    if (plan.items.length === 0) {
      return;
    }
    const target: number = Math.max(0, Math.min(plan.items.length - 1, Math.floor(index)));
    const wasPlaying: boolean = this.stateValue === 'playing';
    this.epoch++;
    const gen: number | undefined = this.activeGeneration;
    this.activeGeneration = undefined;
    this.activeItemValue = undefined;
    if (gen !== undefined) {
      await this.engine.stop(gen);
    }
    this.cursor = target;
    this.refill();
    if (wasPlaying) {
      this.setState('playing');
      const loop: Promise<void> = this.pump();
      this.loop = loop;
      this.clearLoopWhenSettled(loop);
      await loop;
    }
  }

  next(): Promise<void> {
    return this.seekToSegment(this.currentIndex + 1);
  }

  prev(): Promise<void> {
    return this.seekToSegment(this.currentIndex - 1);
  }

  /** 外部中断（来电/焦点抢占，由 AVSession 适配层映射）：段边界暂停并记录原因 */
  async interrupt(reason: string): Promise<void> {
    if (this.stateValue !== 'playing') {
      return;
    }
    this.interruptReasonValue = reason;
    await this.pause();
  }

  async release(): Promise<void> {
    await this.haltActive();
    this.planValue = undefined;
    this.queue.clear();
    this.setState('idle');
    await this.engine.release();
  }

  // ---- 内部 ----

  /** 作废在 pump 与在播段（stop + epoch++）；状态与游标由调用方处置 */
  private async haltActive(): Promise<void> {
    this.epoch++;
    const gen: number | undefined = this.activeGeneration;
    this.activeGeneration = undefined;
    this.activeItemValue = undefined;
    if (gen !== undefined) {
      await this.engine.stop(gen);
    }
  }

  private requirePlan(): SpeechPlan {
    if (this.planValue === undefined) {
      throw new Error('尚未装载朗读计划（先 load(planSpeech(...))）');
    }
    return this.planValue;
  }

  private setState(state: PlaybackState): void {
    if (this.stateValue === state) {
      return;
    }
    this.stateValue = state;
    this.callbacks.onStateChange(state);
  }

  /**
   * 预取窗口重建：不变式「队列内段下标 ≥ cursor 且 size ≤ windowHigh」。
   * 以 cursor 为基准清空重建，暂停回退/seek 后不会出现陈旧段。
   */
  private refill(): void {
    this.queue.clear();
    const plan: SpeechPlan | undefined = this.planValue;
    if (plan === undefined) {
      return;
    }
    for (let i: number = this.cursor; i < plan.items.length; i++) {
      if (!this.queue.tryPush(plan.items[i])) {
        break; // 高水位：停止预取（背压）
      }
    }
  }

  private async pump(): Promise<void> {
    const myEpoch: number = this.epoch;
    const plan: SpeechPlan = this.requirePlan();
    try {
      while (this.stateValue === 'playing' && myEpoch === this.epoch && !this.queue.isEmpty) {
        const item: SpeechPlanItem = this.queue.shift() as SpeechPlanItem;
        this.cursor = item.segment.index + 1;
        this.refill(); // 消费一段补一段，窗口有界
        this.activeItemValue = item;
        const gen: number = ++this.generation;
        this.activeGeneration = gen;
        this.callbacks.onSegmentStart(item);
        const cbs: TtsCallbacks = {
          onReady: (): void => undefined,
          onProgress: (g: number, playedChars: number): void => {
            if (g === this.generation && myEpoch === this.epoch) {
              this.callbacks.onProgress(item, playedChars);
            }
          },
          onError: (): void => undefined, // 错误经 speak 的 reject 传播，单点结算
        };
        try {
          // speak 在该段播完时 resolve；被 stop/换代际取消时也 resolve（引擎语义）
          await this.engine.speak(
            { segment: item.segment, generation: gen, speed: this.speed },
            cbs,
          );
        } catch (err) {
          if (myEpoch !== this.epoch) {
            return; // 已换轮，错误是旧轮残留，丢弃
          }
          this.activeGeneration = undefined;
          this.activeItemValue = undefined;
          this.cursor = item.segment.index; // 失败段不重试则停在原处
          this.refill();
          this.fail(err instanceof Error ? err.message : String(err));
          return;
        }
        this.activeGeneration = undefined;
        if (myEpoch !== this.epoch || this.stateValue !== 'playing') {
          return; // 暂停/停止/换文已介入
        }
        this.activeItemValue = undefined;
        this.callbacks.onSegmentFinish(item);
      }
      if (myEpoch !== this.epoch || this.stateValue !== 'playing') {
        return;
      }
      if (this.queue.isEmpty && this.cursor >= plan.items.length) {
        this.activeItemValue = undefined;
        this.setState('completed');
        this.callbacks.onPlanComplete();
      }
    } finally {
      // this.loop 的清理由 clearLoopWhenSettled 负责（play/seek 入口处登记）
    }
  }

  /** loop 结算后清 this.loop（resolve/reject 两路都清，避免派生 Promise 的 unhandled rejection） */
  private clearLoopWhenSettled(loop: Promise<void>): void {
    const clear = (): void => {
      if (this.loop === loop) {
        this.loop = undefined;
      }
    };
    loop.then(clear, clear);
  }

  private fail(reason: string): void {
    this.lastErrorValue = reason;
    this.setState('failed');
    this.callbacks.onError(reason);
  }
}
