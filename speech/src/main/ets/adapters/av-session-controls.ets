/**
 * AVSession 播控适配（S5-2；设计 §4.6「AVSession 播控」+ 评审 F10 修正口径：
 * AVSession 的控制面 ≠ 后台合成资格）。
 *
 * 本类只做「控制面」：通知栏/锁屏的播放、暂停、上/下一段、停止指令，以及
 * 音频焦点被抢占（来电/闹钟等）的事件上报。朗读调度仍归
 * core/controller.ts（SpeechPlaybackController），此处仅做指令映射。
 *
 * ⚠️ 真机核对项（本文件未经设备编译，按 API 12（5.0.0(12)）文档最小共识书写，
 * 与 entry 其余 @kit 调用同一纪律）：
 *  1. `@kit.AVSessionKit` 的导入与 AVSession 创建形态（createAVSession 归属与
 *     参数序、'audio' 会话类型取值）；
 *  2. AVSession 指令事件名（'play' / 'pause' / 'next' / 'previous' / 'stop'）与
 *     off 解除注册形态；
 *  3. setAVMetadata 字段（assetId / title / artist）与锁屏展示行为；
 *  4. activate() / deactivate() 的音频焦点获取与抢占语义；
 *  5. 焦点中断事件来源——G4 探测已注明「来电/焦点抢占行为目前无任何实测证据」
 *     （tools/report/g4-tts-probe.md §5-6），故双路最小共识尝试、失败静默降级：
 *     没有焦点中断通知时播控仍可用，仅中断自动暂停不可用（用户可手动暂停）。
 */

import { common } from '@kit.AbilityKit';
import avSession from '@kit.AVSessionKit';
import { audio } from '@kit.AudioKit';

/** 播控指令的接收方（entry 侧映射到 SpeechPlaybackController） */
export interface PlaybackCommandSink {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  stop(): void;
}

/** 焦点中断上报（entry 侧映射到 controller.interrupt(reason)） */
export type InterruptHandler = (reason: string) => void;

export class AvSessionControls {
  private session: avSession.AVSession | undefined = undefined;
  private sinkValue: PlaybackCommandSink | undefined = undefined;

  /**
   * 创建音频会话并注册播控指令与焦点中断。任何一步失败都返回 false——
   * 降级为无通知栏播控（应用内按钮仍可用），不阻断朗读主链路。
   */
  async start(
    context: common.Context,
    sink: PlaybackCommandSink,
    onInterrupt: InterruptHandler,
  ): Promise<boolean> {
    try {
      const session: avSession.AVSession = await avSession.createAVSession(context, 'ClipNote', 'audio');
      this.session = session;
      this.sinkValue = sink;
      // 播控指令（通知栏/锁屏/线控）
      session.on('play', () => this.sinkValue?.play());
      session.on('pause', () => this.sinkValue?.pause());
      session.on('next', () => this.sinkValue?.next());
      session.on('previous', () => this.sinkValue?.prev());
      session.on('stop', () => this.sinkValue?.stop());
      // 音频焦点（真机核对项 4/5：activate 获取焦点；中断事件双路尝试）
      await session.activate();
      this.registerInterrupt(session, onInterrupt);
      return true;
    } catch {
      await this.stop();
      return false;
    }
  }

  /** 更新锁屏/通知栏元信息（当前篇名；assetId 每次换篇自增以触发刷新） */
  async updateMetadata(title: string, ordinal: number): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    try {
      await session.setAVMetadata({
        assetId: `clipnote-speech-${ordinal}`,
        title,
        artist: 'ClipNote 拾记',
      });
    } catch {
      // 元信息失败不影响播控（真机核对项 3）
    }
  }

  /** 解除注册并释放会话（退页/停止朗读时调用；幂等） */
  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.sinkValue = undefined;
    if (session === undefined) {
      return;
    }
    try {
      session.off('play');
      session.off('pause');
      session.off('next');
      session.off('previous');
      session.off('stop');
      await session.deactivate();
      await session.release();
    } catch {
      // 释放失败无补救必要（进程内对象随 Ability 销毁回收）
    }
  }

  /**
   * 焦点中断注册（真机核对项 5：双路最小共识）。
   *  路 A：AudioManager 会话级中断监听（API 12 音频焦点口径）；
   *  路 B：AVSession 自带 interrupt 事件（不同 API 版本命名有差异，忽略参数细节，
   *      只取「有中断即暂停」语义）。
   * 任一路成功即可；都失败则中断自动暂停不可用（文档化降级）。
   */
  private registerInterrupt(session: avSession.AVSession, onInterrupt: InterruptHandler): void {
    let registered = false;
    try {
      audio.getAudioManager().on('audioInterrupt', () => {
        onInterrupt('音频焦点被抢占（audioInterrupt）');
      });
      registered = true;
    } catch {
      // 路 A 不可用，试路 B
    }
    if (!registered) {
      try {
        // 不同版本事件名/载荷有差异，按「收到即中断」最小语义挂接
        (session as object as Record<string, unknown>).on('audioInterrupt', () => {
          onInterrupt('音频焦点被抢占（AVSession interrupt）');
        });
        registered = true;
      } catch {
        // 双路均不可用：中断自动暂停降级（真机核对项 5 文档化）
      }
    }
  }
}
