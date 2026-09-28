/**
 * 导出记录仓储（S4-2；schema.ts V3 迁移）。
 *
 * 只面向"可读导出"事件的元数据存取；记录行不含正文（设计 §4.5.5 审计口径）。
 * 清理策略由 ExportService 负责（保留最近 N 条并删除对应产物文件），本类不内嵌策略。
 */

import { IRdbExecutor, SqlRow, reqNumber, reqString } from './rdb';

export type ExportKind = 'single' | 'batch' | 'full';

/** 导出内容形态：纯 MD / 纯 HTML / 混合（批量含两类笔记时） */
export type ExportFormat = 'markdown' | 'html' | 'mixed';

export interface ExportRecord {
  readonly id: string;
  readonly kind: ExportKind;
  readonly format: ExportFormat;
  readonly noteCount: number;
  readonly blobCount: number;
  readonly totalBytes: number;
  /** 产物 ZIP 的沙箱绝对路径（仅本机可读；交接经 Share Kit 临时授权） */
  readonly filePath: string;
  readonly createdAtMs: number;
}

export class ExportRecordRepository {
  constructor(private readonly db: IRdbExecutor) {}

  async insert(record: ExportRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO export_record (id, kind, format, note_count, blob_count, total_bytes, file_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.kind,
        record.format,
        record.noteCount,
        record.blobCount,
        record.totalBytes,
        record.filePath,
        record.createdAtMs,
      ],
    );
  }

  /** 最近导出记录（设置页展示与清理候选），时间倒序 */
  async listRecent(limit: number): Promise<ExportRecord[]> {
    const rows: SqlRow[] = await this.db.query(
      `SELECT id, kind, format, note_count, blob_count, total_bytes, file_path, created_at
       FROM export_record ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit],
    );
    const out: ExportRecord[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push({
        id: reqString(rows[i], 'id'),
        kind: reqString(rows[i], 'kind') as ExportKind,
        format: reqString(rows[i], 'format') as ExportFormat,
        noteCount: reqNumber(rows[i], 'note_count'),
        blobCount: reqNumber(rows[i], 'blob_count'),
        totalBytes: reqNumber(rows[i], 'total_bytes'),
        filePath: reqString(rows[i], 'file_path'),
        createdAtMs: reqNumber(rows[i], 'created_at'),
      });
    }
    return out;
  }

  async remove(id: string): Promise<void> {
    await this.db.execute(`DELETE FROM export_record WHERE id = ?`, [id]);
  }
}
