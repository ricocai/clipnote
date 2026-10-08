import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { ILogger, LogLevel } from '../core/ports';
import { IRdbExecutor, SqlRow, SqlValue } from '../core/data/rdb';

export const DEFAULT_DB_NAME: string = 'clipnote.db';

/**
 * RelationalStore → IRdbExecutor 适配（设计 §4.2）。
 *
 * 口径：
 *  - schema 版本由 core/data/migrator.ts 的 schema_meta 自管理，**不使用**
 *    RdbStore 自带的版本属性 —— 两端（鸿蒙/本机 node:sqlite）走同一条迁移路径；
 *  - 外键约束逐连接开启：schema 的引用完整性（note_attachment → blob/note 等）依赖它；
 *  - 字节列与 Asset 类型禁止出现在业务表（SqlValue 收窄为 string/number/null，
 *    附件字节一律走 BlobCas 文件），读到即抛错，防止有人悄悄把二进制塞进来。
 */
export class RelationalStoreExecutor implements IRdbExecutor {
  private readonly store: relationalStore.RdbStore;
  private readonly logger: ILogger;

  private constructor(store: relationalStore.RdbStore, logger: ILogger) {
    this.store = store;
    this.logger = logger;
  }

  static async open(
    context: common.Context,
    logger: ILogger,
    name?: string,
  ): Promise<RelationalStoreExecutor> {
    const config: relationalStore.StoreConfig = {
      name: name === undefined ? DEFAULT_DB_NAME : name,
      securityLevel: relationalStore.SecurityLevel.S1,
    };
    const store: relationalStore.RdbStore = await relationalStore.getRdbStore(context, config);
    try {
      await store.executeSql('PRAGMA foreign_keys = ON');
    } catch (err) {
      // PRAGMA 若被平台侧拦截（部分版本对 executeSql 的语句类型有限制），
      // 外键不生效也不能静默：记 WARN，由 ohosTest 的外键用例兜底暴露
      logger.log(LogLevel.WARN, 'rdb_foreign_keys_pragma_failed', { reason: String(err) });
    }
    return new RelationalStoreExecutor(store, logger);
  }

  async execute(sql: string, params?: SqlValue[]): Promise<void> {
    await this.store.executeSql(sql, toBindArgs(params));
  }

  async query(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
    const rs: relationalStore.ResultSet = await this.store.querySql(sql, toBindArgs(params));
    try {
      const rows: SqlRow[] = [];
      while (rs.goToNextRow()) {
        const row: Record<string, SqlValue> = {};
        const columnCount: number = rs.columnCount;
        for (let i: number = 0; i < columnCount; i++) {
          row[rs.getColumnName(i)] = readCell(rs, i);
        }
        rows.push(row);
      }
      return rows;
    } finally {
      rs.close();
    }
  }

  async beginTransaction(): Promise<void> {
    this.store.beginTrans();
  }

  async commit(): Promise<void> {
    this.store.commit();
  }

  async rollback(): Promise<void> {
    this.store.rollBack();
  }
}

function toBindArgs(params?: SqlValue[]): relationalStore.ValueType[] {
  const args: relationalStore.ValueType[] = [];
  if (params === undefined) {
    return args;
  }
  for (let i: number = 0; i < params.length; i++) {
    args.push(params[i]);
  }
  return args;
}

function readCell(rs: relationalStore.ResultSet, columnIndex: number): SqlValue {
  if (rs.isColumnNull(columnIndex)) {
    return null;
  }
  const v: relationalStore.ValueType = rs.getValue(columnIndex);
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  throw new Error('relational-store: unsupported column type (业务表不允许 bytes/Asset，见附件寻址口径)');
}
