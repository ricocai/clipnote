/**
 * 关系库执行端口（设计 §4.2：RelationalStore/SQLite 为业务记录权威源）。
 *
 * 领域内核只依赖这个最小接口，两端各有一份实现、执行**同一套 DDL 与仓储 SQL**：
 *   - 鸿蒙侧：`adapters/relational-store.ets`（@kit.ArkData relationalStore）
 *   - 本机侧：`tools/test/support/sqlite-executor.ts`（node:sqlite）
 *
 * 约束（数据层纪律，勿破坏）：
 *  1. 所有查询必须参数化 —— 仓储层禁止把用户输入拼接进 SQL 文本；
 *  2. 事务是"连接级"的：同一执行器同时只允许一个活跃事务，组合多个仓储写操作时
 *     由调用方在最外层开一次事务并把同一执行器传下去（嵌套 begin 会报错）；
 *  3. `SqlValue` 刻意收窄为 string/number/null：blob 字节一律走文件（BlobCas），
 *     不入库（设计 §4.2：图片实际字节不在 SQLite 表内）。
 */

export type SqlValue = string | number | null;

/** 一行查询结果：列名 → 值。 */
export type SqlRow = Record<string, SqlValue>;

export interface IRdbExecutor {
  /** 执行无结果集语句（DDL / DML）。 */
  execute(sql: string, params?: SqlValue[]): Promise<void>;
  /** 执行查询并返回全部行；结果集规模由仓储层的 LIMIT 约束。 */
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * 事务包裹：`fn` 抛错则回滚并原样上抛；回滚失败不掩盖原始错误。
 * 不提供自动重试 —— 崩溃一致性依赖"文件先落地、引用后提交"的写入协议
 * （设计 §4.2），而不是数据库层重试。
 */
export async function transact<T>(db: IRdbExecutor, fn: () => Promise<T>): Promise<T> {
  await db.beginTransaction();
  try {
    const result: T = await fn();
    await db.commit();
    return result;
  } catch (err) {
    try {
      await db.rollback();
    } catch (rollbackErr) {
      // 回滚失败不掩盖原始错误；连接状态由上层重建
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 行读取辅助：把 SqlRow 的宽松类型收窄为领域类型，脏数据尽早暴露
// ---------------------------------------------------------------------------

function cellOf(row: SqlRow, col: string): SqlValue {
  const v: SqlValue | undefined = row[col];
  return v === undefined ? null : v;
}

/** 读取非空字符串列；类型不符即抛错（说明 schema 与代码失配，属缺陷而非数据问题） */
export function reqString(row: SqlRow, col: string): string {
  const v: SqlValue = cellOf(row, col);
  if (typeof v !== 'string') {
    throw new Error(`rdb: column "${col}" expected string, got ${v === null ? 'null' : typeof v}`);
  }
  return v;
}

/** 读取可空字符串列；null/缺失 → undefined */
export function optString(row: SqlRow, col: string): string | undefined {
  const v: SqlValue = cellOf(row, col);
  if (v === null) {
    return undefined;
  }
  if (typeof v !== 'string') {
    throw new Error(`rdb: column "${col}" expected string or null, got ${typeof v}`);
  }
  return v;
}

/** 读取非空数值列 */
export function reqNumber(row: SqlRow, col: string): number {
  const v: SqlValue = cellOf(row, col);
  if (typeof v !== 'number') {
    throw new Error(`rdb: column "${col}" expected number, got ${v === null ? 'null' : typeof v}`);
  }
  return v;
}

/** 读取可空数值列；null/缺失 → undefined */
export function optNumber(row: SqlRow, col: string): number | undefined {
  const v: SqlValue = cellOf(row, col);
  if (v === null) {
    return undefined;
  }
  if (typeof v !== 'number') {
    throw new Error(`rdb: column "${col}" expected number or null, got ${typeof v}`);
  }
  return v;
}

/** undefined → null（绑定参数用；SQL 参数不接受 undefined） */
export function nullify(v: string | undefined): SqlValue {
  return v === undefined ? null : v;
}
