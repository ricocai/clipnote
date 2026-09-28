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

export const DB_SCHEMA_VERSION: number = 1;

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

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', statements: MIGRATION_V1 },
];
