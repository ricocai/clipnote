/**
 * speech（HAR）：离线朗读。
 *
 * **本期（V0.1）刻意不实现合成**，原因是设计 §4.6 的渐进路线把 TTS-0（系统离线引擎 PoC）
 * 置于 G4 门槛之后：断网可用性、音色清单、长文表现、中断语义、后台资格都必须先有真机证据，
 * 否则实现出来的只是"能跑但不知道能不能用"的代码。
 *
 * 本文件只冻结**接口边界**，让 UI 与领域层可以先按此依赖，G4 通过后填充实现而不改动调用方。
 */

import { SpeechSegment } from 'common';

/** 引擎能力探测结果；`available=false` 时 UI 必须显式提示或禁用，不得静默转在线（设计 §4.6） */
export interface TtsEngineCapability {
  readonly available: boolean;
  readonly engineName: string;
  readonly offline: boolean;
  readonly voiceCount: number;
  readonly reason?: string;
}

export interface TtsSpeakRequest {
  readonly segment: SpeechSegment;
  /**
   * 代际 ID。切段 / 换音色 / 暂停 / 停止 / 来电中断时必须自增，
   * 引擎线程凭此丢弃旧任务样本，避免"上一段音频继续播放"（设计 §4.6）。
   */
  readonly generation: number;
  readonly speed: number;
}

export interface TtsCallbacks {
  onReady(generation: number): void;
  onProgress(generation: number, playedChars: number): void;
  onError(generation: number, reason: string): void;
}

/** 平台 TTS 引擎抽象。系统离线引擎与 sherpa-onnx 端侧模型共用此接口（TTS-0 / TTS-1）。 */
export interface ITtsEngine {
  capability(): Promise<TtsEngineCapability>;
  init(): Promise<void>;
  speak(request: TtsSpeakRequest, callbacks: TtsCallbacks): Promise<void>;
  stop(generation: number): Promise<void>;
  pause(generation: number): Promise<void>;
  resume(generation: number): Promise<void>;
  release(): Promise<void>;
}
