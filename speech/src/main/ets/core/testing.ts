/**
 * FakeTtsDriver：TtsEngineDriver 的进程内实现（S5-1）。
 *
 * 用途：
 *  - 本机 node 验证（tools/test/speech-engine.test.ts）；
 *  - ohosTest 在模拟器/无 TTS 机型上跑生命周期状态机与取消语义
 *    （官方明确模拟器不支持系统 TTS，G4 探测——真驱动测不了的状态机全靠它）。
 *
 * 默认 speak 后**挂起**（hold），由测试用 simulateStart/simulateComplete/simulateError
 * 显式推进，这样才能确定性验证"stop 后迟到回调被丢弃"这类竞态。
 */

import { CreateEngineParams, DriverUtterance, TtsDriverListener, TtsEngineDriver } from './driver';

export class FakeTtsDriver implements TtsEngineDriver {
  /** 置为非空字符串后 create 即 reject（模拟设备无离线引擎） */
  createError: string | undefined = undefined;
  readonly createdWith: CreateEngineParams[] = [];
  readonly spoken: DriverUtterance[] = [];
  readonly stoppedRequestIds: number[] = [];
  shutdownCount: number = 0;

  private listener: TtsDriverListener | undefined = undefined;
  private readonly inflight = new Set<number>();

  setListener(listener: TtsDriverListener): void {
    this.listener = listener;
  }

  async create(params: CreateEngineParams): Promise<void> {
    if (this.createError !== undefined) {
      throw new Error(this.createError);
    }
    this.createdWith.push(params);
  }

  async speak(utterance: DriverUtterance): Promise<void> {
    this.spoken.push(utterance);
    this.inflight.add(utterance.requestId);
  }

  async stop(requestId: number): Promise<void> {
    this.stoppedRequestIds.push(requestId);
    // 刻意不在此触发 complete：结算由引擎内核负责（驱动侧 onComplete 迟到与否
    // 内核都能正确处理），这样 Fake 才能测"驱动迟报"路径
  }

  async shutdown(): Promise<void> {
    this.shutdownCount++;
    this.inflight.clear();
  }

  // ---- 测试台架：显式推进在播请求 ----

  get inflightCount(): number {
    return this.inflight.size;
  }

  simulateStart(requestId: number): void {
    if (this.inflight.has(requestId)) {
      this.listener?.onStart(requestId);
    }
  }

  simulateComplete(requestId: number): void {
    if (this.inflight.delete(requestId)) {
      this.listener?.onComplete(requestId);
    }
  }

  simulateError(requestId: number, code: number, message: string): void {
    if (this.inflight.delete(requestId)) {
      this.listener?.onError(requestId, code, message);
    }
  }
}
