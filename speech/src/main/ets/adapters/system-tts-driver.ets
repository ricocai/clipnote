import { textToSpeech } from '@kit.SpeechKit';
import { CreateEngineParams, DriverUtterance, TtsDriverListener, TtsEngineDriver } from '../core/driver';

/**
 * 系统离线 TTS 驱动适配（S5-1，G4 探测结论落地）。
 *
 *  - `online: 1` 固定：系统引擎离线-only，0（在线）创建必失败（探测 E1）；
 *  - zh-CN、person=0（聆小珊）为官方口径，多音色枚举属 TTS-2 真机项（探测 E2/E6）；
 *  - playType=1：引擎直接播报，无 PCM 流出——进度上报粒度见 core/engine.ts 注释；
 *  - 旧引擎（API 12~22）API 面 speak/stop/isBusy/shutdown + 回调集，无原生
 *    pause/resume（pause/resume 由内核方案 A 在引擎层实现，探测"接口对齐"节）。
 *
 * ⚠️ 真机核对项（G4 §5，联调时逐项确认）：setListener 回调签名、stop 是否
 * 携带 callback、speak 的 extraParams 透传格式。探测时官方 API 参考页 JS
 * 渲染未抓全，以上按 Codelabs（E1）+ 社区交叉（E3）的最小共识书写。
 */
export class SystemTtsDriver implements TtsEngineDriver {
  private engine: textToSpeech.TextToSpeechEngine | undefined;
  private listener: TtsDriverListener | undefined = undefined;

  setListener(listener: TtsDriverListener): void {
    this.listener = listener;
  }

  create(params: CreateEngineParams): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
      const ttsParams: textToSpeech.CreateEngineParams = {
        language: params.language,
        person: params.person,
        online: 1,
        speed: params.speed,
        volume: params.volume,
        pitch: params.pitch,
      };
      textToSpeech.createEngine(
        ttsParams,
        (err: Error, engine: textToSpeech.TextToSpeechEngine): void => {
          if (err !== undefined && err !== null) {
            reject(new Error(`系统 TTS 引擎创建失败（设备无离线引擎？）：${err.message}`));
            return;
          }
          this.engine = engine;
          engine.setListener({
            onStart: (requestId: number): void => {
              this.listener?.onStart(requestId);
            },
            onComplete: (requestId: number): void => {
              this.listener?.onComplete(requestId);
            },
            onError: (requestId: number, errorCode: number, errorMessage: string): void => {
              this.listener?.onError(requestId, errorCode, errorMessage);
            },
          });
          resolve();
        },
      );
    });
  }

  async speak(utterance: DriverUtterance): Promise<void> {
    const engine: textToSpeech.TextToSpeechEngine = this.requireEngine();
    const speakParams: Record<string, object | number | string> = {
      requestId: utterance.requestId,
      text: utterance.text,
      extraParams: { playType: 1 },
    };
    await new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
      engine.speak(speakParams as textToSpeech.SpeakParams, (err: Error): void => {
        if (err !== undefined && err !== null) {
          reject(new Error(`speak 调用失败：${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  async stop(requestId: number): Promise<void> {
    const engine: textToSpeech.TextToSpeechEngine = this.requireEngine();
    engine.stop(requestId);
  }

  async shutdown(): Promise<void> {
    const engine: textToSpeech.TextToSpeechEngine | undefined = this.engine;
    this.engine = undefined;
    if (engine === undefined) {
      return;
    }
    await new Promise<void>((resolve: () => void): void => {
      engine.shutdown((): void => {
        resolve();
      });
    });
  }

  private requireEngine(): textToSpeech.TextToSpeechEngine {
    if (this.engine === undefined) {
      throw new Error('引擎未创建——先调用 init()/capability()');
    }
    return this.engine;
  }
}
