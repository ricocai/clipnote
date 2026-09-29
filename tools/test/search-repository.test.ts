import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { SearchRepository, TITLE_MATCH_BONUS } from '../../common/src/main/ets/core/data/search-repository';
import { transact } from '../../common/src/main/ets/core/data/rdb';
import { Note, NoteSource } from '../../common/src/main/ets/core/model';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import { CapturingLogger, FixedClock, SequentialRandom } from './support/platform';

const BASE_MS = 1759000000000;

interface Fixture {
  db: NodeSqliteExecutor;
  notes: NoteRepository;
  search: SearchRepository;
}

async function makeFixture(): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const notes = new NoteRepository({ db, clock, random: new SequentialRandom(), logger });
  const search = new SearchRepository({ db });
  return { db, notes, search };
}

async function createNote(f: Fixture, title: string, content: string): Promise<Note> {
  return f.notes.create({ title, contentMd: content, source: NoteSource.MANUAL });
}

test('迁移后 note_fts 是 FTS5 trigram 虚拟表（V1 占位普通表已替换）', async () => {
  const f = await makeFixture();
  const rows = await f.db.query(`SELECT sql FROM sqlite_master WHERE name = 'note_fts'`);
  assert.equal(rows.length, 1);
  const sql = String(rows[0]['sql']);
  assert.ok(sql.includes('USING fts5'), sql);
  assert.ok(sql.includes("tokenize = 'trigram'"), sql);
  // contentless：不设 content='note'（外部内容表 + 触发器在 3.51.2 有引擎缺陷，schema.ts 有记录）
  assert.ok(!sql.includes("content = 'note'"), sql);
});

test('建笔记经触发器入索引；≥3 字符查询命中并返回高亮契约（原文偏移）', async () => {
  const f = await makeFixture();
  await createNote(f, '会议纪要', '本周评审结论：鸿蒙笔记应用的检索方案采用 FTS5 trigram。');
  const hits = await f.search.search('鸿蒙笔记');
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.equal(hit.title, '会议纪要');
  assert.deepEqual(hit.matchedTerms, ['笔记', '蒙笔', '鸿蒙']);
  assert.equal(hit.coverage, 1);
  assert.ok(hit.score >= 1000, `score=${hit.score}`);
  // 高亮区间落在「标题\n正文」拼接文本上，片段文本可被原文复核
  const text = '会议纪要\n本周评审结论：鸿蒙笔记应用的检索方案采用 FTS5 trigram。';
  const joined = hit.snippet.highlights
    .map((h) => hit.snippet.text.slice(h.start, h.end))
    .join('');
  assert.ok(joined.includes('鸿蒙笔记'), joined);
  const absStart = hit.snippet.offset + hit.snippet.highlights[0].start;
  const absEnd = hit.snippet.offset + hit.snippet.highlights[0].end;
  assert.equal(text.slice(absStart, absEnd), hit.snippet.text.slice(hit.snippet.highlights[0].start, hit.snippet.highlights[0].end));
});

test('标题加权：标题命中的笔记排在正文命中之前', async () => {
  const f = await makeFixture();
  // n1 正文命中多次；n2 仅标题命中一次
  await createNote(f, '周报', '笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记 笔记');
  const titled = await createNote(f, '季度笔记复盘', '无关内容');
  const hits = await f.search.search('笔记');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, titled.id);
  assert.ok(hits[0].score - hits[1].score >= TITLE_MATCH_BONUS - 100);
});

test('1–2 字符查询走 LIKE 兜底：双字命中，LIKE 通配符按字面处理', async () => {
  const f = await makeFixture();
  await createNote(f, '甲', '进度 5% 完成的口径');
  await createNote(f, '乙', '目标 5 成');
  const two = await f.search.search('笔记');
  assert.equal(two.length, 0);
  const sym = await createNote(f, '丙', '阅读笔记备忘');
  const twoAgain = await f.search.search('笔记');
  assert.deepEqual(twoAgain.map((h) => h.id), [sym.id]);

  // 通配符字面化：'5%' 必须按字面匹配（转义 %），不能命中"5 成"
  const pct = await f.search.search('5%');
  assert.equal(pct.length, 1);
  assert.equal(pct[0].title, '甲');
});

