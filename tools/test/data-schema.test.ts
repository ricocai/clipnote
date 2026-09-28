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
  for (const t of ['schema_meta', 'note', 'tag', 'note_tag', 'blob', 'note_attachment', 'clipboard_item', 'note_fts']) {
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
  ]) {
    assert.ok(indexes.includes(idx), `missing index ${idx}`);
  }
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

test('schema: 增量迁移在上一版本之上应用（v3 加列）', async () => {
  const db = NodeSqliteExecutor.openMemory();
  const v3: readonly Migration[] = [
    ...MIGRATIONS,
    { version: 3, name: 'add_mood', statements: [`ALTER TABLE note ADD COLUMN mood TEXT`] },
  ];
  const migrator = new SchemaMigrator(db, logger, v3);

  assert.equal(await migrator.migrate(), 3);
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
