/**
 * 笔记仓储（设计 §4.2）。
 *
 * 事务边界口径：
 *  - 每个公开方法是**自包含**的（单条 SQL 或读写一簇），不隐式开事务；
 *  - 需要"附件引用 + 笔记更新"等多写原子性时，由调用方用 `transact` 包裹、
 *    把同一执行器传下来（IRdbExecutor 事务是连接级的，方法间天然同事务）。
 *
 * revision 口径（设计 §4.8 同步预留）：任何会改变同步语义状态的修改
 * （正文 / 标题 / 置顶 / 删除 / 恢复）都递增 revision 并刷新 updated_at。
 *
 * 并发写入口径（S4-3 安全审计）：正文/标题更新接受可选 expectedRevision，
 * 提供方在事务内先校验 revision 再写入，不匹配即抛 NoteConflictError ——
 * 并发写入冲突必须**如实报错**，不得静默互相覆盖（负向用例口径）。
 */

/** 并发写入冲突：调用方持有的 revision 与库内现状不符（或笔记已被删除） */
export class NoteConflictError extends Error {
  constructor(
    readonly noteId: NoteId,
    readonly expectedRevision: number,
    readonly actualRevision: number | undefined,
  ) {
    super(
      `NoteRepository: concurrent modification of note ${noteId} ` +
        `(expected revision ${expectedRevision}, actual ${actualRevision === undefined ? 'deleted' : actualRevision})`,
    );
    this.name = 'NoteConflictError';
  }
}

import { CONTENT_SCHEMA_VERSION, Note, NoteId, NoteSource, Tag } from '../model';
import { IClock, ILogger, IRandom } from '../ports';
import { uuidv7 } from '../id';
import {
  IRdbExecutor,
  SqlRow,
  nullify,
  optNumber,
  optString,
  reqNumber,
  reqString,
  transact,
} from './rdb';

export const DEFAULT_CONTENT_TYPE: string = 'text/markdown';

export interface NoteCreateInput {
  readonly title: string;
  readonly contentMd: string;
  /** 缺省 text/markdown */
  readonly contentType?: string;
  readonly source: NoteSource;
  /** 幂等来源摘要（分享/剪贴板转存）；可为空 */
  readonly originHash?: string;
}

export interface NoteRepoDeps {
  readonly db: IRdbExecutor;
  readonly clock: IClock;
  readonly random: IRandom;
  readonly logger: ILogger;
}

const NOTE_COLUMNS: string =
  'id, title, content_md, content_type, source, origin_hash, revision, ' +
  'content_schema_version, pinned, created_at, updated_at, deleted_at';

export class NoteRepository {
  constructor(private readonly deps: NoteRepoDeps) {}