test('回收站排除：软删除后搜不到，恢复后重新命中（G7 无已删数据泄露）', async () => {
  const f = await makeFixture();
  const note = await createNote(f, '待删', '剪贴板权限说明');
  assert.equal((await f.search.search('剪贴板')).length, 1);
  await f.notes.softDelete(note.id);
  assert.deepEqual(await f.search.search('剪贴板'), []);
  await f.notes.restore(note.id);
  assert.equal((await f.search.search('剪贴板')).length, 1);
});

test('正文更新经触发器同步：旧词失效、新词命中（增量更新）', async () => {
  const f = await makeFixture();
  const note = await createNote(f, '原标题', '旧词内容 alpha');
  assert.equal((await f.search.search('旧词内容')).length, 1);
  await f.notes.update(note.id, '新标题', '全新口径 beta');
  assert.deepEqual(await f.search.search('旧词内容'), []);
  const hits = await f.search.search('全新口径');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '新标题');
});

test('FTS 路径对引号等特殊字符不报错（短语转义）', async () => {
  const f = await makeFixture();
  await createNote(f, 'x', '原文含有 "引号" 句子');
  const hits = await f.search.search('"引号"');
  assert.ok(Array.isArray(hits));
});

test('标签筛选与收藏筛选', async () => {
  const f = await makeFixture();
  const a = await createNote(f, 'A', '鸿蒙笔记 alpha');
  const b = await createNote(f, 'B', '鸿蒙笔记 beta');
  await createNote(f, 'C', '鸿蒙笔记 gamma');
  const tag = await f.notes.addTag(a.id, '评审');
  await f.notes.addTag(b.id, '评审');
  await f.notes.setPinned(b.id, true);

  const tagged = await f.search.search('鸿蒙笔记', { tagId: tag.id });
  assert.deepEqual(tagged.map((h) => h.id).sort(), [a.id, b.id].sort());

  const favs = await f.search.search('鸿蒙笔记', { favoritesOnly: true });
  assert.deepEqual(favs.map((h) => h.id), [b.id]);

  const both = await f.search.search('鸿蒙笔记', { tagId: tag.id, favoritesOnly: true });
  assert.deepEqual(both.map((h) => h.id), [b.id]);
});

test('标签重命名：筛选口径跟随新名；重名撞 UNIQUE 报错；空名抛错', async () => {
  const f = await makeFixture();
  const a = await createNote(f, 'A', '检索口径');
  const other = await createNote(f, 'B', '别的');
  const t1 = await f.notes.addTag(a.id, '旧名');
  await f.notes.addTag(other.id, '占用');

  const renamed = await f.notes.renameTag(t1.id, ' 新名 ');
  assert.equal(renamed.name, '新名');
  const listed = await f.notes.listAllTags();
  assert.ok(listed.some((t) => t.id === t1.id && t.name === '新名'));

  await assert.rejects(() => f.notes.renameTag(t1.id, '占用'));
  await assert.rejects(() => f.notes.renameTag(t1.id, '   '));
});

test('listByTag / listFavorites 与列表同排序口径（置顶优先）', async () => {
  const f = await makeFixture();
  const a = await createNote(f, 'A', '内容');
  const b = await createNote(f, 'B', '内容');
  const tag = await f.notes.addTag(a.id, 't');
  await f.notes.addTag(b.id, 't');
  await f.notes.setPinned(b.id, true);
  const byTag = await f.notes.listByTag(tag.id, 10);
  assert.deepEqual(byTag.map((n) => n.id), [b.id, a.id]);
  const favs = await f.notes.listFavorites(10);
  assert.deepEqual(favs.map((n) => n.id), [b.id]);
});

test('空查询与 limit<=0 返回空', async () => {
  const f = await makeFixture();
  await createNote(f, 'A', '鸿蒙笔记');
  assert.deepEqual(await f.search.search(''), []);
  assert.deepEqual(await f.search.search('   '), []);
  assert.deepEqual(await f.search.search('鸿蒙笔记', { limit: 0 }), []);
});

test('排序确定性：score 降序，同分按 id 升序', async () => {
  const f = await makeFixture();
  await transact(f.db, async () => {
    for (let i = 0; i < 5; i++) {
      await f.notes.create({ title: `n${i}`, contentMd: '相同词 口径', source: NoteSource.MANUAL });
    }
  });
  const hits = await f.search.search('相同词', { limit: 10 });
  assert.equal(hits.length, 5);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score);
    if (hits[i - 1].score === hits[i].score) {
      assert.ok(hits[i - 1].id < hits[i].id);
    }
  }
});
