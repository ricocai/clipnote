/**
 * 笔记服务（S3-1；设计 §4.1 / §4.2 / §4.3 的端到端落地）。
 *
 * 职责边界（与 InboxService 同构：UI 只做渲染与转发）：
 *  - 新建 / 编辑保存（标题 + 正文一次提交，一次 revision 递增，设计 §4.8 修订口径）；
 *  - 删除走回收站语义（软删除，设计 §4.2 删除协议）与恢复、置顶（收藏）；
 *  - 标签按"目标集合"同步（add/remove 差量，UI 只需给出最终标签列表）；
 *  - 图片附件：字节 → BlobCas 原子写入（文件先落地）→ 同一事务提交
 *    blob 记录 + note_attachment 引用（引用后提交）。崩溃最坏结果是孤儿文件，
 *    绝不产生"DB 已提交引用、文件却不存在"（设计 §4.2 附件写入与恢复协议）。
 *
 * 引用格式：`attachment://<sha256>`（markdown.ts 的单一协议，渲染/导出共用）。
 */

import { AttachmentRole, BlobRecord, BlobSha256, BlobStatus, Note, NoteAttachment, NoteId, NoteSource, PERSISTED_DEDUPE_WINDOW_MS, Tag } from './model';
import { IClock, IHasher, ILogger, LogLevel } from './ports';
import { BlobCas } from './blob-cas';
import { IRdbExecutor, transact } from './data/rdb';
import { NoteRepository } from './data/note-repository';
import { SearchRepository, NoteSearchHit, NoteSearchOptions } from './data/search-repository';
import { BlobRepository } from './data/blob-repository';
import { deriveTitle } from './inbox';
import { ATTACHMENT_SCHEME } from './markdown';

/** 列表页单次加载上限（设计 §8 性能口径：不一次载入全库，分页由 LIMIT 约束） */
export const NOTE_LIST_LIMIT: number = 200;

/** 保存去重窗口扫描上限（Q4）：2 日窗口内笔记数的宽松上限，超出部分不参与当次比对 */
export const NOTE_DEDUPE_SCAN_LIMIT: number = 500;

/** 单篇笔记的图片附件数量上限（防误粘贴刷屏；超限给出明确提示而不是静默丢弃） */
export const MAX_IMAGE_ATTACHMENTS_PER_NOTE: number = 50;

/**
 * 单个图片附件的字节上限（S4-3 安全审计整改）：与分享接收闸门同一口径
 * （share.ts DEFAULT_MAX_SHARE_FILE_BYTES = 32MB，设计 §4.1/§4.5.5「校验大小与类型」）。
 * 超限在入 CAS 之前拒绝，避免巨型字节流落盘。
 */
export const MAX_IMAGE_ATTACHMENT_BYTES: number = 32 * 1024 * 1024;

export interface NoteServiceDeps {
  readonly db: IRdbExecutor;
  readonly notes: NoteRepository;
  readonly search: SearchRepository;
  readonly blobs: BlobRepository;
  readonly blobCas: BlobCas;
  readonly hasher: IHasher;
  readonly clock: IClock;
  readonly logger: ILogger;
}

/** 编辑页保存入参；id 为空表示新建 */
export interface NoteSaveInput {
  readonly id?: NoteId;
  readonly title: string;
  readonly contentMd: string;
}

export interface ImageImportResult {
  readonly sha256: BlobSha256;
  /** 已写入正文引用的 markdown 片段：`![alt](attachment://<sha256>)` */
  readonly markdownSnippet: string;
  /** 该图片此前已在附件库且已被本篇引用（幂等命中，未产生新的写入） */
  readonly deduped: boolean;
}

export class NoteService {
  constructor(private readonly deps: NoteServiceDeps) {}

  /**
   * 保存：无 id 新建（标题为空时取首行作标题，全空给兜底名），
   * 有 id 则一次更新标题 + 正文（revision 只 + 1，见 NoteRepository.update）。
   *
   * 真机验收 Q4（保存去重）：新建时若最近 2 日（PERSISTED_DEDUPE_WINDOW_MS）内已存在
   * **正文完全相同**的活体笔记，幂等返回该笔记而不新建——重复输入/重复保存不产生第二条。
   * 比对口径为正文精确相等（可预期、可解释；空白差异即视为不同内容）。
   * 编辑既有笔记（有 id）不参与去重。
   */
  async save(input: NoteSaveInput): Promise<Note> {
    const trimmed: string = input.title.trim();
    const title: string = trimmed.length > 0 ? trimmed : deriveTitle(input.contentMd);
    if (input.id === undefined) {
      const dup: Note | undefined = await this.findRecentDuplicate(input.contentMd);
      if (dup !== undefined) {
        this.deps.logger.log(LogLevel.INFO, 'note_save_deduped', {
          existingId: dup.id, windowDays: 2,
        });
        return dup;
      }
      const note: Note = await this.deps.notes.create({
        title,
        contentMd: input.contentMd,
        source: NoteSource.MANUAL,
      });
      this.deps.logger.log(LogLevel.INFO, 'note_created', { id: note.id, source: note.source });
      return note;
    }
    const note: Note = await this.deps.notes.update(input.id, title, input.contentMd);
    this.deps.logger.log(LogLevel.INFO, 'note_saved', { id: note.id, revision: note.revision });
    return note;
  }

