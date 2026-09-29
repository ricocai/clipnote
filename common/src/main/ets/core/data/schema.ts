/**
 * 数据库 schema 与迁移定义（设计 §4.2）。
 *
 * 版本口径：
 *  - `DB_SCHEMA_VERSION` 是**库结构**版本，随 MIGRATIONS 递增；
 *  - `model.ts` 的 `CONTENT_SCHEMA_VERSION` 是**业务记录内容**版本，存在每行数据里；
 *    两者演进节奏不同，不要混用。
 *  - 同步预留（设计 §4.8）：实体用 UUID v7 + note.revision 表达修改事务边界，
 *    **不建** sync_state 表。
 *
 * 迁移规则：
 *  - 每个迁移一次性、原子地执行（SchemaMigrator 用事务包裹）；
 *  - 迁移只前进、不回滚；版本号必须连续（1, 2, 3, ...），跳号即报错；
 *  - DDL 一律 `IF NOT EXISTS`，保证重复执行安全。
 */

export const DB_SCHEMA_VERSION: number = 3;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/**
 * V1：首期库结构。
 *
 * 对照设计 §4.2 逻辑结构，补齐外键、索引与 model.ts 的完整字段：
 *  - clipboard_item 补上 entry / truncated / original_byte_length（设计只列了核心列，
 *    但 §4.1 要求"入口 × 生命周期 × 承诺"可观测、截断不得静默丢弃 —— 这些字段是履约凭证）；
 *  - note_fts 为**占位普通表**：设计明确"FTS5 外部内容表 + 触发器同步（可用性待 G7）"，
 *    G7 设备探测确认 FTS5 可用后再以迁移替换为 virtual table。
 */
