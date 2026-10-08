/**
 * 系统 TTS 驱动端口（S5-1）。
 *
 * 把 `@kit.SpeechKit` 的回调式 API 收敛为 Promise + 监听者端口，目的是：
 *  1. core/ 保持零 @kit.*，可本机 node 全量验证（分层纪律同 common/mcp）；
 *  2. ohosTest 注入 FakeTtsDriver 后**无需真机 TTS** 即可跑生命周期状态机
 *     与取消语义（官方明确模拟器不支持系统 TTS，G4 探测 §"模拟器"行）。
 *
 * 真实适配见 ../adapters/system-tts-driver.ets。
 */

/** createEngine 参数；online 由适配器固定为 1（系统引擎离线-only，G4 探测结论） */
export interface CreateEngineParams {
  readonly language: string;
  readonly person: number;
  readonly speed: number;
  readonly volume: number;
  readonly pitch: number;
}

/** 一次合成请求。requestId 由引擎内核单调签发、一次性使用、绝不复用（G4 探测常见坑②） */
export interface DriverUtterance {
  readonly requestId: number;
  readonly text: string;
  /**
   * 播报参数（真机验收 Q2a 定案）：speed/volume/pitch 官方只接受**随每次 speak 的
   * extraParams 透传**（HarmonyOS 官方 texttospeech-guide 与社区实测一致），
   * 放在 createEngine 参数里会被静默忽略——倍速不生效的根因。
   */
  readonly speed: number;
  readonly volume: number;
  readonly pitch: number;
}

/** 引擎事件监听；requestId 标识样本归属，内核凭代际丢弃过期样本 */
export interface TtsDriverListener {
  onStart(requestId: number): void;
  onComplete(requestId: number): void;
  onError(requestId: number, code: number, message: string): void;
}

export interface TtsEngineDriver {
  /** 创建引擎；失败（如设备无离线引擎）必须 reject，内核据此置 capability.available=false */
  create(params: CreateEngineParams): Promise<void>;
  setListener(listener: TtsDriverListener): void;
  /** 引擎接受请求即 resolve；播完/出错/被取消通过 listener 异步上报 */
  speak(utterance: DriverUtterance): Promise<void>;
  stop(requestId: number): Promise<void>;
  shutdown(): Promise<void>;
}
