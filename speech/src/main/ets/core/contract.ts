/**
 * 引擎契约（S5-1 前的冻结接口，本次实现未改动任何签名——调用方零改动）。
 *
 * 依据：`speech/Index.ets` V0.1 冻结边界 + 设计 §4.6 + G4 探测结论
 * （tools/report/g4-tts-probe.md）。接口从 Index.ets 移至本文件仅为让
 * core/ 能用 `implements` 显式对齐并参与本机 node 验证；对外仍从 'speech' 导入。
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
