/**
 * 收件箱仓储（设计 §4.1：收件箱即数据持久化）。
 *
 * 口径提醒（V1.4）：
 *  - 一旦写入 `clipboard_item` 就是"已保存" —— 敏感内容必须**在落盘前**拦截
 *    （采集管线 `clip.ts` 的职责），本仓储不做敏感判断；
 *  - 收件箱默认**不进入** MCP 访问范围、搜索索引与备份导出；
 *  - 保留期：超过 `expires_at` 的条目由 `purgeExpired` 清理；
 *    `clearAll` 对应"一键清空"。
 */

import { ClipboardItem, ClipEntry, ClipKind, InboxState, Sensitivity } from '../model';
import { ILogger } from '../ports';
import { IRdbExecutor, SqlRow, nullify, optString, reqNumber, reqString } from './rdb';

export interface InboxRepoDeps {
  readonly db: IRdbExecutor;
  readonly logger: ILogger;
}

const ITEM_COLUMNS: string =
  'id, kind, raw_text, structured_json, origin_app, sha256, captured_at, expires_at, ' +
  'sensitivity, state, entry, truncated, original_byte_length';

export class InboxRepository {
  constructor(private readonly deps: InboxRepoDeps) {}

  /** 写入条目；同 id 重复写入按覆盖处理（幂等重试安全） */
  async save(item: ClipboardItem): Promise<void> {
    await this.deps.db.execute(
      `INSERT OR REPLACE INTO clipboard_item (${ITEM_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.kind,
        item.rawText,
        nullify(item.structuredJson),
        nullify(item.originApp),
        item.sha256,
        item.capturedAtMs,
        item.expiresAtMs,
        item.sensitivity,
        item.state,
        item.entry,
        item.truncated ? 1 : 0,
        item.originalByteLength,
      ],
    );
  }

  async getById(id: string): Promise<ClipboardItem | undefined> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT ${ITEM_COLUMNS} FROM clipboard_item WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return rowToItem(rows[0]);
  }

  /** 按状态列出（默认按采集时间倒序）；limit 约束结果集规模 */
  async listByState(state: InboxState, limit: number): Promise<ClipboardItem[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT ${ITEM_COLUMNS} FROM clipboard_item WHERE state = ? ORDER BY captured_at DESC LIMIT ?`,
      [state, limit],
    );
    const items: ClipboardItem[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      items.push(rowToItem(rows[i]));
    }
    return items;
  }

  /** 状态迁移（用户确认保存 / 放弃 / 待确认）；返回是否命中 */
  async updateState(id: string, state: InboxState): Promise<boolean> {
    const existing = await this.getById(id);
    if (existing === undefined) {
      return false;
    }
    await this.deps.db.execute(`UPDATE clipboard_item SET state = ? WHERE id = ?`, [state, id]);
    return true;
  }

  /** 清理超过保留期的条目（所有状态）；返回清理条数 */
  async purgeExpired(nowMs: number): Promise<number> {
    const n: number = await this.countWhere(`expires_at <= ?`, [nowMs]);
    if (n > 0) {
      await this.deps.db.execute(`DELETE FROM clipboard_item WHERE expires_at <= ?`, [nowMs]);
    }
    return n;
  }

  /** 一键清空收件箱；返回清理条数 */
  async clearAll(): Promise<number> {
    const n: number = await this.countWhere(`1 = 1`, []);
    if (n > 0) {
      await this.deps.db.execute(`DELETE FROM clipboard_item`);
    }
    return n;
  }

  async countByState(state: InboxState): Promise<number> {
    return this.countWhere(`state = ?`, [state]);
  }

  private async countWhere(where: string, params: (string | number | null)[]): Promise<number> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT COUNT(*) AS c FROM clipboard_item WHERE ${where}`,
      params,
    );
    return reqNumber(rows[0], 'c');
  }
}

function rowToItem(row: SqlRow): ClipboardItem {
  const item: ClipboardItem = {
    id: reqString(row, 'id'),
    kind: reqString(row, 'kind') as ClipKind,
    rawText: reqString(row, 'raw_text'),
    structuredJson: optString(row, 'structured_json'),
    originApp: optString(row, 'origin_app'),
    sha256: reqString(row, 'sha256'),
    capturedAtMs: reqNumber(row, 'captured_at'),
    expiresAtMs: reqNumber(row, 'expires_at'),
    sensitivity: reqString(row, 'sensitivity') as Sensitivity,
    state: reqString(row, 'state') as InboxState,
    entry: reqString(row, 'entry') as ClipEntry,
    truncated: reqNumber(row, 'truncated') === 1,
    originalByteLength: reqNumber(row, 'original_byte_length'),
  };
  return item;
}
