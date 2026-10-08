import { router } from '@kit.ArkUI';
import { Want, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { CONTENT_TYPE_HTML, AppContextHolder, Note } from 'common';
import {
  AvSessionControls,
  PlaybackCommandSink,
  PlaybackState,
  SpeechPlaybackController,
  SpeechPlan,
  SpeechPlanItem,
} from 'speech';
import { AppServices } from './AppServices';

/**
 * 全局朗读播放（第二批 Feature 5 + 9）。
 *
 * 职责：把 SpeechPlaybackController 的生命周期从阅读页上移到进程级——
 * 页面只是「绑定/解绑 UI 回调」的租客，播放本体跨页存活：
 *  - NoteRead 开始朗读 → attach（换篇 = load 新计划，代际作废旧段）；
 *  - 退页 aboutToDisappear → detachUi（高亮回调丢弃，播放继续）；
 *  - 另一篇开始朗读 → 取代前一篇（load 的 haltActive 语义）；
 *  - 浮标（PlayingBar）/列表高亮经本类监听器注册驱动，不依赖任何页面存活。
 *
 * AVSession 播控（通知栏/锁屏）与音频长时任务（锁屏连读）也归本类管理：
 * 与播放同寿命，随 attach 惰性创建、stopAll 释放。
 *
 * 顺序连读（Feature 9）：onPlanComplete 且开关开 → 按笔记库列表顺序
 * （pinned DESC, updated_at DESC，领域查询天然如此）取下一篇活体笔记，
 * router.replace 到其阅读页并带 autoplay=1 自动起播；HTML 笔记无朗读
 * 计划，跳过；读到尾或开关关即停。
 */

/** 播放状态广播载荷（字段语义只读；监听器模式下无需可变） */
export interface PlaybackBroadcast {
  noteId: string;
  title: string;
  state: PlaybackState;
}

/** 状态监听器（浮标 / 列表高亮等注册；回调在 UI 线程同步派发） */
export type PlaybackListener = (b: PlaybackBroadcast) => void;

/** 阅读页绑定的 UI 回调（解绑后播放继续，回调安全丢弃） */
export interface PlaybackUiSink {
  onStateChange(state: PlaybackState): void;
  onSegmentStart(item: SpeechPlanItem): void;
  onPlanComplete(): void;
  onError(reason: string): void;
}

/** 连读取下一篇时的列表扫描上限（与笔记库列表页同口径） */
const NEXT_NOTE_SCAN_LIMIT: number = 200;

const BUNDLE_NAME: string = 'com.uwon.clipnote';

export class GlobalPlayback {
  private controllerInst: SpeechPlaybackController | undefined = undefined;
  private readonly av: AvSessionControls = new AvSessionControls();
  private avStarted: boolean = false;
  private bgRunning: boolean = false;
  private activeNoteId: string = '';
  private activeTitle: string = '';
  private state: PlaybackState = 'idle';
  private uiSink: PlaybackUiSink | undefined = undefined;
  private readonly listeners: PlaybackListener[] = [];
  /** 换篇计数：AVSession assetId 随之自增以触发锁屏元数据刷新 */
  private ordinal: number = 0;
  /** Feature 9 开关（attach 时惰性从 preferences 加载一次；设置页写入时经 refreshSettings 同步） */
  private sequential: boolean = false;
  private settingsLoaded: boolean = false;
  private readonly svc: AppServices;

  constructor(svc: AppServices) {
    this.svc = svc;
  }

  // ---- 查询面（浮标/列表/阅读页共用） ----

  get playingNoteId(): string {
    return this.activeNoteId;
  }

  get playingTitle(): string {
    return this.activeTitle;
  }

  get playbackState(): PlaybackState {
    return this.state;
  }

  // ---- 状态监听（浮标 / 列表高亮） ----

  /** 注册状态监听器（幂等）；回调收到全量快照 */
  addListener(listener: PlaybackListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  removeListener(listener: PlaybackListener): void {
    const i: number = this.listeners.indexOf(listener);
    if (i >= 0) {
      this.listeners.splice(i, 1);
    }
  }

  /**
   * 重放当前状态快照。页面在路由栈下隐藏期间，其组件的 @State 更新不触发
   * build，回前台后也没有新事件驱动重渲染（实测：浮标消失而列表高亮仍在——
   * 后者靠 onPageShow 的列表刷新顺带重读）。页面 onPageShow 时调用本方法
   * 补一次广播，所有监听组件按最新状态重渲染。
   */
  replay(): void {
    this.broadcast();
  }

  /** 开关刷新（Settings 写入后调用；不落库读取，避免每次连读查 preferences） */
  refreshSettings(sequential: boolean): void {
    this.sequential = sequential;
  }

  /**
   * 重进同一篇时恢复 UI 控制权：活动篇一致即绑定回调并回放当前状态。
   * 返回 false 表示当前篇没有活动播放（首次进入），调用方应走 attach。
   */
  bindIfCurrent(noteId: string, sink: PlaybackUiSink): boolean {
    if (this.activeNoteId !== noteId || this.controllerInst === undefined) {
      return false;
    }
    this.uiSink = sink;
    return true;
  }

  /**
   * 换篇装载（Feature 5 取代语义）：同一控制器 load 新计划——haltActive
   * 作废前一篇在播段（代际机制），游标归零。绑定 UI 回调后返回。
   */
  async attach(noteId: string, title: string, plan: SpeechPlan, sink: PlaybackUiSink): Promise<void> {
    // 冷启动场景（没进过设置页）：首次播放前从 preferences 加载连读开关
    if (!this.settingsLoaded) {
      try {
        const s = await this.svc.settingsStore().load();
        this.sequential = s.sequentialPlayback;
      } catch {
        // 读取失败保持默认（关）
      }
      this.settingsLoaded = true;
    }
    const ctl: SpeechPlaybackController = this.ensureController();
    this.activeNoteId = noteId;
    this.activeTitle = title;
    this.uiSink = sink;
    this.ordinal++;
    await ctl.load(plan);
    await this.ensureAv();
    await this.av.updateMetadata(title, this.ordinal);
  }

  // ---- 控制面（页面控制条 / 浮标 / AVSession 共用） ----

  async play(): Promise<void> {
    await this.controllerInst?.play();
  }

  async pause(): Promise<void> {
    await this.controllerInst?.pause();
  }

  async nextSegment(): Promise<void> {
    await this.controllerInst?.next();
  }

  async prevSegment(): Promise<void> {
    await this.controllerInst?.prev();
  }

  /** 从指定段起播（Q2b 双击段落起读；首次需先 attach） */
  async seekToSegment(index: number): Promise<void> {
    await this.controllerInst?.seekToSegment(index);
  }

  /** 彻底停止并清空全局状态：浮标消失、AVSession 与长时任务释放 */
  async stopAll(): Promise<void> {
    const ctl: SpeechPlaybackController | undefined = this.controllerInst;
    if (ctl !== undefined) {
      await ctl.stop();
    }
    await this.av.stop();
    this.avStarted = false;
    await this.applyBackgroundMode(false);
    this.activeNoteId = '';
    this.activeTitle = '';
    this.state = 'idle';
    this.uiSink = undefined;
    this.broadcast();
  }

  /**
   * 连读推进（当前篇无可朗读内容时由阅读页调用）：空正文/纯图片笔记没有
   * 朗读计划，onPlanComplete 永不触发，若不推进连读链会卡死在本篇。
   * 找当前篇的下一篇并 replace；读到尾（或当前篇已不在列表）即清场。
   */
  async advanceFrom(noteId: string): Promise<void> {
    if (!this.sequential || noteId.length === 0) {
      return;
    }
    const next: Note | undefined = await this.findNextNote(noteId);
    if (next === undefined) {
      await this.stopAll();
      return;
    }
    try {
      await router.replaceUrl({
        url: 'pages/NoteRead',
        params: { 'noteId': next.id, 'autoplay': '1' } as Record<string, string>,
      });
    } catch {
      // 页面栈异常（极端竞态）：本轮连读放弃
    }
  }

  /** 退页解绑 UI 回调（高亮等），播放本体继续（Feature 5 全局化核心） */
  detachUi(): void {
    this.uiSink = undefined;
  }

  // ---- 内部 ----

  private ensureController(): SpeechPlaybackController {
    if (this.controllerInst === undefined) {
      this.controllerInst = new SpeechPlaybackController(this.svc.speechEngine(), {
        onStateChange: (state: PlaybackState): void => {
          this.onControllerState(state);
        },
        onSegmentStart: (item: SpeechPlanItem): void => {
          this.uiSink?.onSegmentStart(item);
        },
        onProgress: (): void => undefined,
        onSegmentFinish: (): void => undefined,
        onPlanComplete: (): void => {
          void this.onControllerPlanComplete();
        },
        onError: (reason: string): void => {
          this.uiSink?.onError(reason);
        },
      });
    }
    return this.controllerInst;
  }

  /** 状态分发：长时任务/广播/UI 回调三路（uiSink 可选） */
  private onControllerState(state: PlaybackState): void {
    this.state = state;
    if (state === 'playing') {
      void this.applyBackgroundMode(true);
    } else if (state === 'completed' || state === 'failed' || state === 'idle') {
      void this.applyBackgroundMode(false);
    }
    // paused / ready 不动长时任务（暂停保留，避免频繁申请失败；ready 前台无妨）
    this.broadcast();
    this.uiSink?.onStateChange(state);
  }

  /** 读完一篇：UI 收尾 + 顺序连读（Feature 9） */
  private async onControllerPlanComplete(): Promise<void> {
    this.uiSink?.onPlanComplete();
    if (!this.sequential || this.activeNoteId.length === 0) {
      return;
    }
    const next: Note | undefined = await this.findNextNote(this.activeNoteId);
    if (next === undefined) {
      await this.stopAll(); // 读完全部（或当前篇已不在列表）
      return;
    }
    try {
      await router.replaceUrl({
        url: 'pages/NoteRead',
        params: { 'noteId': next.id, 'autoplay': '1' } as Record<string, string>,
      });
    } catch {
      // 页面栈异常（极端竞态）：本轮连读放弃，播放停在 completed
    }
  }

  /** 连读队列：当前篇在列表中的下一篇活体笔记（跳过无朗读计划的 HTML 笔记） */
  private async findNextNote(currentId: string): Promise<Note | undefined> {
    const svc = await this.svc.noteService();
    const notes: Note[] = await svc.listRecent(NEXT_NOTE_SCAN_LIMIT);
    let idx: number = -1;
    for (let i: number = 0; i < notes.length; i++) {
      if (notes[i].id === currentId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      return undefined;
    }
    for (let i: number = idx + 1; i < notes.length; i++) {
      if (notes[i].contentType !== CONTENT_TYPE_HTML) {
        return notes[i];
      }
    }
    return undefined;
  }

  /** AVSession 惰性启动（首次 attach；stopAll 后可重建） */
  private async ensureAv(): Promise<void> {
    if (this.avStarted) {
      return;
    }
    const ctx = AppContextHolder.get();
    if (ctx === undefined) {
      return;
    }
    const sink: PlaybackCommandSink = {
      play: (): void => {
        const ctl: SpeechPlaybackController | undefined = this.controllerInst;
        if (ctl === undefined) {
          return; // 无活动播放，锁屏指令无处可去
        }
        if (this.state === 'ready' || this.state === 'paused' || this.state === 'completed') {
          void ctl.play();
        }
      },
      pause: (): void => {
        void this.controllerInst?.pause();
      },
      next: (): void => {
        void this.controllerInst?.next();
      },
      prev: (): void => {
        void this.controllerInst?.prev();
      },
      stop: (): void => {
        void this.stopAll();
      },
    };
    const ok: boolean = await this.av.start(ctx, sink, (reason: string): void => {
      void this.controllerInst?.interrupt(reason);
    });
    this.avStarted = ok;
  }

  /**
   * 音频播放长时任务（锁屏连读）。失败降级：前台朗读不受影响，仅后台
   * 合成可能被冻结（用户可回前台续播）；module.json5 已声明 backgroundModes。
   */
  private async applyBackgroundMode(on: boolean): Promise<void> {
    if (on === this.bgRunning) {
      return;
    }
    const ctx = AppContextHolder.get();
    if (ctx === undefined) {
      return;
    }
    try {
      if (on) {
        const want: Want = { bundleName: BUNDLE_NAME, abilityName: 'EntryAbility' };
        const info: wantAgent.WantAgentInfo = {
          wants: [want],
          actionType: wantAgent.OperationType.START_ABILITY,
          requestCode: 0,
        };
        const agent = await wantAgent.getWantAgent(info);
        await backgroundTaskManager.startBackgroundRunning(
          ctx, backgroundTaskManager.BackgroundMode.AUDIO_PLAYBACK, agent);
        this.bgRunning = true;
      } else {
        await backgroundTaskManager.stopBackgroundRunning(ctx);
        this.bgRunning = false;
      }
    } catch {
      // 降级见方法注释
    }
  }

  /** 状态分发（监听器模式：浮标/列表各自持有的本地回调，UI 线程同步调用） */
  private broadcast(): void {
    const payload: PlaybackBroadcast = {
      noteId: this.activeNoteId,
      title: this.activeTitle,
      state: this.state,
    };
    for (let i: number = 0; i < this.listeners.length; i++) {
      this.listeners[i](payload);
    }
  }
}
