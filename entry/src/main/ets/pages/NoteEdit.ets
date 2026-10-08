import { router } from '@kit.ArkUI';
import { Note, NoteService } from 'common';
import { AppServices } from '../services/AppServices';
import { ImportedImage, pickImageFromGallery, readImageFromPasteboard } from '../media/ImageImport';

/**
 * 笔记编辑页（S3-1；设计 §4.3"编辑器一期 TextArea + 工具条"）。
 *
 * 口径：
 *  - 一次保存 = 标题 + 正文一条修订（revision +1），标签按目标集合差量同步（均在 NoteService）；
 *  - 图片导入走"用户显式按钮"：选图（系统选择器，不申请图库读取权限）与
 *    粘贴图片（此刻才读剪贴板；API 12 未授权会如实抛 201，文案直出）——
 *    不存在任何自动/后台读取；
 *  - 图片字节 → 附件库（内容寻址 + 原子写入 + attachment:// 引用）全部由
 *    NoteService 承担，本页只搬运字节与结果文案。
 *
 * 平台 API 编译口径声明（同 G1 探针纪律）：本文件与 media/ImageImport.ets 未经设备编译，
 * 按 API 12（5.0.0(12)）文档口径编写；真机编译若遇签名差异，以 SDK 报错为准修正调用形态。
 */

/** 把标签输入拆成目标集合；trim/去重/去空由领域层 setTags 再收敛一次 */
function parseTagInput(raw: string): string[] {
  const out: string[] = [];
  const parts: string[] = raw.split(/[,，、;；\s]+/);
  for (let i: number = 0; i < parts.length; i++) {
    const p: string = parts[i].trim();
    if (p.length > 0) {
      out.push(p);
    }
  }
  return out;
}

@Entry
@Component
struct NoteEdit {
  @State noteId: string = '';
  @State titleText: string = '';
  @State tagText: string = '';
  @State bodyText: string = '';
  @State pinned: boolean = false;
  @State notice: string = '';
  @State loaded: boolean = false;

