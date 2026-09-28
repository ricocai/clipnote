/**
 * 附件仓储（设计 §4.2：附件实体/引用分离）。
 *
 * 不变量与协议：
 *  - 写入顺序：**文件先落地**（BlobCas/AtomicWriter）→ 再在调用方事务里提交
 *    `blob` 记录与 `note_attachment` 引用；本仓储不感知文件；
 *  - 删除顺序：先 `detach` 解除引用；blob 记录经 GC 宽限期（orphan_grace）
 *    后才允许 `deleteIfOrphan` + `BlobCas.collectGarbage`；
 *  - `listReferencedShas` 以 `note_attachment` 为引用事实源（而不是 blob.status），
 *    供启动恢复扫描核对"被引用但文件缺失"（G5 阻断项）。
 */

import { AttachmentRole, BlobRecord, BlobSha256, BlobStatus, NoteAttachment, NoteId } from '../model';
import { ILogger, LogLevel } from '../ports';
import { IRdbExecutor, SqlRow, reqNumber, reqString } from './rdb';

export interface BlobRepoDeps {
  readonly db: IRdbExecutor;
  readonly logger: ILogger;
}

const BLOB_COLUMNS: string = 'sha256, relative_path, mime, size, status';

export class BlobRepository {
  constructor(private readonly deps: BlobRepoDeps) {}

  /** 登记 blob 记录；同摘要重复登记为 no-op（内容寻址天然去重） */
  async saveRecord(record: BlobRecord): Promise<void> {
    await this.deps.db.execute(
      `INSERT OR IGNORE INTO blob (${BLOB_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
      [record.sha256, record.relativePath, record.mime, record.size, record.status],
    );
  }

  async get(sha256: BlobSha256): Promise<BlobRecord | undefined> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT ${BLOB_COLUMNS} FROM blob WHERE sha256 = ?`,
      [sha256],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return rowToBlob(rows[0]);
  }

  /**
   * 建立引用并把 blob 置为 referenced。
   * 引用事实以 note_attachment 行存在为准；status 只是 GC 用的冗余标记。
   * 注意：必须在"文件已落盘"之后调用（外层事务提交即引用生效）。
   */
  async attach(noteId: NoteId, sha256: BlobSha256, role: AttachmentRole, ordinal: number): Promise<void> {
    await this.deps.db.execute(
      `INSERT OR REPLACE INTO note_attachment (note_id, blob_sha256, role, ordinal) VALUES (?, ?, ?, ?)`,
      [noteId, sha256, role, ordinal],
    );
    await this.deps.db.execute(`UPDATE blob SET status = ? WHERE sha256 = ?`, [
      BlobStatus.REFERENCED,
      sha256,
    ]);
  }

  /** 解除引用；该 blob 不再被任何笔记引用时进入 GC 宽限期 */
  async detach(noteId: NoteId, sha256: BlobSha256, role: AttachmentRole): Promise<void> {
    await this.deps.db.execute(
      `DELETE FROM note_attachment WHERE note_id = ? AND blob_sha256 = ? AND role = ?`,
      [noteId, sha256, role],
    );
    const refs: NoteId[] = await this.listAttachmentNotesOf(sha256);
    if (refs.length === 0) {
      await this.deps.db.execute(`UPDATE blob SET status = ? WHERE sha256 = ?`, [
        BlobStatus.ORPHAN_GRACE,
        sha256,
      ]);
    }
  }

  async listAttachmentsOf(noteId: NoteId): Promise<NoteAttachment[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT note_id, blob_sha256, role, ordinal FROM note_attachment WHERE note_id = ? ORDER BY ordinal`,
      [noteId],
    );
    const out: NoteAttachment[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push(rowToAttachment(rows[i]));
    }
    return out;
  }

  /** 反查：哪些笔记（含回收站中的）仍引用该 blob —— GC 排除判断的事实源 */
  async listAttachmentNotesOf(sha256: BlobSha256): Promise<NoteId[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT DISTINCT note_id FROM note_attachment WHERE blob_sha256 = ?`,
      [sha256],
    );
    const out: NoteId[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push(reqString(rows[i], 'note_id'));
    }
    return out;
  }

  /** 全部被引用的摘要集合：启动恢复扫描（BlobCas.reconcile）的输入 */
  async listReferencedShas(): Promise<BlobSha256[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT DISTINCT blob_sha256 AS sha256 FROM note_attachment`,
    );
    const out: BlobSha256[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push(reqString(rows[i], 'sha256'));
    }
    return out;
  }

  /** GC 宽限期内的 blob 记录 */
  async listOrphanGrace(): Promise<BlobRecord[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT ${BLOB_COLUMNS} FROM blob WHERE status = ?`,
      [BlobStatus.ORPHAN_GRACE],
    );
    const out: BlobRecord[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push(rowToBlob(rows[i]));
    }
    return out;
  }

  async markStatus(sha256: BlobSha256, status: BlobStatus): Promise<void> {
    await this.deps.db.execute(`UPDATE blob SET status = ? WHERE sha256 = ?`, [status, sha256]);
  }

  /**
   * GC 安全网：仅当"无引用 且 处于宽限期"才删除记录；返回是否删除。
   * 文件本体的删除由 BlobCas.collectGarbage 执行（调用方须先确认回收站/备份快照无引用，
   * 设计 §4.2 第 3 条）。
   */
  async deleteIfOrphan(sha256: BlobSha256): Promise<boolean> {
    const record = await this.get(sha256);
    if (record === undefined) {
      return false;
    }
    const refs: NoteId[] = await this.listAttachmentNotesOf(sha256);
    if (refs.length > 0 || record.status !== BlobStatus.ORPHAN_GRACE) {
      this.deps.logger.log(LogLevel.WARN, 'blob_gc_refused', {
        sha256,
        refs: refs.length,
        status: record.status,
      });
      return false;
    }
    await this.deps.db.execute(`DELETE FROM blob WHERE sha256 = ?`, [sha256]);
    return true;
  }
}

function rowToBlob(row: SqlRow): BlobRecord {
  const record: BlobRecord = {
    sha256: reqString(row, 'sha256'),
    relativePath: reqString(row, 'relative_path'),
    mime: reqString(row, 'mime'),
    size: reqNumber(row, 'size'),
    status: reqString(row, 'status') as BlobStatus,
  };
  return record;
}

function rowToAttachment(row: SqlRow): NoteAttachment {
  const att: NoteAttachment = {
    noteId: reqString(row, 'note_id'),
    blobSha256: reqString(row, 'blob_sha256'),
    role: reqString(row, 'role') as AttachmentRole,
    ordinal: reqNumber(row, 'ordinal'),
  };
  return att;
}