  async create(input: NoteCreateInput): Promise<Note> {
    const now: number = this.deps.clock.nowMs();
    const note: Note = {
      id: uuidv7(this.deps.clock, this.deps.random),
      title: input.title,
      contentMd: input.contentMd,
      contentType: input.contentType === undefined ? DEFAULT_CONTENT_TYPE : input.contentType,
      source: input.source,
      originHash: input.originHash,
      revision: 1,
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      pinned: false,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.deps.db.execute(
      `INSERT INTO note (${NOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.title,
        note.contentMd,
        note.contentType,
        note.source,
        nullify(note.originHash),
        note.revision,
        note.contentSchemaVersion,
        0,
        note.createdAtMs,
        note.updatedAtMs,
        null,
      ],
    );
    return note;
  }

  /** 默认排除软删除；includeDeleted=true 时可取到回收站条目 */
  async getById(id: NoteId, includeDeleted?: boolean): Promise<Note | undefined> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT ${NOTE_COLUMNS} FROM note WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) {
      return undefined;
    }
    const note: Note = rowToNote(rows[0]);
    const withDeleted: boolean = includeDeleted === true;
    if (note.deletedAtMs !== undefined && !withDeleted) {
      return undefined;
    }
    return note;
  }

  /**
   * 更新正文（与可选的内容类型）；revision + 1。
   * 传入 expectedRevision 时启用乐观并发校验（S4-3）：库内 revision 不符即抛
   * NoteConflictError，绝不静默覆盖并发写入。校验与写入在同一事务内完成。
   */
  async updateContent(
    id: NoteId,
    contentMd: string,
    contentType?: string,
    expectedRevision?: number,
  ): Promise<Note> {
    if (expectedRevision !== undefined) {
      return this.updateWithConcurrencyCheck(id, expectedRevision, async (existing) => {
        const now: number = this.deps.clock.nowMs();
        await this.deps.db.execute(
          `UPDATE note SET content_md = ?, content_type = ?, revision = ?, updated_at = ? WHERE id = ?`,
          [contentMd, contentType === undefined ? existing.contentType : contentType, existing.revision + 1, now, id],
        );
      });
    }
    const existing: Note = await this.requireLive(id);
    const now: number = this.deps.clock.nowMs();
    await this.deps.db.execute(
      `UPDATE note SET content_md = ?, content_type = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [
        contentMd,
        contentType === undefined ? existing.contentType : contentType,
        existing.revision + 1,
        now,
        id,
      ],
    );
    return this.requireLive(id);
  }

  async rename(id: NoteId, title: string): Promise<Note> {
    const existing: Note = await this.requireLive(id);
    const now: number = this.deps.clock.nowMs();
    await this.deps.db.execute(
      `UPDATE note SET title = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [title, existing.revision + 1, now, id],
    );
    return this.requireLive(id);
  }

  /**
   * 编辑页一次性保存（标题 + 正文）：一次保存 = 一次同步语义修改，revision 只 + 1（设计 §4.8）。
   * 传入 expectedRevision 时启用乐观并发校验（S4-3）：冲突抛 NoteConflictError。
   */
  async update(id: NoteId, title: string, contentMd: string, expectedRevision?: number): Promise<Note> {
    if (expectedRevision !== undefined) {
      return this.updateWithConcurrencyCheck(id, expectedRevision, async (existing) => {
        const now: number = this.deps.clock.nowMs();
        await this.deps.db.execute(
          `UPDATE note SET title = ?, content_md = ?, revision = ?, updated_at = ? WHERE id = ?`,
          [title, contentMd, existing.revision + 1, now, id],
        );
      });
    }
    const existing: Note = await this.requireLive(id);
    const now: number = this.deps.clock.nowMs();
    await this.deps.db.execute(
      `UPDATE note SET title = ?, content_md = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [title, contentMd, existing.revision + 1, now, id],
    );
    return this.requireLive(id);
  }

  /**
   * 乐观并发校验 + 写入（共享事务壳）：先读 revision，不匹配立即抛错（事务回滚，无写入发生）；
   * 匹配才执行写入并提交。真实并发下第二个写者会在读阶段看到新 revision 而被拒。
   */
  private async updateWithConcurrencyCheck(
    id: NoteId,
    expectedRevision: number,
    apply: (existing: Note) => Promise<void>,
  ): Promise<Note> {
    return transact(this.deps.db, async () => {
      const existing: Note | undefined = await this.getById(id);
      if (existing === undefined || existing.revision !== expectedRevision) {
        throw new NoteConflictError(id, expectedRevision, existing?.revision);
      }
      await apply(existing);
      return this.requireLive(id);
    });
  }

  async setPinned(id: NoteId, pinned: boolean): Promise<Note> {
    const existing: Note = await this.requireLive(id);
    const now: number = this.deps.clock.nowMs();
    await this.deps.db.execute(
      `UPDATE note SET pinned = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [pinned ? 1 : 0, existing.revision + 1, now, id],
    );
    return this.requireLive(id);
  }

  /** 软删除：进回收站，不物理删除（设计 §4.2 删除协议：先解除引用，回收另见 BlobRepository） */
  async softDelete(id: NoteId): Promise<Note> {
    const existing: Note = await this.requireLive(id);
    const now: number = this.deps.clock.nowMs();
    await this.deps.db.execute(
      `UPDATE note SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [now, existing.revision + 1, now, id],
    );
    return (await this.getById(id, true)) as Note;
  }

  /** 从回收站恢复 */
  async restore(id: NoteId): Promise<Note> {
    const existing = await this.getById(id, true);
    if (existing === undefined || existing.deletedAtMs === undefined) {
      throw new Error(`NoteRepository.restore: note ${id} not in trash`);
    }
    const now: number = this.deps.clock.nowMs();
    await this.deps.db.execute(
      `UPDATE note SET deleted_at = NULL, revision = ?, updated_at = ? WHERE id = ?`,
      [existing.revision + 1, now, id],
    );
    return this.requireLive(id);
  }

  /** 列表页主路径：未删除；置顶优先，其余按更新时间倒序；分页由 LIMIT/OFFSET 约束 */
  async listRecent(limit: number, offset?: number): Promise<Note[]> {
    return this.queryNotes(
      `SELECT ${NOTE_COLUMNS} FROM note WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset === undefined ? 0 : offset],
    );
  }

  /**
   * 持久化去重查询（真机验收 Q4）：取时间窗内同来源摘要的未删除笔记（最新一篇）。
   * 已软删（回收站）的笔记不参与去重 —— 用户删了再采集同内容，应得到新条目。
   */
  async findByOriginHashSince(originHash: string, sinceMs: number): Promise<Note | undefined> {
    const notes: Note[] = await this.queryNotes(
      `SELECT ${NOTE_COLUMNS} FROM note
       WHERE origin_hash = ? AND deleted_at IS NULL AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [originHash, sinceMs],
    );
    if (notes.length === 0) {
      return undefined;
    }
    return notes[0];
  }

  /**
   * 持久化去重查询（真机验收 Q4）：取时间窗内创建的未删除笔记（按创建时间升序）。
   * 窗口（默认 2 日）内笔记规模天然有界，LIMIT 仅作兜底；调用方在内存中
   * 做内容比对/分组（保存去重与周期清理共用）。
   */
  async listCreatedSince(sinceMs: number, limit: number): Promise<Note[]> {
    return this.queryNotes(
      `SELECT ${NOTE_COLUMNS} FROM note
       WHERE deleted_at IS NULL AND created_at >= ?
       ORDER BY created_at ASC LIMIT ?`,
      [sinceMs, limit],
    );
  }

  /** 回收站列表（搜索结果与备份快照须排除 —— 调用方责任） */
  async listDeleted(limit: number, offset?: number): Promise<Note[]> {
    return this.queryNotes(
      `SELECT ${NOTE_COLUMNS} FROM note WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?`,
      [limit, offset === undefined ? 0 : offset],
    );
  }

  // ---------------------------------------------------------------------------
  // 标签
  // ---------------------------------------------------------------------------

  /** 绑定标签（幂等）：标签不存在则创建；重复绑定不产生第二条关系 */
  async addTag(noteId: NoteId, name: string): Promise<Tag> {
    const trimmed: string = name.trim();
    if (trimmed.length === 0) {
      throw new Error('NoteRepository.addTag: empty tag name');
    }
    await this.requireLive(noteId);
    let tag: Tag | undefined = await this.findTagByName(trimmed);
    if (tag === undefined) {
      const candidate: Tag = { id: uuidv7(this.deps.clock, this.deps.random), name: trimmed };
      await this.deps.db.execute(`INSERT OR IGNORE INTO tag (id, name) VALUES (?, ?)`, [
        candidate.id,
        candidate.name,
      ]);
      // 并发插入时以 UNIQUE 约束兜底，重读拿到最终行
      tag = (await this.findTagByName(trimmed)) as Tag;
    }
    await this.deps.db.execute(
      `INSERT OR IGNORE INTO note_tag (note_id, tag_id) VALUES (?, ?)`,
      [noteId, tag.id],
    );
    return tag;
  }

  async removeTag(noteId: NoteId, name: string): Promise<void> {
    await this.deps.db.execute(
      `DELETE FROM note_tag
       WHERE note_id = ? AND tag_id IN (SELECT id FROM tag WHERE name = ?)`,
      [noteId, name.trim()],
    );
  }

  async listTagsOfNote(noteId: NoteId): Promise<Tag[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT t.id, t.name FROM tag t
       JOIN note_tag nt ON nt.tag_id = t.id
       WHERE nt.note_id = ? ORDER BY t.name`,
      [noteId],
    );
    const tags: Tag[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      tags.push({ id: reqString(rows[i], 'id'), name: reqString(rows[i], 'name') });
    }
    return tags;
  }

  async listAllTags(): Promise<Tag[]> {
    const rows: SqlRow[] = await this.deps.db.query(`SELECT id, name FROM tag ORDER BY name`);
    const tags: Tag[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      tags.push({ id: reqString(rows[i], 'id'), name: reqString(rows[i], 'name') });
    }
    return tags;
  }

  /** 按标签筛选笔记（搜索页标签筛选；同列表排序口径：置顶优先、更新时间倒序） */
  async listByTag(tagId: string, limit: number, offset?: number): Promise<Note[]> {
    return this.queryNotes(
      `SELECT ${NOTE_COLUMNS} FROM note
       WHERE deleted_at IS NULL AND id IN (SELECT note_id FROM note_tag WHERE tag_id = ?)
       ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
      [tagId, limit, offset === undefined ? 0 : offset],
    );
  }

