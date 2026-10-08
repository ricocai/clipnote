import { textToSpeech } from '@kit.CoreSpeechKit';
import { CreateEngineParams, DriverUtterance, TtsDriverListener, TtsEngineDriver } from '../core/driver';

/**
 * 系统离线 TTS 驱动适配（S5-1，G4 探测结论落地）。
 *
 * 已按 SDK 实际声明（@kit.CoreSpeechKit → @hms.ai.textToSpeech）核对修正：
 *  - `online: 1` 固定：系统引擎离线-only，0（在线）创建必失败（探测 E1）；
 *  - zh-CN、person=0（聆小珊）为官方口径，多音色枚举属 TTS-2 真机项（探测 E2/E6）；
 *  - 引擎直接播报，无 PCM 流出——进度上报粒度见 core/engine.ts 注释；
 *  - speed/volume/pitch 不在 CreateEngineParams 字段内，经 extraParams 透传
 *    （SDK 文档未列这些键，真机若被忽略属平台行为，内核仍记录用户设置）；
 *  - requestId 口径：内核签发 number，SDK 要求 string，适配层 String()/Number() 双向映射；
 *  - stop() 无 requestId 参数（SDK 语义为停当前播报），shutdown() 无回调，
 *    两者同步返回即视为完成；onStop 映射为 onComplete（取消语义，见 core/engine.ts）。
 */
export class SystemTtsDriver implements TtsEngineDriver {
  private engine: textToSpeech.TextToSpeechEngine | undefined;
  private listener: TtsDriverListener | undefined = undefined;

  setListener(listener: TtsDriverListener): void {
    this.listener = listener;
  }

  create(params: CreateEngineParams): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
      // speed/volume/pitch 不在此处透传：SDK 的 CreateEngineParams.extraParams 不接受
      // 这些键（官方 texttospeech-guide：它们属于 speak 的 extraParams），放了会被静默
      // 忽略（真机验收 Q2a 倍速不生效的根因）。播报参数见 speak()。
      const ttsParams: textToSpeech.CreateEngineParams = {
        language: params.language,
        person: params.person,
        online: 1,
      };
      textToSpeech.createEngine(
        ttsParams,
        (err: Error, engine: textToSpeech.TextToSpeechEngine): void => {
          if (err !== undefined && err !== null) {
            reject(new Error(`系统 TTS 引擎创建失败（设备无离线引擎？）：${err.message}`));
            return;
          }
          this.engine = engine;
          const speakListener: textToSpeech.SpeakListener = {
            onStart: (requestId: string, response: textToSpeech.StartResponse): void => {
              this.listener?.onStart(Number(requestId));
            },
            onComplete: (requestId: string, response: textToSpeech.CompleteResponse): void => {
              this.listener?.onComplete(Number(requestId));
            },
            onStop: (requestId: string, response: textToSpeech.StopResponse): void => {
              // stop() 触发的结束按「正常取消」上报，内核据此 resolve 当前段（非错误）
              this.listener?.onComplete(Number(requestId));
            },
            onError: (requestId: string, errorCode: number, errorMessage: string): void => {
              this.listener?.onError(Number(requestId), errorCode, errorMessage);
            },
          };
          engine.setListener(speakListener);
          resolve();
        },
      );
    });
  }

  async speak(utterance: DriverUtterance): Promise<void> {
    const engine: textToSpeech.TextToSpeechEngine = this.requireEngine();
    // 官方 texttospeech-guide 口径（社区三源一致）：播报参数随每次 speak 的
    // extraParams 透传，段级生效——这正是「换倍速按段落边界生效」的实现载体（Q2a）。
    const extraParams: Record<string, Object> = {};
    extraParams['queueMode'] = 0;
    extraParams['speed'] = utterance.speed;
    extraParams['volume'] = utterance.volume;
    extraParams['pitch'] = utterance.pitch;
    extraParams['languageContext'] = 'zh-CN';
    extraParams['audioType'] = 'pcm';
    extraParams['soundChannel'] = 3;
    // 引擎直接播报：playType=1（无 PCM 流出，进度按段粒度上报）
    extraParams['playType'] = 1;
    const speakParams: textToSpeech.SpeakParams = {
      requestId: String(utterance.requestId),
      extraParams: extraParams,
    };
    // speak 无回调：同步调用不抛错即视为「引擎已接受请求」，播完/出错经 listener 异步上报
    engine.speak(utterance.text, speakParams);
  }

  async stop(requestId: number): Promise<void> {
    const engine: textToSpeech.TextToSpeechEngine = this.requireEngine();
    // SDK 的 stop() 无 requestId 参数：停当前播报，结果经 onStop 回调上报
    engine.stop();
  }

  async shutdown(): Promise<void> {
    const engine: textToSpeech.TextToSpeechEngine | undefined = this.engine;
    this.engine = undefined;
    if (engine === undefined) {
      return;
    }
    // shutdown() 无回调：同步返回即视为已释放
    engine.shutdown();
  }

  private requireEngine(): textToSpeech.TextToSpeechEngine {
    if (this.engine === undefined) {
      throw new Error('引擎未创建——先调用 init()/capability()');
    }
    return this.engine;
  }
}
