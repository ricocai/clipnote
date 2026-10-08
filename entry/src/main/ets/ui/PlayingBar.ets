import { router } from '@kit.ArkUI';
import { PlaybackBroadcast, PlaybackListener } from '../services/GlobalPlayback';
import { AppServices } from '../services/AppServices';

/**
 * 正在朗读浮标（第二批 Feature 5）：全局播放的常驻控制条，挂在
 * Index / NoteList / NoteRead 页面底部。监听器驱动，不持有页面引用——
 * 页面销毁不影响播放，播放停止浮标自然消失。
 *
 * 显示条件：全局有活动篇且处于 playing/paused（completed/failed 由连读
 * 逻辑接续或 stopAll 清场，浮标不驻留）。
 * 点击标题回到该笔记阅读页；停止 = 全局 stopAll（浮标消失）。
 */
@Component
export struct PlayingBar {
  @State playingId: string = '';
  @State playingTitle: string = '';
  @State playing: boolean = false;
  @State paused: boolean = false;
  /** 渲染时钟：apply 每次自增，保证隐藏期间的陈旧渲染在 replay 后必然重建
   （页面在路由栈下时 @State 更新不触发 build；回前台 replay 若全为同值赋值
   不会再触发渲染，浮标会停留在隐藏前的旧状态上——实测踩坑） */
  @State tick: number = 0;

  private listener: PlaybackListener | undefined = undefined;

  aboutToAppear(): void {
    const g = AppServices.get().globalPlayback();
    // 已有播放中的篇（页面晚于播放创建）：先同步一次当前状态
    this.apply({
      noteId: g.playingNoteId,
      title: g.playingTitle,
      state: g.playbackState,
    });
    this.listener = (b: PlaybackBroadcast): void => {
      this.apply(b);
    };
    g.addListener(this.listener);
  }

  aboutToDisappear(): void {
    const l = this.listener;
    if (l !== undefined) {
      AppServices.get().globalPlayback().removeListener(l);
      this.listener = undefined;
    }
  }

  private apply(b: PlaybackBroadcast): void {
    this.playingId = b.noteId;
    this.playingTitle = b.title;
    this.playing = b.state === 'playing';
    this.paused = b.state === 'paused';
    this.tick = this.tick + 1;
  }

  build() {
    if ((this.playing || this.paused) && this.playingId.length > 0 && this.tick > 0) {
      Row({ space: 8 }) {
        Text(this.paused ? '⏸' : '▶')
          .fontSize(14)
          .fontColor('#1F6FEB')
        Text(`正在朗读：${this.playingTitle}`)
          .fontSize(13)
          .fontColor('#1F6FEB')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .onClick(() => {
            const params: Record<string, string> = { 'noteId': this.playingId };
            router.pushUrl({ url: 'pages/NoteRead', params: params });
          })
        if (this.playing) {
          Text('暂停')
            .fontSize(13)
            .fontColor('#1F6FEB')
            .onClick(() => {
              void AppServices.get().globalPlayback().pause();
            })
        } else {
          Text('继续')
            .fontSize(13)
            .fontColor('#1F6FEB')
            .onClick(() => {
              void AppServices.get().globalPlayback().play();
            })
        }
        Text('停止')
          .fontSize(13)
          .fontColor('#D4380D')
          .onClick(() => {
            void AppServices.get().globalPlayback().stopAll();
          })
      }
      .width('100%')
      .padding({ left: 10, right: 10, top: 8, bottom: 8 })
      .backgroundColor('#E6F4FF')
      .borderRadius(8)
    }
  }
}