  private readonly svc: AppServices = AppServices.get();
  private noteSvc: NoteService | undefined = undefined;
  private busy: boolean = false;
  /** 进入页面时的内容快照；"返回时未改动则不产生修订"的判定依据 */
  private snapTitle: string = '';
  private snapTag: string = '';
  private snapBody: string = '';
  private snapPinned: boolean = false;
  private createdHere: boolean = false;

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, string> | undefined;
    let id: string = '';
    if (params !== undefined && params !== null) {
      const v: string | undefined = params['noteId'];
      if (v !== undefined && v !== null) {
        id = v;
      }
    }
    this.init(id);
  }

  private async init(id: string): Promise<void> {
    let svc: NoteService | undefined = undefined;
    try {
      svc = await this.svc.noteService();
      this.noteSvc = svc;
    } catch (err) {
      this.notice = `数据层初始化失败：${String(err)}`;
      return;
    }
    if (id.length === 0 || svc === undefined) {
      this.loaded = true;
      return;
    }
    try {
      const note: Note | undefined = await svc.getById(id);
      if (note === undefined) {
        this.notice = '该笔记不存在或已在回收站中。';
        this.loaded = true;
        return;
      }
      const tags = await svc.listTagsOfNote(id);
      let tagText: string = '';
      for (let t: number = 0; t < tags.length; t++) {
        tagText += (t > 0 ? ', ' : '') + tags[t].name;
      }
      this.noteId = id;
      this.titleText = note.title;
      this.tagText = tagText;
      this.bodyText = note.contentMd;
      this.pinned = note.pinned;
      this.snapTitle = note.title;
      this.snapTag = tagText;
      this.snapBody = note.contentMd;
      this.snapPinned = note.pinned;
      this.loaded = true;
    } catch (err) {
      this.notice = `载入失败：${String(err)}`;
      this.loaded = true;
    }
  }

  private isDirty(): boolean {
    if (this.createdHere) {
      return true;
    }
    return this.titleText !== this.snapTitle
      || this.tagText !== this.snapTag
      || this.bodyText !== this.snapBody
      || this.pinned !== this.snapPinned;
  }

  /** 一次保存 = 标题 + 正文一条修订 + 标签按目标集合同步；无 busy 检查（由入口负责） */
  private async saveOnce(): Promise<boolean> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined) {
      return false;
    }
    try {
      const before: string = this.noteId;
      let saved: Note;
      if (before.length === 0) {
        saved = await svc.save({ title: this.titleText, contentMd: this.bodyText });
        this.noteId = saved.id;
        this.createdHere = true;
      } else {
        saved = await svc.save({ id: before, title: this.titleText, contentMd: this.bodyText });
      }
      await svc.setTags(this.noteId, parseTagInput(this.tagText));
      if (this.pinned !== saved.pinned) {
        await svc.setPinned(this.noteId, this.pinned);
      }
      return true;
    } catch (err) {
      this.notice = `保存失败：${String(err)}`;
      return false;
    }
  }

  /** 返回 = 自动保存后退出（列表页 onPageShow 刷新，打通"编辑 → 列表"） */
  private async backAndSave(): Promise<void> {
    const emptyNew: boolean = this.noteId.length === 0
      && this.titleText.trim().length === 0
      && this.bodyText.trim().length === 0;
    if (!this.isDirty() || emptyNew) {
      router.back();
      return;
    }
    if (this.busy) {
      return;
    }
    this.busy = true;
    const ok: boolean = await this.saveOnce();
    this.busy = false;
    if (ok) {
      router.back();
    }
  }

  /**
   * 删除本篇（= 移入回收站，软删除；与列表页滑动删除同一口径 §4.2）。
   * 只有已落库的笔记才有（新建未保存的笔记丢弃即可，返回键已自动放弃空笔记）。
   */
  private confirmDelete(): void {
    const name: string = this.titleText.trim().length > 0 ? this.titleText : '未命名笔记';
    AlertDialog.show({
      title: '移入回收站',
      message: `《${name}》将移入回收站，从列表消失；可在「回收站」中恢复。`,
      primaryButton: {
        value: '取消',
        action: () => {},
      },
      secondaryButton: {
        value: '移入回收站',
        fontColor: '#D4380D',
        action: () => {
          this.doDelete();
        },
      },
    });
  }

  private async doDelete(): Promise<void> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined || this.busy) {
      return;
    }
    this.busy = true;
    try {
      await svc.moveToTrash(this.noteId);
      // 本篇正在朗读：先停，避免回收站里的笔记继续占播控与连读链
      if (this.svc.globalPlayback().playingNoteId === this.noteId) {
        void this.svc.globalPlayback().stopAll();
      }
      try {
        const st = router.getState();
        if (st !== undefined && st !== null && st.index > 0) {
          router.back();
          return;
        }
      } catch {
        // 栈状态异常：按栈底处理，兜底去笔记库
      }
      void router.replaceUrl({ url: 'pages/NoteList' });
    } catch (err) {
      this.notice = `删除失败：${String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  private async doSave(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!this.isDirty()) {
      this.notice = '没有需要保存的改动。';
      return;
    }
    // 真机验收 Q3：保存成功（新建与编辑）一律返回列表——列表按更新时间倒序，
    // 本次保存的笔记在最上面。编辑页入口只来自列表页/阅读页，back 落点必然合理。
    this.busy = true;
    const ok: boolean = await this.saveOnce();
    this.busy = false;
    if (ok) {
      router.back();
    }
  }

  /**
   * 插入图片：先保证笔记已落库（新建时先保存取得 id），再走附件导入
   * （文件先落地、引用后提交 —— 顺序与失败语义全部在 NoteService.importImage）。
   */
  private async insertImage(img: ImportedImage | undefined): Promise<void> {
    if (img === undefined) {
      this.notice = '没有可插入的图片。';
      return;
    }
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined || this.busy) {
      return;
    }
    this.busy = true;
    try {
      if (this.noteId.length === 0) {
        const created: boolean = await this.saveOnce();
        if (!created) {
          return;
        }
      }
      const res = await svc.importImage(this.noteId, img.bytes, img.mime);
      const sep: string = this.bodyText.endsWith('\n\n') ? '' : (this.bodyText.endsWith('\n') ? '\n' : '\n\n');
      this.bodyText = this.bodyText + sep + res.markdownSnippet + '\n';
      this.notice = res.deduped
        ? '图片已在附件库（相同内容不重复入库，已引用）。'
        : '图片已入附件库并插入引用。';
    } catch (err) {
      // 失败如实展示（权限/空文件/超上限都可能），不静默吞掉
      this.notice = `图片导入失败：${String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  private onPickImage(): void {
    pickImageFromGallery()
      .then((img: ImportedImage | undefined) => {
        this.insertImage(img);
      })
      .catch((err: Error) => {
        this.notice = `选择图片失败：${String(err)}`;
      });
  }

  private onPasteImage(): void {
    readImageFromPasteboard()
      .then((img: ImportedImage) => {
        this.insertImage(img);
      })
      .catch((err: Error) => {
        // API 12 起未授权读取可能报 201；如实展示，不自动重试（拒绝后不得反复打扰）
        this.notice = `读取剪贴板图片失败，未插入任何内容。原因：${String(err)}`;
      });
  }

  build() {
    Column({ space: 10 }) {
      Row() {
        Text('‹ 返回')
          .fontSize(15)
          .fontColor('#1F6FEB')
          .onClick(() => {
            this.backAndSave();
          })
        Text(this.noteId.length === 0 ? '新建笔记' : '编辑笔记')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        if (this.noteId.length > 0) {
          Text('删除')
            .fontSize(15)
            .fontColor('#D4380D')
            .margin({ right: 10 })
            .onClick(() => {
              this.confirmDelete();
            })
        }
        Toggle({ type: ToggleType.Switch, isOn: this.pinned })
          .onChange((isOn: boolean) => {
            this.pinned = isOn;
          })
      }
      .width('100%')

      TextInput({ placeholder: '标题（留空则取正文首行）', text: this.titleText })
        .fontSize(15)
        .onChange((value: string) => {
          this.titleText = value;
        })

      TextInput({ placeholder: '标签（逗号分隔）', text: this.tagText })
        .fontSize(13)
        .onChange((value: string) => {
          this.tagText = value;
        })

      Row({ space: 8 }) {
        Button('选图')
          .fontSize(13)
          .height(32)
          .layoutWeight(1)
          .onClick(() => {
            this.onPickImage();
          })
        Button('粘贴图片')
          .fontSize(13)
          .height(32)
          .layoutWeight(1)
          .onClick(() => {
            this.onPasteImage();
          })
        Button('保存')
          .fontSize(13)
          .height(32)
          .layoutWeight(1)
          .onClick(() => {
            this.doSave();
          })
      }
      .width('100%')

      // 能力边界如实展示：粘贴图片依赖剪贴板读取授权（API 12 起默认每次询问，可能弹窗/拒绝）
      Text('图片以附件库引用（内容寻址，不重复占空间）；粘贴图片需要剪贴板读取授权。')
        .fontSize(11)
        .fontColor('#8C8C8C')
        .width('100%')

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(13)
          .fontColor('#1F6FEB')
          .width('100%')
      }

      TextArea({ placeholder: '正文（Markdown，可直接编辑 attachment:// 引用）', text: this.bodyText })
        .fontSize(14)
        .layoutWeight(1)
        .width('100%')
        .onChange((value: string) => {
          this.bodyText = value;
        })
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
