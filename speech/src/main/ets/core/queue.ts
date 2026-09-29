/**
 * 有界朗读段队列（S5-2；设计 §4.6「合成队列设高低水位防整篇预生成内存上涨」）。
 *
 * TTS-0 主路径（playType=1 引擎直接播报）下，合成与播放同体，队列里暂存的是
 * 「待发段」而非音频样本；有界性同样成立：预取窗口最多 windowHigh 段，
 * 长文（数百段）不会全量物化。playType=0 PCM 路径接入时，本队列语义不变，
 * 高低水位钩子即背压挂点。
 *
 * 零 @kit.*，本机 node 全量验证。
 */

import { SpeechPlanItem } from './planner';

export class SegmentQueue {
  private readonly items: SpeechPlanItem[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`SegmentQueue capacity 必须为正整数， got ${capacity}`);
    }
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get isFull(): boolean {
    return this.items.length >= this.capacity;
  }

  /**
   * 入队；**队列满时返回 false 而不扩容**——背压语义：调用方必须停止预取，
   * 等消费出队后再补（设计 §4.6 高水位）。
   */
  tryPush(item: SpeechPlanItem): boolean {
    if (this.isFull) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  /** 出队；空队列返回 undefined（消费方据此进入低水位补货判断） */
  shift(): SpeechPlanItem | undefined {
    return this.items.shift();
  }

  /** 队首（不出队）；空队列返回 undefined */
  peek(): SpeechPlanItem | undefined {
    return this.items.length === 0 ? undefined : this.items[0];
  }

  clear(): void {
    this.items.length = 0;
  }
}
