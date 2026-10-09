import { router } from '@kit.ArkUI';
import { ClipboardItem, InboxService, Note, NoteService } from 'common';
import { AppServices } from '../services/AppServices';
import { flatPreview, relativeTimeLabel } from '../ui/Format';

/**
 * 垃圾桶页（Feature 2）：已删笔记（软删除）与已弃收件箱条目（DISCARDED）的统一出口。
 *
 * 口径：
 *  - 恢复：笔记清 deleted_at（NoteService.restore）、收件箱条目回 PENDING 时间线；
 *  - 彻底删除：笔记物理移除（附件字节留交 orphan GC），收件箱条目物理移除 ——
 *    两者都不可逆，必须经确认弹窗，文案如实说明不可恢复；
 *  - 「清空垃圾桶」= 两个分区全部物理删除（二次确认）；
 *  - 页面不存副本：每次操作后从数据层重读（同 NoteList 纪律）。
 */

/** 笔记行的展示模型 */
interface TrashNoteRow {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly timeLabel: string;
}

/** 收件箱行的展示模型 */
interface TrashInboxRow {
  readonly id: string;
  readonly preview: string;
  readonly timeLabel: string;
}

const TRASH_PAGE_LIMIT: number = 200;

@Entry
@Component
struct TrashPage {
  @State noteRows: TrashNoteRow[] = [];
  @State inboxRows: TrashInboxRow[] = [];
  @State notice: string = '';
  @State dataReady: boolean = false;
  /** 多选恢复模式：点行切换选中 */
  @State selecting: boolean = false;
  @State selectedNoteIds: string[] = [];
  @State selectedInboxIds: string[] = [];

  private readonly svc: AppServices = AppServices.get();
  private noteSvc: NoteService | undefined = undefined;
  private inboxSvc: InboxService | undefined = undefined;

  aboutToAppear(): void {
    this.initData();
  }

  private async initData(): Promise<void> {
    try {
      this.noteSvc = await this.svc.noteService();
      this.inboxSvc = await this.svc.inboxService();
      await this.refresh();
      this.dataReady = true;
    } catch (err) {
      this.notice = `数据层初始化失败：${String(err)}`;
    }
  }

  private async refresh(): Promise<void> {
    if (this.noteSvc === undefined || this.inboxSvc === undefined) {
      return;
    }
    const notes: Note[] = await this.noteSvc.listDeleted(TRASH_PAGE_LIMIT);
    const noteRows: TrashNoteRow[] = [];
    for (let i: number = 0; i < notes.length; i++) {
      const n: Note = notes[i];
      noteRows.push({
        id: n.id,
        title: n.title,
        preview: flatPreview(n.contentMd, 120),
        timeLabel: relativeTimeLabel(n.deletedAtMs === undefined ? n.updatedAtMs : n.deletedAtMs),
      });
    }
    this.noteRows = noteRows;

    const items: ClipboardItem[] = await this.inboxSvc.listDiscarded(TRASH_PAGE_LIMIT);
    const inboxRows: TrashInboxRow[] = [];
    for (let i: number = 0; i < items.length; i++) {
      inboxRows.push({
        id: items[i].id,
        preview: flatPreview(items[i].rawText, 120),
        timeLabel: relativeTimeLabel(items[i].capturedAtMs),
      });
    }
    this.inboxRows = inboxRows;
  }

  private isEmpty(): boolean {
    return this.noteRows.length === 0 && this.inboxRows.length === 0;
  }

  private selectedTotal(): number {
    return this.selectedNoteIds.length + this.selectedInboxIds.length;
  }

  private toggleSelectNote(id: string): void {
    if (this.selectedNoteIds.indexOf(id) >= 0) {
      this.selectedNoteIds = this.selectedNoteIds.filter((v: string) => v !== id);
    } else {
      this.selectedNoteIds = this.selectedNoteIds.concat([id]);
    }
  }

  private toggleSelectInbox(id: string): void {
    if (this.selectedInboxIds.indexOf(id) >= 0) {
      this.selectedInboxIds = this.selectedInboxIds.filter((v: string) => v !== id);
    } else {
      this.selectedInboxIds = this.selectedInboxIds.concat([id]);
    }
  }

  /** 全选/全不选（两个分区一起） */
  private toggleSelectAll(): void {
    if (this.selectedTotal() === this.noteRows.length + this.inboxRows.length) {
      this.selectedNoteIds = [];
      this.selectedInboxIds = [];
    } else {
      this.selectedNoteIds = this.noteRows.map((row: TrashNoteRow) => row.id);
      this.selectedInboxIds = this.inboxRows.map((row: TrashInboxRow) => row.id);
    }
  }

  private exitSelecting(): void {
    this.selecting = false;
    this.selectedNoteIds = [];
    this.selectedInboxIds = [];
  }

