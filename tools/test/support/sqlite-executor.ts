/**
 * 本机测试用关系库执行器（Node `node:sqlite`）。
 *
 * 与鸿蒙侧 `adapters/relational-store.ets` 满足同一 `IRdbExecutor` 契约，
 * 执行同一套 DDL/迁移/仓储 SQL —— 本机绿不代表设备行为一致（SQLite 构建差异），
 * 设备侧由 ohosTest 的 hypium 用例复核。
 */

import { DatabaseSync } from 'node:sqlite';

import {
  IRdbExecutor,
  SqlRow,
  SqlValue,
} from '../../../common/src/main/ets/core/data/rdb';

type SqliteOutput = null | number | bigint | string | Uint8Array;

export class NodeSqliteExecutor implements IRdbExecutor {
  constructor(private readonly db: DatabaseSync) {
    // 外键约束逐连接开启，schema 的引用完整性依赖它（与鸿蒙侧适配器同一口径）
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  static openMemory(): NodeSqliteExecutor {
    return new NodeSqliteExecutor(new DatabaseSync(':memory:'));
  }

  /** 文件库（G5 恢复演练：进程被杀后重开，验证 SQLite 日志恢复语义） */
  static openFile(path: string): NodeSqliteExecutor {
    return new NodeSqliteExecutor(new DatabaseSync(path));
  }

  async execute(sql: string, params?: SqlValue[]): Promise<void> {
    this.db.prepare(sql).run(...toParams(params));
  }

  async query(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
    const rows = this.db.prepare(sql).all(...toParams(params)) as Array<Record<string, SqliteOutput>>;
    return rows.map((r) => coerceRow(r));
  }

  async beginTransaction(): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
  }

  async commit(): Promise<void> {
    this.db.exec('COMMIT');
  }

  async rollback(): Promise<void> {
    this.db.exec('ROLLBACK');
  }

  close(): void {
    this.db.close();
  }
}

function toParams(params?: SqlValue[]): SqlValue[] {
  return params === undefined ? [] : params;
}

function coerceValue(v: SqliteOutput): SqlValue {
  if (v === null || typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  throw new Error('node:sqlite executor: unsupported column bytes (业务表不允许二进制列)');
}

function coerceRow(r: Record<string, SqliteOutput>): SqlRow {
  const out: Record<string, SqlValue> = {};
  for (const k of Object.keys(r)) {
    out[k] = coerceValue(r[k]);
  }
  return out;
}
