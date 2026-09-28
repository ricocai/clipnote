/**
 * 备份快照与整库替换（S4-1；设计 §4.2「可恢复备份」）。
 *
 * 与 CRUD 仓储的分工：
 *  - NoteRepository / BlobRepository 面向在线业务（生成新 id、维护 revision）；
 *  - 本类面向**保真搬运**：snapshot 原样读出、replaceAll 原样写回（id/revision/时间戳
 *    全部保留，恢复后的库与备份时逐字段一致 —— 这是"恢复到空库并得到可核对结果"的前提）。
 *
 * 口径：
 *  - 快照**排除软删除笔记**及其独占的标签/附件引用（与 model.ts Note.deletedAtMs 注释一致）；
 *  - 收件箱（clipboard_item）不在备份范围（设计 §4.1：默认不进备份导出），replaceAll 不动它；
 *  - replaceAll 必须由调用方包裹在**单个事务**里（BackupService 负责），
 *    整库替换的原子性 = 这一个事务；
 *  - note_fts 是占位普通表（G7 未落 FTS5），replaceAll 从恢复的笔记直接重建，
 *    保证搜索索引与笔记域一致。
 */

import { BackupManifest } from '../backup';
import { AttachmentRole, BlobRecord, BlobStatus, Note, NoteAttachment, NoteSource, Tag } from '../model';
import { IRdbExecutor, SqlRow, SqlValue, nullify, optNumber, optString, reqNumber, reqString } from './rdb';

export interface NoteTagPair {
  readonly noteId: string;
  readonly tagId: string;
}

export interface BackupSnapshot {
  readonly notes: Note[];
  readonly tags: Tag[];
  readonly noteTags: NoteTagPair[];
  readonly blobs: BlobRecord[];
  readonly noteAttachments: NoteAttachment[];
}

const NOTE_COLUMNS: string =
  'id, title, content_md, content_type, source, origin_hash, revision, ' +
  'content_schema_version, pinned, created_at, updated_at, deleted_at';

export class BackupRepository {
  constructor(private readonly db: IRdbExecutor) {}

  /** 备份快照：活体笔记 + 其可达的标签/附件关系/blob 记录。不设 LIMIT —— 备份必须完整。 */
  async snapshot(): Promise<BackupSnapshot> {
    const notes: Note[] = [];
    const noteRows: SqlRow[] = await this.db.query(
      `SELECT ${NOTE_COLUMNS} FROM note WHERE deleted_at IS NULL ORDER BY created_at`,
    );
    for (let i: number = 0; i < noteRows.length; i++) {
      notes.push(rowToNote(noteRows[i]));
    }

    const tags: Tag[] = [];
    const tagRows: SqlRow[] = await this.db.query(
      `SELECT DISTINCT t.id, t.name FROM tag t
       JOIN note_tag nt ON nt.tag_id = t.id
       JOIN note n ON n.id = nt.note_id
       WHERE n.deleted_at IS NULL ORDER BY t.name`,
    );
    for (let i: number = 0; i < tagRows.length; i++) {
      tags.push({ id: reqString(tagRows[i], 'id'), name: reqString(tagRows[i], 'name') });
    }

    const noteTags: NoteTagPair[] = [];
    const pairRows: SqlRow[] = await this.db.query(
      `SELECT nt.note_id, nt.tag_id FROM note_tag nt
       JOIN note n ON n.id = nt.note_id
       WHERE n.deleted_at IS NULL ORDER BY nt.note_id, nt.tag_id`,
    );
    for (let i: number = 0; i < pairRows.length; i++) {
      noteTags.push({ noteId: reqString(pairRows[i], 'note_id'), tagId: reqString(pairRows[i], 'tag_id') });
    }

    const noteAttachments: NoteAttachment[] = [];
    const attRows: SqlRow[] = await this.db.query(
      `SELECT na.note_id, na.blob_sha256, na.role, na.ordinal FROM note_attachment na
       JOIN note n ON n.id = na.note_id
       WHERE n.deleted_at IS NULL ORDER BY na.note_id, na.ordinal`,
    );
    for (let i: number = 0; i < attRows.length; i++) {
      noteAttachments.push({
        noteId: reqString(attRows[i], 'note_id'),
        blobSha256: reqString(attRows[i], 'blob_sha256'),
        role: reqString(attRows[i], 'role') as AttachmentRole,
        ordinal: reqNumber(attRows[i], 'ordinal'),
      });
    }

    const blobs: BlobRecord[] = [];
    const blobRows: SqlRow[] = await this.db.query(
      `SELECT DISTINCT b.sha256, b.relative_path, b.mime, b.size, b.status FROM blob b
       JOIN note_attachment na ON na.blob_sha256 = b.sha256
       JOIN note n ON n.id = na.note_id
       WHERE n.deleted_at IS NULL ORDER BY b.sha256`,
    );
    for (let i: number = 0; i < blobRows.length; i++) {
      blobs.push(rowToBlob(blobRows[i]));
    }

    return { notes, tags, noteTags, blobs, noteAttachments };
  }

