import { router } from '@kit.ArkUI';
import { Note, NoteService } from 'common';
import { AppServices } from '../services/AppServices';
import { flatPreview, relativeTimeLabel } from '../ui/Format';

/**
 * 笔记列表页（S3-1；设计 §4.2 删除协议 / §8 列表性能口径）。
 *
 * 数据纪律：
 *  - 一次加载 ≤ NOTE_PAGE_LIMIT 条（LIMIT 约束，不一次载入全库）；
 *  - 行内标签为本地 SQL 逐条查询（单条亚毫秒；若 10k 规模出现掉帧，
 *    优化路径是搜索页落地时一并换成批量查询，先记录不去预付复杂度）；
 *  - 滑动操作有三个：收藏（置顶）切换、编辑、删除（= 移入回收站，软删除）。
 *    删除必须经确认弹窗；回收站条目的查看/恢复入口随 V0.1 搜索组织任务落地（S3-2）。
 *  - 点行进阅读页（S3-2 起）；编辑从滑动操作或阅读页进入。
 *  - 列表排序跟随领域查询：置顶优先，其余更新时间倒序（S3-1 起）。
 */

/** 列表页单次加载上限（与领域层 NOTE_LIST_LIMIT 同口径） */
const NOTE_PAGE_LIMIT: number = 200;

/** 笔记行的展示模型（UI 态与领域模型分离，同 InboxRow 纪律） */
interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly tagsLabel: string;
  readonly timeLabel: string;
  readonly pinned: boolean;
}

@Entry
@Component
struct NoteList {
  @State rows: NoteRow[] = [];
  @State notice: string = '';
  @State dataReady: boolean = false;

  private readonly svc: AppServices = AppServices.get();
  private noteSvc: NoteService | undefined = undefined;

  aboutToAppear(): void {
    this.initData();
  }

  onPageShow(): void {
    // 从编辑页返回即刷新（"存为笔记"与列表打通的落地口径：列表反映最新状态）
    this.refresh();
  }

  private async initData(): Promise<void> {
    try {
      this.noteSvc = await this.svc.noteService();
      await this.refresh();
      this.dataReady = true;
    } catch (err) {
      this.notice = `数据层初始化失败：${String(err)}`;
    }
  }

  private async refresh(): Promise<void> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined) {
      return;
    }
    const notes: Note[] = await svc.listRecent(NOTE_PAGE_LIMIT);
    const built: NoteRow[] = [];
    for (let i: number = 0; i < notes.length; i++) {
      const n: Note = notes[i];
      const tags = await svc.listTagsOfNote(n.id);
      let tagText: string = '';
      for (let t: number = 0; t < tags.length; t++) {
        tagText += (t > 0 ? ' · ' : '') + tags[t].name;
      }
      built.push({
        id: n.id,
        title: n.title,
        preview: flatPreview(n.contentMd, 120),
        tagsLabel: tagText,
        timeLabel: relativeTimeLabel(n.updatedAtMs),
        pinned: n.pinned,
      });
    }
    this.rows = built;
  }

  private openReader(id: string): void {
    const params: Record<string, string> = { 'noteId': id };
    router.pushUrl({ url: 'pages/NoteRead', params: params });
  }

  private openEditor(id: string): void {
    const params: Record<string, string> = { 'noteId': id };
    router.pushUrl({ url: 'pages/NoteEdit', params: params });
  }

  private async togglePin(row: NoteRow): Promise<void> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined) {
      return;
    }
    try {
      await svc.setPinned(row.id, !row.pinned);
      await this.refresh();
    } catch (err) {
      this.notice = `操作失败：${String(err)}`;
    }
  }

  /** 删除 = 移入回收站（软删除）。确认文案如实说明可在回收站找回的窗口边界 */
  private confirmDelete(row: NoteRow): void {
    AlertDialog.show({
      title: '移入回收站',
      message: `《${row.title}》将移入回收站，从列表消失；恢复入口随搜索页（S3-2）提供。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '移入回收站',
        fontColor: '#D4380D',
        action: () => {
          this.doDelete(row);
        },
      },
    });
  }

  private async doDelete(row: NoteRow): Promise<void> {
    if (this.noteSvc === undefined) {
      return;
    }
    try {
      await this.noteSvc.moveToTrash(row.id);
      this.notice = '已移入回收站。';
      await this.refresh();
    } catch (err) {
      this.notice = `删除失败：${String(err)}`;
    }
  }

  @Builder
  itemEnd(row: NoteRow) {
    Row({ space: 8 }) {
      Button(row.pinned ? '取消置顶' : '置顶')
        .fontSize(12)
        .height(44)
        .backgroundColor('#F5F5F5')
        .fontColor('#333333')
        .onClick(() => {
          this.togglePin(row);
        })
      Button('编辑')
        .fontSize(12)
        .height(44)
        .backgroundColor('#F5F5F5')
        .fontColor('#333333')
        .onClick(() => {
          this.openEditor(row.id);
        })
      Button('删除')
        .fontSize(12)
        .height(44)
        .backgroundColor('#FFF1F0')
        .fontColor('#D4380D')
        .onClick(() => {
          this.confirmDelete(row);
        })
    }
    .padding({ left: 8 })
  }

  build() {
    Column({ space: 10 }) {
      Row() {
        Text('‹ 返回')
          .fontSize(15)
          .fontColor('#1F6FEB')
          .onClick(() => {
            router.back();
          })
        Text('笔记库')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text('新建')
          .fontSize(15)
          .fontColor('#1F6FEB')
          .onClick(() => {
            this.openEditor('');
          })
      }
      .width('100%')

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(13)
          .fontColor('#1F6FEB')
          .width('100%')
      }

      if (!this.dataReady) {
        Text('数据层初始化中…')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else if (this.rows.length === 0) {
        Text('还没有笔记。可以从收件箱「存为笔记」，或点右上角「新建」。')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else {
        List({ space: 8 }) {
          ForEach(this.rows, (row: NoteRow) => {
            ListItem() {
              Column({ space: 4 }) {
                Text(`${row.pinned ? '📌 ' : ''}${row.title}`)
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(row.preview)
                  .fontSize(13)
                  .fontColor('#595959')
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Row() {
                  if (row.tagsLabel.length > 0) {
                    Text(row.tagsLabel)
                      .fontSize(11)
                      .fontColor('#8C8C8C')
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .layoutWeight(1)
                  } else {
                    Text('')
                      .layoutWeight(1)
                  }
                  Text(row.timeLabel)
                    .fontSize(11)
                    .fontColor('#8C8C8C')
                }
                .width('100%')
              }
              .alignItems(HorizontalAlign.Start)
              .width('100%')
              .padding(10)
              .backgroundColor('#F5F5F5')
              .borderRadius(8)
            }
            .onClick(() => {
              this.openReader(row.id);
            })
            .swipeAction({ end: this.itemEnd(row) })
          }, (row: NoteRow) => row.id)
        }
        .layoutWeight(1)
        .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
