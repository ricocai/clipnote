import { router } from '@kit.ArkUI';
import { CONTENT_TYPE_HTML, HighlightRange, Note, NoteSearchHit, NoteSearchOptions, NoteService, Tag, htmlToPlainText } from 'common';
import { AppServices } from '../services/AppServices';
import { flatPreview, relativeTimeLabel } from '../ui/Format';

/**
 * 搜索页（S3-4；设计 §4.7 中文检索落库 + 标签体系 + 收藏筛选，G7 验收）。
 *
 * 数据纪律（与 NoteList 同构，UI 只做渲染与转发）：
 *  - 检索走 NoteService.searchNotes：FTS5 trigram 主路径 + 1–2 字符 LIKE 兜底，
 *    范围排除回收站（数据层口径，UI 不重复过滤）；标题加权排序由数据层打分；
 *  - 高亮复用内核 Snippet/HighlightRange 原文偏移契约（common 导出），渲染层只做
 *    「偏移 → Span 样式」的转换，不自行分词；
 *  - 筛选：标签（tagId）/ 仅收藏（pinned）作为检索选项下传；查询为空时退化为
 *    列表口径（listByTag / listFavorites）；
 *  - 标签重命名作用于当前选中的标签（内联编辑，重名/空名由数据层抛错，UI 提示）。
 *  - 点行进阅读页（HTML 进受控展示页），与列表页口径一致。
 */

/** 单次检索/筛选加载上限（与领域层 NOTE_LIST_LIMIT 同口径） */
const SEARCH_PAGE_LIMIT: number = 200;

/** 片段渲染分段：高亮区间 → 带样式的 Span 片段 */
interface SpanSegment {
  readonly text: string;
  readonly highlight: boolean;
}

interface SearchRow {
  readonly id: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly contentType: string;
  readonly timeLabel: string;
  readonly snippetSegments: SpanSegment[];
}

@Entry
@Component
struct Search {
  @State query: string = '';
  @State rows: SearchRow[] = [];
  @State tags: Tag[] = [];
  @State activeTagId: string = '';
  @State favoritesOnly: boolean = false;
  @State renaming: boolean = false;
  @State renameInput: string = '';
  @State notice: string = '';
  @State dataReady: boolean = false;

  private readonly svc: AppServices = AppServices.get();
  private noteSvc: NoteService | undefined = undefined;

  aboutToAppear(): void {
    this.initData();
  }