const MIGRATION_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     version INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS note (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     content_md TEXT NOT NULL,
     content_type TEXT NOT NULL,
     source TEXT NOT NULL,
     origin_hash TEXT,
     revision INTEGER NOT NULL DEFAULT 1,
     content_schema_version INTEGER NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   )`,
  // 列表页主路径：未删除 + 按更新时间倒序
  `CREATE INDEX IF NOT EXISTS idx_note_list ON note (deleted_at, updated_at)`,

  `CREATE TABLE IF NOT EXISTS tag (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE
   )`,

  `CREATE TABLE IF NOT EXISTS note_tag (
     note_id TEXT NOT NULL REFERENCES note (id) ON DELETE CASCADE,
     tag_id TEXT NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
     PRIMARY KEY (note_id, tag_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_note_tag_tag ON note_tag (tag_id)`,

  `CREATE TABLE IF NOT EXISTS blob (
     sha256 TEXT PRIMARY KEY,
     relative_path TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     status TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blob_status ON blob (status)`,

  `CREATE TABLE IF NOT EXISTS note_attachment (
     note_id TEXT NOT NULL REFERENCES note (id) ON DELETE CASCADE,
     blob_sha256 TEXT NOT NULL REFERENCES blob (sha256),
     role TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     PRIMARY KEY (note_id, blob_sha256, role)
   )`,
  // GC 与恢复扫描的反查路径：blob → 哪些笔记还在引用
  `CREATE INDEX IF NOT EXISTS idx_note_attachment_blob ON note_attachment (blob_sha256)`,

  `CREATE TABLE IF NOT EXISTS clipboard_item (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     raw_text TEXT NOT NULL,
     structured_json TEXT,
     origin_app TEXT,
     sha256 TEXT NOT NULL,
     captured_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     sensitivity TEXT NOT NULL,
     state TEXT NOT NULL,
     entry TEXT NOT NULL,
     truncated INTEGER NOT NULL DEFAULT 0,
     original_byte_length INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_clipboard_item_state ON clipboard_item (state)`,
  // 保留期清理主路径
  `CREATE INDEX IF NOT EXISTS idx_clipboard_item_expires ON clipboard_item (expires_at)`,

  // 占位（设计 §4.2）：G7 探测确认 RelationalStore 开放 FTS5 后，
  // 由后续迁移替换为 FTS5 外部内容表 + 触发器同步。
  `CREATE TABLE IF NOT EXISTS note_fts (
     note_id TEXT PRIMARY KEY REFERENCES note (id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     content TEXT NOT NULL
   )`,
];

/**
 * V2：note_fts 落库为 FTS5 trigram contentless 表（S3-4；G7 设备探测结论，WHY-91）。
 *
 * 选型依据（tools/report/g7-search-probe-device.md）：设备构建口径（OH SQLite 3.40.1）FTS5 与
 * trigram 分词器均可用；≥3 字符查询 trigram 按"串"匹配（召回/精确 100%，含标点），
 * 1–2 字符查询由 SearchRepository 回退 LIKE 受限扫描（探测 s0 路径）。
 *
 * 结构口径：
 *  - **contentless 表**（不设 content='note'）：查询一律 JOIN note 取正文，本就不需要
 *    FTS 回读内容表；更重要的是主机 SQLite 3.51.2 实测外部内容表 + 触发器 UPDATE
 *    （旧值为中文、新值为 ASCII 时）会触发 "database disk image is malformed" 引擎缺陷，
 *    contentless 全操作矩阵（增/删/改/重建）实测稳定 —— 选可验证稳定的路径；
 *  - 触发器只管 INSERT / DELETE / UPDATE OF(title, content_md)：
 *    软删除（deleted_at）不动索引，由查询侧 `deleted_at IS NULL` 过滤（G7「无已删数据泄露」）；
 *    置顶/恢复等不触碰 title/content_md 的 UPDATE 不重写索引；
 *  - UPDATE 同步 = DELETE + INSERT 两步（contentless 下等价为整行替换）；
 *  - V1 占位普通表直接 DROP 重建（占位表从未承载业务数据，仅 replaceAll 曾写入，语义由触发器接管）。
 */
const MIGRATION_V2: readonly string[] = [
  `DROP TABLE IF EXISTS note_fts`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
     title,
     content_md,
     tokenize = 'trigram'
   )`,

  // 触发器同步：索引行与 note 隐含 rowid 对齐（contentless 表只存索引，正文以 note 为权威）。
  // UPDATE = DELETE + INSERT 整行替换（contentless 下的标准同步写法，全字符集矩阵实测稳定）。
  `CREATE TRIGGER IF NOT EXISTS trg_note_fts_insert AFTER INSERT ON note BEGIN
     INSERT INTO note_fts (rowid, title, content_md) VALUES (new.rowid, new.title, new.content_md);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_note_fts_delete AFTER DELETE ON note BEGIN
     DELETE FROM note_fts WHERE rowid = old.rowid;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_note_fts_update AFTER UPDATE OF title, content_md ON note BEGIN
     DELETE FROM note_fts WHERE rowid = old.rowid;
     INSERT INTO note_fts (rowid, title, content_md) VALUES (new.rowid, new.title, new.content_md);
   END`,

  // 已有数据回填（含回收站条目：查询侧统一按 deleted_at 过滤）
  `INSERT INTO note_fts (rowid, title, content_md)
     SELECT rowid, title, content_md FROM note`,
];

/**
 * V3：MCP 审计表（S6-1；设计 §4.5.5）。
 *
 * 审计纪律（勿破坏）：只记元数据 —— 客户端、工具、对象 ID、结果、时间与
 * 载荷字节数；**不记正文、不记令牌**（令牌/正文进库会把审计表变成数据泄露面）。
 * `object_ids` 以 JSON 数组文本存储（仅对象 ID 列表，属元数据）。
 */
const MIGRATION_V3: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS mcp_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id TEXT NOT NULL,
     tool TEXT NOT NULL,
     object_ids TEXT NOT NULL,
     result TEXT NOT NULL,
     at_ms INTEGER NOT NULL,
     payload_bytes INTEGER NOT NULL
   )`,
  // 审计查询页主路径：按时间倒序翻页
  `CREATE INDEX IF NOT EXISTS idx_mcp_audit_at ON mcp_audit (at_ms)`,
  // 按客户端追溯其行为序列
  `CREATE INDEX IF NOT EXISTS idx_mcp_audit_client ON mcp_audit (client_id, at_ms)`,
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', statements: MIGRATION_V1 },
  { version: 2, name: 'note_fts_trigram', statements: MIGRATION_V2 },
  { version: 3, name: 'mcp_audit', statements: MIGRATION_V3 },
];