  /** Q4 保存去重：2 日窗口内按正文精确相等找活体重复（含收件箱转存的笔记） */
  private async findRecentDuplicate(contentMd: string): Promise<Note | undefined> {
    const sinceMs: number = this.deps.clock.nowMs() - PERSISTED_DEDUPE_WINDOW_MS;
    const recent: Note[] = await this.deps.notes.listCreatedSince(sinceMs, NOTE_DEDUPE_SCAN_LIMIT);
    for (let i: number = 0; i < recent.length; i++) {
      if (recent[i].contentMd === contentMd) {
        return recent[i];
      }
    }
    return undefined;
  }

  /** 置顶（收藏）；收藏 = 置顶，同一 pinned 字段（模型无独立收藏列，首期口径） */
  async setPinned(id: NoteId, pinned: boolean): Promise<Note> {
    const note: Note = await this.deps.notes.setPinned(id, pinned);
    this.deps.logger.log(LogLevel.INFO, 'note_pinned', { id, pinned });
    return note;
  }

  /** 删除 = 移入回收站（软删除，不物理删除，设计 §4.2 删除协议） */
  async moveToTrash(id: NoteId): Promise<Note> {
    const note: Note = await this.deps.notes.softDelete(id);
    this.deps.logger.log(LogLevel.INFO, 'note_moved_to_trash', { id });
    return note;
  }

  /** 从回收站恢复 */
  async restore(id: NoteId): Promise<Note> {
    return this.deps.notes.restore(id);
  }

  /** 按目标集合同步标签：trim、去重、去空；差量绑定/解绑（addTag 本身幂等） */
  async setTags(noteId: NoteId, names: readonly string[]): Promise<Tag[]> {
    const desired: string[] = [];
    const seen: Set<string> = new Set<string>();
    for (let i: number = 0; i < names.length; i++) {
      const name: string = names[i].trim();
      if (name.length === 0 || seen.has(name)) {
        continue;
      }
      seen.add(name);
      desired.push(name);
    }
    const current: Tag[] = await this.deps.notes.listTagsOfNote(noteId);
    const currentNames: Set<string> = new Set<string>();
    for (let i: number = 0; i < current.length; i++) {
      currentNames.add(current[i].name);
    }
    for (let i: number = 0; i < desired.length; i++) {
      if (!currentNames.has(desired[i])) {
        await this.deps.notes.addTag(noteId, desired[i]);
      }
    }
    for (let i: number = 0; i < current.length; i++) {
      if (!seen.has(current[i].name)) {
        await this.deps.notes.removeTag(noteId, current[i].name);
      }
    }
    return this.deps.notes.listTagsOfNote(noteId);
  }

  async listTagsOfNote(noteId: NoteId): Promise<Tag[]> {
    return this.deps.notes.listTagsOfNote(noteId);
  }

  /** 全部标签（搜索页筛选栏 / 标签管理） */
  async listAllTags(): Promise<Tag[]> {
    return this.deps.notes.listAllTags();
  }

  /** 标签重命名（搜索页标签管理入口） */
  async renameTag(tagId: string, newName: string): Promise<Tag> {
    return this.deps.notes.renameTag(tagId, newName);
  }

  /** 按标签筛选笔记（搜索页标签筛选；与列表同排序口径） */
  async listByTag(tagId: string, limit: number, offset?: number): Promise<Note[]> {
    return this.deps.notes.listByTag(tagId, limit, offset);
  }

  /** 收藏（置顶）筛选 */
  async listFavorites(limit: number, offset?: number): Promise<Note[]> {
    return this.deps.notes.listFavorites(limit, offset);
  }

  /**
   * 中文全文检索（S3-4 / G7）：FTS5 trigram 主路径 + 短查询 LIKE 兜底，
   * 排除回收站，可选标签 / 收藏筛选。语义与排序口径见 SearchRepository。
   */
  async searchNotes(query: string, options?: NoteSearchOptions): Promise<NoteSearchHit[]> {
    return this.deps.search.search(query, options);
  }

  async getById(id: NoteId): Promise<Note | undefined> {
    return this.deps.notes.getById(id);
  }

  /** 列表页主查询：未删除，置顶优先、更新时间倒序 */
  async listRecent(limit: number, offset?: number): Promise<Note[]> {
    return this.deps.notes.listRecent(limit, offset);
  }

  async listAttachmentsOf(noteId: NoteId): Promise<NoteAttachment[]> {
    return this.deps.blobs.listAttachmentsOf(noteId);
  }

