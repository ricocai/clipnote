import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  needsScanFallback,
  tokenize,
  tokenizeQuery,
  termsOf,
} from '../../common/src/main/ets/core/search/tokenizer';
import { InvertedIndex, mergeRanges } from '../../common/src/main/ets/core/search/inverted-index';

test('tokenize 中文按 2-gram 切分并保留原文偏移', () => {
  const text = '鸿蒙笔记应用';
  const spans = tokenize(text);
  const terms = spans.map((s) => s.term);
  assert.deepEqual(terms, ['鸿蒙', '蒙笔', '笔记', '记应', '应用']);
  const note = spans.find((s) => s.term === '笔记');
  assert.equal(note?.start, 2);
  assert.equal(note?.end, 4);
  assert.equal(text.slice(2, 4), '笔记');
});

test('tokenize 英文/数字按整词小写，标点自成边界', () => {
  assert.deepEqual(termsOf('ArkTS 5.0 很快'), ['arkts', '5', '0', '很快']);
});

test('tokenize 不跨标点生成 gram（避免把"甲。乙"当成"甲乙"）', () => {
  const terms = termsOf('甲。乙');
  assert.ok(!terms.includes('甲乙'), terms.join(','));
});

test('tokenize emoji 按码点成词，可被检索', () => {
  const terms = termsOf('今天不错🙂很好');
  assert.ok(terms.includes('🙂'), terms.join(','));
});

test('needsScanFallback 只对单个 CJK 码点返回 true', () => {
  assert.equal(needsScanFallback(['笔']), true);
  assert.equal(needsScanFallback(['笔记']), false);
  assert.equal(needsScanFallback(['a']), false);
  assert.equal(needsScanFallback(['🙂']), false);
});

test('tokenizeQuery 去重且保序（长串 query 会产出多组 gram）', () => {
  assert.deepEqual(tokenizeQuery('笔记记录'), ['笔记', '记记', '记录']);
  assert.deepEqual(tokenizeQuery('笔记笔记'), ['笔记', '记笔']);
  assert.deepEqual(tokenizeQuery('arkts ArkTS'), ['arkts']);
});

function buildIndex(docs: Array<[string, string]>): InvertedIndex {
  const idx = new InvertedIndex();
  for (const [id, text] of docs) {
    idx.put({ id, text });
  }
  return idx;
}

test('中文短语检索：全 gram 命中即等价于连续片段匹配', () => {
  const idx = buildIndex([
    ['n1', '鸿蒙笔记应用支持 Markdown 渲染'],
    ['n2', '这是一条无关的备忘'],
    ['n3', '鸿蒙系统的剪贴板权限说明'],
  ]);
  const hits = idx.search('笔记应用');
  assert.deepEqual(hits.map((h) => h.id), ['n1']);
  assert.equal(hits[0].coverage, 1);
  // 2-gram 天然重叠，高亮区间必须合并为整段短语
  const snip = hits[0].snippet;
  assert.equal(snip.text.slice(snip.highlights[0].start, snip.highlights[0].end), '笔记应用');
  assert.deepEqual(snip.highlights, [{ start: 2, end: 6 }]);
});

test('不相关的 gram 组合不得产生命中（防止把两段无关文字拼成短语）', () => {
  const idx = buildIndex([
    ['n1', '鸿蒙笔记应用'],
    ['n2', '鸿蒙 系统的 应用 商店'],
  ]);
  const hits = idx.search('蒙笔');
  assert.deepEqual(hits.map((h) => h.id), ['n1']);
});

test('单字查询走受限扫描降级路径并命中', () => {
  const idx = buildIndex([
    ['n1', '鸿蒙笔记应用'],
    ['n2', '没有那个字'],
  ]);
  const hits = idx.search('笔');
  assert.deepEqual(hits.map((h) => h.id), ['n1']);
  assert.deepEqual(hits[0].matchedTerms, ['笔']);
});

test('受限扫描的有界性：maxScanDocs 生效时不越界读取', () => {
  const idx = buildIndex([
    ['n1', '甲'],
    ['n2', '乙'],
    ['n3', '丙'],
  ]);
  const hits = idx.search('乙', { maxScanDocs: 1 });
  assert.deepEqual(hits, [], '扫描上限为 1 时不应看到后续文档');
});

test('英文大小写不敏感、中英混合 AND 语义成立', () => {
  const idx = buildIndex([
    ['n1', 'ArkTS 性能调优记录'],
    ['n2', 'arkts 与 typescript 的关系'],
  ]);
  const cn = idx.search('性能');
  assert.deepEqual(cn.map((h) => h.id), ['n1']);
  const mixed = idx.search('arkts 调优');
  assert.deepEqual(mixed.map((h) => h.id), ['n1']);
});

test('长查询按 70% 覆盖率降级召回，短查询等价 AND', () => {
  const idx = buildIndex([
    ['n1', '鸿蒙笔记应用支持中文全文检索与标签组织'],
  ]);
  // 5 个 gram，minMatch = ceil(5*0.7) = 4
  const soft = idx.search('笔记应用支持检索');
  assert.equal(soft.length, 1);
  assert.ok(soft[0].coverage >= 0.7 && soft[0].coverage <= 1);
  // 完全无关不得命中
  assert.deepEqual(idx.search('量子计算芯片'), []);
});

test('命中区间合并：重叠 gram 合并为一段高亮', () => {
  const merged = mergeRanges([
    { start: 2, end: 4 },
    { start: 3, end: 5 },
    { start: 10, end: 12 },
  ]);
  assert.deepEqual(merged, [
    { start: 2, end: 5 },
    { start: 10, end: 12 },
  ]);
});

test('高亮映射指向原文偏移（供屏幕/朗读/导出复用同一份区间）', () => {
  const text = '前面的铺垫很长很长很长，鸿蒙笔记应用出现得很靠后，后面还有内容。';
  const idx = buildIndex([['n1', text]]);
  const hits = idx.search('笔记');
  assert.equal(hits.length, 1);
  const s = hits[0].snippet;
  assert.equal(text.slice(s.offset + s.highlights[0].start, s.offset + s.highlights[0].end), '笔记');
});

test('删除与更新后索引同步（已删数据不得泄露）', () => {
  const idx = buildIndex([
    ['n1', '鸿蒙笔记'],
    ['n2', '鸿蒙笔记'],
  ]);
  assert.equal(idx.search('笔记').length, 2);
  assert.equal(idx.remove('n1'), true);
  assert.equal(idx.remove('n1'), false);
  const left = idx.search('笔记');
  assert.deepEqual(left.map((h) => h.id), ['n2']);
  assert.equal(idx.size, 1);

  idx.put({ id: 'n2', text: '改成别的内容' });
  assert.deepEqual(idx.search('笔记'), [], '更新后旧 gram 必须失效');
  assert.equal(idx.search('别的内容').length, 1);
});

test('索引观测指标可用于评估膨胀', () => {
  const idx = buildIndex([['n1', '鸿蒙笔记应用']]);
  assert.ok(idx.termCount >= 4, `termCount=${idx.termCount}`);
  assert.equal(idx.postingCount, idx.termCount);
  idx.clear();
  assert.equal(idx.size, 0);
  assert.equal(idx.termCount, 0);
});

test('空查询与 limit<=0 返回空，不抛异常', () => {
  const idx = buildIndex([['n1', '鸿蒙笔记']]);
  assert.deepEqual(idx.search(''), []);
  assert.deepEqual(idx.search('   '), []);
  assert.deepEqual(idx.search('笔记', { limit: 0 }), []);
});