  onPageShow(): void {
    // 从编辑页返回后标签可能已变（编辑页可加标签），刷新筛选栏与结果
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

  /** 标签栏始终全量刷新；结果按当前查询/筛选组合重查 */
  private async refresh(): Promise<void> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined) {
      return;
    }
    this.tags = await svc.listAllTags();
    if (this.activeTagId.length > 0 && !this.tags.some((t: Tag) => t.id === this.activeTagId)) {
      this.activeTagId = '';
    }
    await this.runSearch();
  }

  private async runSearch(): Promise<void> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined) {
      return;
    }
    const q: string = this.query.trim();
    try {
      let built: SearchRow[] = [];
      if (q.length > 0) {
        const options: NoteSearchOptions =
          this.activeTagId.length > 0
            ? { limit: SEARCH_PAGE_LIMIT, tagId: this.activeTagId, favoritesOnly: this.favoritesOnly }
            : { limit: SEARCH_PAGE_LIMIT, favoritesOnly: this.favoritesOnly };
        const hits: NoteSearchHit[] = await svc.searchNotes(q, options);
        built = hits.map((h: NoteSearchHit) => this.rowFromHit(h));
      } else if (this.activeTagId.length > 0) {
        const notes: Note[] = await svc.listByTag(this.activeTagId, SEARCH_PAGE_LIMIT);
        built = this.rowsFromNotes(notes);
      } else if (this.favoritesOnly) {
        const notes: Note[] = await svc.listFavorites(SEARCH_PAGE_LIMIT);
        built = this.rowsFromNotes(notes);
      }
      this.rows = built;
    } catch (err) {
      this.notice = `检索失败：${String(err)}`;
    }
  }

  private rowFromHit(hit: NoteSearchHit): SearchRow {
    return {
      id: hit.id,
      title: hit.title,
      pinned: false,
      contentType: hit.contentType,
      timeLabel: '',
      snippetSegments: segmentsOf(hit.snippet.text, hit.snippet.highlights),
    };
  }

  /** 空查询的列表口径：无高亮片段，取正文前 120 字做预览 */
  private rowsFromNotes(notes: Note[]): SearchRow[] {
    const built: SearchRow[] = [];
    for (let i: number = 0; i < notes.length; i++) {
      const n: Note = notes[i];
      const preview: string =
        n.contentType === CONTENT_TYPE_HTML ? flatPreview(htmlToPlainText(n.contentMd), 120) : flatPreview(n.contentMd, 120);
      built.push({
        id: n.id,
        title: n.title,
        pinned: n.pinned,
        contentType: n.contentType,
        timeLabel: relativeTimeLabel(n.updatedAtMs),
        snippetSegments: [{ text: preview, highlight: false }],
      });
    }
    return built;
  }

  private toggleTag(tag: Tag): void {
    this.activeTagId = this.activeTagId === tag.id ? '' : tag.id;
    this.renaming = false;
    this.runSearch();
  }

  private toggleFavorites(): void {
    this.favoritesOnly = !this.favoritesOnly;
    this.runSearch();
  }

  private startRename(): void {
    const tag: Tag | undefined = this.tags.find((t: Tag) => t.id === this.activeTagId);
    if (tag === undefined) {
      return;
    }
    this.renameInput = tag.name;
    this.renaming = true;
  }

  private async doRename(): Promise<void> {
    const svc: NoteService | undefined = this.noteSvc;
    if (svc === undefined || this.activeTagId.length === 0) {
      return;
    }
    try {
      await svc.renameTag(this.activeTagId, this.renameInput);
      this.renaming = false;
      this.notice = '标签已重命名。';
      await this.refresh();
    } catch (err) {
      this.notice = `重命名失败（重名或为空）：${String(err)}`;
    }
  }

  private openReader(id: string, contentType: string): void {
    const params: Record<string, string> = { 'noteId': id };
    const page: string = contentType === CONTENT_TYPE_HTML ? 'pages/HtmlRead' : 'pages/NoteRead';
    router.pushUrl({ url: page, params: params });
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
        Text('搜索')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text('')
          .width(48)
      }
      .width('100%')

      TextInput({ placeholder: '搜索笔记（支持中文短句，1–2 字也可以）', text: this.query })
        .width('100%')
        .onChange((value: string) => {
          this.query = value;
          this.runSearch();
        })

      Row({ space: 8 }) {
        Text(this.favoritesOnly ? '★ 仅收藏' : '☆ 仅收藏')
          .fontSize(13)
          .fontColor(this.favoritesOnly ? '#D4380D' : '#595959')
          .padding(6)
          .backgroundColor(this.favoritesOnly ? '#FFF1F0' : '#F5F5F5')
          .borderRadius(8)
          .onClick(() => {
            this.toggleFavorites();
          })
        if (this.activeTagId.length > 0) {
          Text('重命名标签')
            .fontSize(13)
            .fontColor('#1F6FEB')
            .padding(6)
            .backgroundColor('#F5F5F5')
            .borderRadius(8)
            .onClick(() => {
              this.startRename();
            })
        }
      }
      .width('100%')

      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(this.tags, (tag: Tag) => {
          Text(tag.name)
            .fontSize(12)
            .fontColor(this.activeTagId === tag.id ? '#FFFFFF' : '#595959')
            .padding({ left: 10, right: 10, top: 5, bottom: 5 })
            .margin({ right: 6, bottom: 6 })
            .backgroundColor(this.activeTagId === tag.id ? '#1F6FEB' : '#F5F5F5')
            .borderRadius(10)
            .onClick(() => {
              this.toggleTag(tag);
            })
        }, (tag: Tag) => tag.id)
      }
      .width('100%')

      if (this.renaming) {
        Row({ space: 8 }) {
          TextInput({ placeholder: '标签新名称', text: this.renameInput })
            .layoutWeight(1)
            .onChange((value: string) => {
              this.renameInput = value;
            })
          Button('保存')
            .fontSize(13)
            .height(36)
            .onClick(() => {
              this.doRename();
            })
          Button('取消')
            .fontSize(13)
            .height(36)
            .backgroundColor('#F5F5F5')
            .fontColor('#333333')
            .onClick(() => {
              this.renaming = false;
            })
        }
        .width('100%')
      }

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
      } else if (this.query.trim().length === 0 && this.activeTagId.length === 0 && !this.favoritesOnly) {
        Text('输入关键词搜索；或点下方标签筛选，点「☆ 仅收藏」只看收藏。')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else if (this.rows.length === 0) {
        Text('没有匹配的笔记。')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else {
        List({ space: 8 }) {
          ForEach(this.rows, (row: SearchRow) => {
            ListItem() {
              Column({ space: 4 }) {
                Text(`${row.pinned ? '📌 ' : ''}${row.title}`)
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Text() {
                  ForEach(row.snippetSegments, (seg: SpanSegment, index: number) => {
                    Span(seg.text)
                      .fontSize(13)
                      .fontColor(seg.highlight ? '#D4380D' : '#595959')
                  }, (seg: SpanSegment, index: number) => `${index}-${seg.highlight ? 'h' : 'n'}`)
                }
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                if (row.timeLabel.length > 0) {
                  Text(row.timeLabel)
                    .fontSize(11)
                    .fontColor('#8C8C8C')
                }
              }
              .alignItems(HorizontalAlign.Start)
              .width('100%')
              .padding(10)
              .backgroundColor('#F5F5F5')
              .borderRadius(8)
            }
            .onClick(() => {
              this.openReader(row.id, row.contentType);
            })
          }, (row: SearchRow) => row.id)
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

/** Snippet + 高亮区间 → 渲染分段（纯转换，不做任何分词） */
function segmentsOf(text: string, highlights: readonly HighlightRange[]): SpanSegment[] {
  if (highlights.length === 0) {
    return [{ text: text, highlight: false }];
  }
  const sorted: HighlightRange[] = highlights.slice().sort((a: HighlightRange, b: HighlightRange) => a.start - b.start);
  const out: SpanSegment[] = [];
  let cursor: number = 0;
  for (let i: number = 0; i < sorted.length; i++) {
    const r: HighlightRange = sorted[i];
    const start: number = Math.max(0, Math.min(text.length, r.start));
    const end: number = Math.max(start, Math.min(text.length, r.end));
    if (start > cursor) {
      out.push({ text: text.slice(cursor, start), highlight: false });
    }
    if (end > start) {
      out.push({ text: text.slice(start, end), highlight: true });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), highlight: false });
  }
  return out;
}