  private async restoreNote(id: string): Promise<void> {
    if (this.noteSvc === undefined) {
      return;
    }
    try {
      await this.noteSvc.restore(id);
      this.notice = '已恢复到笔记库。';
      await this.refresh();
    } catch (err) {
      this.notice = `恢复失败：${String(err)}`;
    }
  }

  private async restoreInbox(id: string): Promise<void> {
    if (this.inboxSvc === undefined) {
      return;
    }
    try {
      await this.inboxSvc.restoreDiscarded(id);
      this.notice = '已恢复到收件箱。';
      await this.refresh();
    } catch (err) {
      this.notice = `恢复失败：${String(err)}`;
    }
  }

  /** 彻底删除笔记（不可逆）：确认文案如实说明边界 */
  private confirmPurgeNote(row: TrashNoteRow): void {
    AlertDialog.show({
      title: '彻底删除',
      message: `《${row.title}》将被永久删除，不可恢复。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '彻底删除',
        fontColor: '#D4380D',
        action: () => {
          this.purgeNote(row.id);
        },
      },
    });
  }

  private async purgeNote(id: string): Promise<void> {
    if (this.noteSvc === undefined) {
      return;
    }
    try {
      await this.noteSvc.purge(id);
      this.notice = '已彻底删除。';
      await this.refresh();
    } catch (err) {
      this.notice = `删除失败：${String(err)}`;
    }
  }

  private confirmPurgeInbox(row: TrashInboxRow): void {
    AlertDialog.show({
      title: '彻底删除',
      message: `该收件箱条目（${row.preview.slice(0, 30)}…）将被永久删除，不可恢复。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '彻底删除',
        fontColor: '#D4380D',
        action: () => {
          this.purgeInbox(row.id);
        },
      },
    });
  }

  private async purgeInbox(id: string): Promise<void> {
    if (this.inboxSvc === undefined) {
      return;
    }
    try {
      await this.inboxSvc.permanentlyDelete(id);
      this.notice = '已彻底删除。';
      await this.refresh();
    } catch (err) {
      this.notice = `删除失败：${String(err)}`;
    }
  }

  /** 多选恢复：所选笔记回笔记库、所选收件箱条目回时间线；逐条如实计数 */
  private async restoreSelected(): Promise<void> {
    if (this.noteSvc === undefined || this.inboxSvc === undefined) {
      return;
    }
    if (this.selectedTotal() === 0) {
      this.notice = '先勾选要恢复的条目。';
      return;
    }
    let restoredNotes: number = 0;
    let restoredItems: number = 0;
    let failures: number = 0;
    for (let i: number = 0; i < this.selectedNoteIds.length; i++) {
      try {
        await this.noteSvc.restore(this.selectedNoteIds[i]);
        restoredNotes++;
      } catch (err) {
        failures++;
      }
    }
    for (let i: number = 0; i < this.selectedInboxIds.length; i++) {
      try {
        await this.inboxSvc.restoreDiscarded(this.selectedInboxIds[i]);
        restoredItems++;
      } catch (err) {
        failures++;
      }
    }
    this.notice = failures === 0
      ? `已恢复 ${restoredNotes} 篇笔记、${restoredItems} 条收件箱。`
      : `已恢复 ${restoredNotes + restoredItems} 条，${failures} 条失败（请重试）。`;
    this.exitSelecting();
    await this.refresh();
  }

  /** 清空垃圾桶（两个分区全部物理删除）：二次确认，文案如实说明不可恢复 */
  private confirmEmptyTrash(): void {
    const total: number = this.noteRows.length + this.inboxRows.length;
    AlertDialog.show({
      title: '清空垃圾桶',
      message: `垃圾桶内共 ${total} 条（${this.noteRows.length} 篇笔记、${this.inboxRows.length} 条收件箱）将被永久删除，不可恢复。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '全部永久删除',
        fontColor: '#D4380D',
        action: () => {
          this.emptyTrash();
        },
      },
    });
  }

  private async emptyTrash(): Promise<void> {
    if (this.noteSvc === undefined || this.inboxSvc === undefined) {
      return;
    }
    let failures: number = 0;
    // 先拍快照再逐条物理删除（删除会改变列表）
    const noteIds: string[] = this.noteRows.map((row: TrashNoteRow) => row.id);
    const inboxIds: string[] = this.inboxRows.map((row: TrashInboxRow) => row.id);
    for (let i: number = 0; i < noteIds.length; i++) {
      try {
        await this.noteSvc.purge(noteIds[i]);
      } catch (err) {
        failures++;
      }
    }
    for (let i: number = 0; i < inboxIds.length; i++) {
      try {
        await this.inboxSvc.permanentlyDelete(inboxIds[i]);
      } catch (err) {
        failures++;
      }
    }
    this.notice = failures === 0 ? '垃圾桶已清空。' : `已清空，${failures} 条删除失败（请重试）。`;
    this.exitSelecting();
    await this.refresh();
  }

  /** 单张已删笔记卡片：由 build() 的 ForEach 逐条包成 ListItem（ListItem 仅支持单子组件，多子节点会叠放） */
  @Builder
  noteCard(row: TrashNoteRow) {
    Column({ space: 4 }) {
          Row({ space: 8 }) {
            if (this.selecting) {
              Text(this.selectedNoteIds.indexOf(row.id) >= 0 ? '☑' : '☐')
                .fontSize(16)
                .fontColor('#1F6FEB')
            }
            Text(row.title)
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            Text(row.timeLabel)
              .fontSize(11)
              .fontColor('#8C8C8C')
          }
          .width('100%')
          Text(row.preview)
            .fontSize(13)
            .fontColor('#595959')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          if (!this.selecting) {
            Row({ space: 12 }) {
              Text('恢复')
                .fontSize(13)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  this.restoreNote(row.id);
                })
              Text('彻底删除')
                .fontSize(13)
                .fontColor('#D4380D')
                .onClick(() => {
                  this.confirmPurgeNote(row);
                })
            }
            .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(10)
        .backgroundColor('#F5F5F5')
        .borderRadius(8)
        .onClick(() => {
          if (this.selecting) {
            this.toggleSelectNote(row.id);
          }
        })
  }

  /** 单张已弃收件箱卡片：同 noteCard，由 ForEach 逐条包 ListItem */
  @Builder
  inboxCard(row: TrashInboxRow) {
    Column({ space: 4 }) {
          Row({ space: 8 }) {
            if (this.selecting) {
              Text(this.selectedInboxIds.indexOf(row.id) >= 0 ? '☑' : '☐')
                .fontSize(16)
                .fontColor('#1F6FEB')
            }
            Text(row.preview)
              .fontSize(13)
              .fontColor('#595959')
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            Text(row.timeLabel)
              .fontSize(11)
              .fontColor('#8C8C8C')
          }
          .width('100%')
          if (!this.selecting) {
            Row({ space: 12 }) {
              Text('恢复')
                .fontSize(13)
                .fontColor('#1F6FEB')
                .onClick(() => {
                  this.restoreInbox(row.id);
                })
              Text('彻底删除')
                .fontSize(13)
                .fontColor('#D4380D')
                .onClick(() => {
                  this.confirmPurgeInbox(row);
                })
            }
            .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(10)
        .backgroundColor('#F5F5F5')
        .borderRadius(8)
        .onClick(() => {
          if (this.selecting) {
            this.toggleSelectInbox(row.id);
          }
        })
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
        Text('垃圾桶')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        if (this.selecting) {
          Text('取消')
            .fontSize(15)
            .fontColor('#1F6FEB')
            .onClick(() => {
              this.exitSelecting();
            })
        } else {
          Text('多选')
            .fontSize(15)
            .fontColor('#1F6FEB')
            .onClick(() => {
              this.selecting = true;
            })
          Text('清空')
            .fontSize(15)
            .fontColor('#D4380D')
            .margin({ left: 12 })
            .onClick(() => {
              this.confirmEmptyTrash();
            })
        }
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
      } else if (this.isEmpty()) {
        Text('垃圾桶为空。删除的笔记与弃置的收件箱条目会先到这里，可恢复。')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else {
        List({ space: 8 }) {
          ListItem() {
            Text(`已删笔记（${this.noteRows.length}）`)
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .width('100%')
          }
          if (this.noteRows.length === 0) {
            ListItem() {
              Text('无')
                .fontSize(12)
                .fontColor('#8C8C8C')
                .width('100%')
            }
          }
          ForEach(this.noteRows, (row: TrashNoteRow) => {
            ListItem() {
              this.noteCard(row)
            }
          }, (row: TrashNoteRow) => row.id)
          ListItem() {
            Text(`已弃收件箱（${this.inboxRows.length}）`)
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .width('100%')
          }
          if (this.inboxRows.length === 0) {
            ListItem() {
              Text('无')
                .fontSize(12)
                .fontColor('#8C8C8C')
                .width('100%')
            }
          }
          ForEach(this.inboxRows, (row: TrashInboxRow) => {
            ListItem() {
              this.inboxCard(row)
            }
          }, (row: TrashInboxRow) => row.id)
        }
        .layoutWeight(1)
        .width('100%')
      }

      // 多选恢复操作条
      if (this.selecting) {
        Row({ space: 10 }) {
          Text(this.selectedTotal() === this.noteRows.length + this.inboxRows.length ? '全不选' : '全选')
            .fontSize(13)
            .fontColor('#1F6FEB')
            .onClick(() => {
              this.toggleSelectAll();
            })
          Text(`已选 ${this.selectedTotal()} 条`)
            .fontSize(13)
            .fontColor('#595959')
            .layoutWeight(1)
          Button('恢复所选')
            .fontSize(14)
            .height(36)
            .enabled(this.selectedTotal() > 0)
            .onClick(() => {
              this.restoreSelected();
            })
        }
        .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
