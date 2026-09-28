/**
 * Schema 迁移器（设计 §4.2：schema 版本与迁移机制）。
 *
 * 策略：
 *  - 版本存于 `schema_meta`（单行），自管理，不依赖各平台 RDB 封装自带的版本机制
 *    —— 这样鸿蒙 RelationalStore 与本机 node:sqlite 走**同一条迁移路径**；
 *  - 每个迁移在独立事务内执行：失败即整体回滚，库停留在上一个已提交版本
 *    （设计 §4.2 要求"迁移失败"的行为定义：不留半截 schema）；
 *  - 版本必须连续递增，跳号直接报错，防止发布时漏带迁移。
 */

import { ILogger, LogLevel } from '../ports';
import { IRdbExecutor, reqNumber, transact } from './rdb';
import { MIGRATIONS, Migration } from './schema';

export class SchemaMigrator {
  private readonly migrations: readonly Migration[];

  constructor(
    private readonly db: IRdbExecutor,
    private readonly logger: ILogger,
    migrations?: readonly Migration[],
  ) {
    this.migrations = migrations === undefined ? MIGRATIONS : migrations;
  }

  /** 当前库版本；库为空（无 schema_meta）时返回 0 */
  async currentVersion(): Promise<number> {
    const tables = await this.db.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`,
    );
    if (tables.length === 0) {
      return 0;
    }
    const rows = await this.db.query(`SELECT version FROM schema_meta WHERE id = 1`);
    if (rows.length === 0) {
      return 0;
    }
    return reqNumber(rows[0], 'version');
  }

  /** 应用所有待执行迁移，返回最终版本 */
  async migrate(): Promise<number> {
    const sorted: Migration[] = this.migrations.slice().sort((a: Migration, b: Migration) => a.version - b.version);
    let current: number = await this.currentVersion();
    for (let i: number = 0; i < sorted.length; i++) {
      const m: Migration = sorted[i];
      if (m.version <= current) {
        continue;
      }
      if (m.version !== current + 1) {
        throw new Error(`schema migration gap: current=${current}, next=${m.version} ("${m.name}")`);
      }
      await transact(this.db, async () => {
        for (let s: number = 0; s < m.statements.length; s++) {
          await this.db.execute(m.statements[s]);
        }
        await this.db.execute(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, ?)`, [m.version]);
      });
      this.logger.log(LogLevel.INFO, 'db_migration_applied', { version: m.version, name: m.name });
      current = m.version;
    }
    return current;
  }
}
