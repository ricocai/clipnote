import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DB_SCHEMA_VERSION, MIGRATIONS, Migration } from '../../common/src/main/ets/core/data/schema';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { reqNumber, reqString } from '../../common/src/main/ets/core/data/rdb';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import { CapturingLogger } from './support/platform';

const logger = new CapturingLogger();

async function tableNames(db: NodeSqliteExecutor): Promise<string[]> {
  const rows = await db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
  return rows.map((r) => reqString(r, 'name'));
}

test('schema: 全新库迁移到当前版本，全部表与索引建立', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const migrator = new SchemaMigrator(db, logger);

  assert.equal(await migrator.currentVersion(), 0);
  assert.equal(await migrator.migrate(), DB_SCHEMA_VERSION);

  const tables = await tableNames(db);
  for (const t of ['schema_meta', 'note', 'tag', 'note_tag', 'blob', 'note_attachment', 'clipboard_item', 'note_fts', 'mcp_audit', 'export_record', 'notebook']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }

  const indexRows = await db.query(`SELECT name FROM sqlite_master WHERE type = 'index'`);
  const indexes = indexRows.map((r) => reqString(r, 'name'));
  for (const idx of [
    'idx_note_list',
    'idx_note_tag_tag',
    'idx_blob_status',
    'idx_note_attachment_blob',
    'idx_clipboard_item_state',
    'idx_clipboard_item_expires',
    'idx_mcp_audit_at',
    'idx_mcp_audit_client',
    'idx_export_record_created',
    'idx_note_notebook',
  ]) {
    assert.ok(indexes.includes(idx), `missing index ${idx}`);
  }
  db.close();
});

test('schema V5: 全新库含内置默认笔记本（nb-default，built_in + is_default 恰一行）', async () => {
  const db = NodeSqliteExecutor.openMemory();
  await new SchemaMigrator(db, logger).migrate();

  const rows = await db.query(`SELECT id, name, built_in, is_default FROM notebook`);
  assert.equal(rows.length, 1);
  assert.equal(reqString(rows[0], 'id'), 'nb-default');
  assert.equal(reqString(rows[0], 'name'), '默认笔记本');
  assert.equal(reqNumber(rows[0], 'built_in'), 1);
  assert.equal(reqNumber(rows[0], 'is_default'), 1);
  db.close();
});

test('schema V5: V4 老库升级 —— note 加列并全量回填默认笔记本', async () => {
  // 先按 V1..V4 建库并写入一条 V4 形态笔记（无 notebook_id 列）
  const db = NodeSqliteExecutor.openMemory();
  const v4 = MIGRATIONS.filter((m) => m.version <= 4);
  await new SchemaMigrator(db, logger, v4).migrate();
  await db.execute(
    `INSERT INTO note (id, title, content_md, content_type, source, origin_hash, revision,
       content_schema_version, pinned, created_at, updated_at, deleted_at)
     VALUES ('old-note-1', '旧笔记', '正文', 'text/markdown', 'manual', NULL, 1, 1, 0, 100, 200, NULL)`,
  );

  // 全量迁移（应用 V5）：加列 → 建内置默认 → 回填
  assert.equal(await new SchemaMigrator(db, logger).migrate(), 5);
  const notes = await db.query(`SELECT id, notebook_id FROM note`);
  assert.equal(notes.length, 1);
  assert.equal(reqString(notes[0], 'notebook_id'), 'nb-default');
  const defaults = await db.query(`SELECT id FROM notebook WHERE is_default = 1`);
  assert.equal(defaults.length, 1);
  db.close();
});

test('schema: 迁移幂等 —— 重复执行不报错、版本不回退', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const migrator = new SchemaMigrator(db, logger);

  await migrator.migrate();
  assert.equal(await migrator.migrate(), DB_SCHEMA_VERSION);
  assert.equal(await migrator.currentVersion(), DB_SCHEMA_VERSION);
  db.close();
});

test('schema: 版本跳号直接报错（防发布漏带迁移）', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const gapped: readonly Migration[] = [{ version: 2, name: 'gapped', statements: [] }];
  const migrator = new SchemaMigrator(db, logger, gapped);
  await assert.rejects(() => migrator.migrate(), /migration gap/);
  db.close();
});

test('schema: 增量迁移在上一版本之上应用（v6 加列）', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const v6: readonly Migration[] = [
    ...MIGRATIONS,
    { version: 6, name: 'add_mood', statements: [`ALTER TABLE note ADD COLUMN mood TEXT`] },
  ];
  const migrator = new SchemaMigrator(db, logger, v6);

  assert.equal(await migrator.migrate(), 6);
  const cols = await db.query(`SELECT name FROM pragma_table_info('note')`);
  const names = cols.map((r) => reqString(r, 'name'));
  assert.ok(names.includes('mood'));
  db.close();
});

test('schema: 迁移中途失败整体回滚，不留半截 schema', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const broken: readonly Migration[] = [
    {
      version: 1,
      name: 'broken',
      statements: [
        `CREATE TABLE IF NOT EXISTS t_will_rollback (id TEXT PRIMARY KEY)`,
        `CREATE TABLE broken syntax here`,
      ],
    },
  ];
  const migrator = new SchemaMigrator(db, logger, broken);
  await assert.rejects(() => migrator.migrate());

  // 事务回滚：表不应残留，版本仍为 0
  const tables = await tableNames(db);
  assert.ok(!tables.includes('t_will_rollback'));
  assert.equal(await migrator.currentVersion(), 0);
  db.close();
});

test('schema: 外键约束生效（孤儿引用被拒绝）', async () => {
  const db = NodeSqliteExecutor.openMemory();
  await new SchemaMigrator(db, logger).migrate();

  await assert.rejects(() =>
    db.execute(
      `INSERT INTO note_attachment (note_id, blob_sha256, role, ordinal) VALUES (?, ?, ?, ?)`,
      ['no-such-note', 'a'.repeat(64), 'inline_image', 0],
    ),
  );
  db.close();
});