  /** 收藏（置顶）筛选：同列表排序口径 */
  async listFavorites(limit: number, offset?: number): Promise<Note[]> {
    return this.queryNotes(
      `SELECT ${NOTE_COLUMNS} FROM note
       WHERE deleted_at IS NULL AND pinned = 1
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset === undefined ? 0 : offset],
    );
  }

  /**
   * 标签重命名（搜索页标签管理）。trim 后为空抛错；
   * 与既有标签重名由 name UNIQUE 约束兜底（抛错由调用方提示），不产生静默合并。
   */
  async renameTag(tagId: string, newName: string): Promise<Tag> {
    const trimmed: string = newName.trim();
    if (trimmed.length === 0) {
      throw new Error('NoteRepository.renameTag: empty tag name');
    }
    await this.deps.db.execute(`UPDATE tag SET name = ? WHERE id = ?`, [trimmed, tagId]);
    const rows: SqlRow[] = await this.deps.db.query(`SELECT id, name FROM tag WHERE id = ?`, [tagId]);
    if (rows.length === 0) {
      throw new Error(`NoteRepository.renameTag: tag ${tagId} not found`);
    }
    return { id: reqString(rows[0], 'id'), name: reqString(rows[0], 'name') };
  }

  // ---------------------------------------------------------------------------

  private async queryNotes(sql: string, params: (string | number | null)[]): Promise<Note[]> {
    const rows: SqlRow[] = await this.deps.db.query(sql, params);
    const notes: Note[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      notes.push(rowToNote(rows[i]));
    }
    return notes;
  }

  private async requireLive(id: NoteId): Promise<Note> {
    const note = await this.getById(id);
    if (note === undefined) {
      throw new Error(`NoteRepository: note ${id} not found or deleted`);
    }
    return note;
  }

  private async findTagByName(name: string): Promise<Tag | undefined> {
    const rows: SqlRow[] = await this.deps.db.query(`SELECT id, name FROM tag WHERE name = ?`, [name]);
    if (rows.length === 0) {
      return undefined;
    }
    return { id: reqString(rows[0], 'id'), name: reqString(rows[0], 'name') };
  }
}

function rowToNote(row: SqlRow): Note {
  const note: Note = {
    id: reqString(row, 'id'),
    title: reqString(row, 'title'),
    contentMd: reqString(row, 'content_md'),
    contentType: reqString(row, 'content_type'),
    source: reqString(row, 'source') as NoteSource,
    originHash: optString(row, 'origin_hash'),
    revision: reqNumber(row, 'revision'),
    contentSchemaVersion: reqNumber(row, 'content_schema_version'),
    pinned: reqNumber(row, 'pinned') === 1,
    createdAtMs: reqNumber(row, 'created_at'),
    updatedAtMs: reqNumber(row, 'updated_at'),
    deletedAtMs: optNumber(row, 'deleted_at'),
  };
  return note;
}