  /**
   * 阅读页渲染用读模型：本篇 INLINE_IMAGE 附件 + 登记 MIME（onInterceptRequest
   * 响应头的事实源；MIME 来自入库登记，不做嗅探）。记录缺失的附件跳过并记日志，
   * 由 G5 恢复扫描兜底完整性口径。
   */
  async listRenderableImages(noteId: NoteId): Promise<Array<{ sha256: BlobSha256; mime: string }>> {
    const attachments: NoteAttachment[] = await this.deps.blobs.listAttachmentsOf(noteId);
    const out: Array<{ sha256: BlobSha256; mime: string }> = [];
    for (let i: number = 0; i < attachments.length; i++) {
      const a: NoteAttachment = attachments[i];
      if (a.role !== AttachmentRole.INLINE_IMAGE) {
        continue;
      }
      const record: BlobRecord | undefined = await this.deps.blobs.get(a.blobSha256);
      if (record === undefined) {
        this.deps.logger.log(LogLevel.WARN, 'note_renderable_image_missing_record', { noteId, sha256: a.blobSha256 });
        continue;
      }
      out.push({ sha256: a.blobSha256, mime: record.mime });
    }
    return out;
  }

  /**
   * 图片入附件库：字节经内容寻址原子落盘，然后在**同一事务**里提交
   * blob 记录与 note_attachment 引用（设计 §4.2 写入顺序：文件先落地、引用后提交）。
   * 返回的 markdownSnippet 由调用方插入正文（attachment:// 单一引用协议）。
   *
   * 幂等：同字节重复导入命中既有 blob 文件（deduped）不重复写文件；
   * 本篇已引用同一 blob 时连引用也不再写（引用行主键 (note_id, blob_sha256, role)，
   * 重写会把已有引用的 ordinal 挪到尾部，破坏渲染顺序 —— 故直接返回）。
   */
  async importImage(noteId: NoteId, bytes: Uint8Array, mime: string, alt?: string): Promise<ImageImportResult> {
    if (bytes.length === 0) {
      throw new Error('NoteService.importImage: empty image bytes');
    }
    if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES) {
      // 与分享接收同一口径：超限在入 CAS 之前拒绝，不留任何落盘副作用
      throw new Error(
        `NoteService.importImage: image too large (${bytes.length} bytes > ${MAX_IMAGE_ATTACHMENT_BYTES})`,
      );
    }
    // 对回收站/不存在的笔记直接拒绝，避免给已删除笔记挂新引用
    const live: Note | undefined = await this.deps.notes.getById(noteId);
    if (live === undefined) {
      throw new Error(`NoteService.importImage: note ${noteId} not found or deleted`);
    }
    const sha: string = await this.deps.hasher.sha256HexBytes(bytes);
    const existing: NoteAttachment[] = await this.deps.blobs.listAttachmentsOf(noteId);
    let imageCount: number = 0;
    let alreadyAttached: boolean = false;
    let maxOrdinal: number = -1;
    for (let i: number = 0; i < existing.length; i++) {
      const a: NoteAttachment = existing[i];
      if (a.ordinal > maxOrdinal) {
        maxOrdinal = a.ordinal;
      }
      if (a.role === AttachmentRole.INLINE_IMAGE) {
        imageCount++;
        if (a.blobSha256 === sha) {
          alreadyAttached = true;
        }
      }
    }
    if (alreadyAttached) {
      // 引用与 blob 记录此前已原子提交，无需第二次写入
      return {
        sha256: sha,
        markdownSnippet: this.snippetFor(sha, alt),
        deduped: true,
      };
    }
    if (imageCount >= MAX_IMAGE_ATTACHMENTS_PER_NOTE) {
      throw new Error(`NoteService.importImage: image attachments exceed limit ${MAX_IMAGE_ATTACHMENTS_PER_NOTE}`);
    }

    // 第一步：文件先落地（临时写入 → 校验 → 原子改名；失败则没有任何 DB 副作用）
    const put = await this.deps.blobCas.putBytes(bytes);

    // 第二步：引用后提交。事务内任一失败整体回滚 —— 绝不出现悬空引用。
    await transact(this.deps.db, async () => {
      await this.deps.blobs.saveRecord({
        sha256: put.sha256,
        relativePath: put.relativePath,
        mime,
        size: put.size,
        status: BlobStatus.REFERENCED,
      });
      await this.deps.blobs.attach(noteId, put.sha256, AttachmentRole.INLINE_IMAGE, maxOrdinal + 1);
    });

    this.deps.logger.log(LogLevel.INFO, 'note_image_imported', {
      noteId,
      sha256: put.sha256,
      size: put.size,
      deduped: put.deduped,
    });
    return {
      sha256: put.sha256,
      markdownSnippet: this.snippetFor(put.sha256, alt),
      deduped: put.deduped,
    };
  }

  private snippetFor(sha: string, alt?: string): string {
    const altText: string = alt === undefined || alt.trim().length === 0 ? '图片' : alt.trim();
    return `![${altText}](${ATTACHMENT_SCHEME}${sha})`;
  }
}