  /**
   * 整库替换笔记域（调用方事务内执行）。
   * 显式逐表 DELETE 而非依赖 ON DELETE CASCADE —— 行为不依赖连接的 FK pragma 状态。
   */
  async replaceAll(manifest: BackupManifest): Promise<void> {
    await this.db.execute(`DELETE FROM note_fts`);
    await this.db.execute(`DELETE FROM note_attachment`);
    await this.db.execute(`DELETE FROM note_tag`);
    await this.db.execute(`DELETE FROM note`);
    await this.db.execute(`DELETE FROM tag`);
    await this.db.execute(`DELETE FROM blob`);

    for (let i: number = 0; i < manifest.tags.length; i++) {
      const t: Tag = manifest.tags[i];
      await this.db.execute(`INSERT INTO tag (id, name) VALUES (?, ?)`, [t.id, t.name]);
    }
    for (let i: number = 0; i < manifest.notes.length; i++) {
      const n: Note = manifest.notes[i];
      const params: SqlValue[] = [
        n.id,
        n.title,
        n.contentMd,
        n.contentType,
        n.source,
        nullify(n.originHash),
        n.revision,
        n.contentSchemaVersion,
        n.pinned ? 1 : 0,
        n.createdAtMs,
        n.updatedAtMs,
        n.deletedAtMs === undefined ? null : n.deletedAtMs,
      ];
      await this.db.execute(`INSERT INTO note (${NOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params);
      // 占位搜索表与笔记域同步重建（schema.ts：G7 确认 FTS5 后由迁移替换）
      await this.db.execute(`INSERT INTO note_fts (note_id, title, content) VALUES (?, ?, ?)`, [
        n.id,
        n.title,
        n.contentMd,
      ]);
    }
    for (let i: number = 0; i < manifest.blobs.length; i++) {
      const b: BlobRecord = manifest.blobs[i];
      await this.db.execute(
        `INSERT INTO blob (sha256, relative_path, mime, size, status) VALUES (?, ?, ?, ?, ?)`,
        [b.sha256, b.relativePath, b.mime, b.size, b.status],
      );
    }
    for (let i: number = 0; i < manifest.noteTags.length; i++) {
      const p: NoteTagPair = manifest.noteTags[i];
      await this.db.execute(`INSERT INTO note_tag (note_id, tag_id) VALUES (?, ?)`, [p.noteId, p.tagId]);
    }
    for (let i: number = 0; i < manifest.noteAttachments.length; i++) {
      const a: NoteAttachment = manifest.noteAttachments[i];
      await this.db.execute(
        `INSERT INTO note_attachment (note_id, blob_sha256, role, ordinal) VALUES (?, ?, ?, ?)`,
        [a.noteId, a.blobSha256, a.role, a.ordinal],
      );
    }
  }
}

function rowToNote(row: SqlRow): Note {
  return {
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
}

function rowToBlob(row: SqlRow): BlobRecord {
  return {
    sha256: reqString(row, 'sha256'),
    relativePath: reqString(row, 'relative_path'),
    mime: reqString(row, 'mime'),
    size: reqNumber(row, 'size'),
    status: reqString(row, 'status') as BlobStatus,
  };
}
