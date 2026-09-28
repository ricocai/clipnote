import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForSpeech,
  splitForSpeech,
  DEFAULT_SEGMENT_MAX_CHARS,
} from '../../common/src/main/ets/core/speech';

test('normalizeForSpeech 改写日期与时间（连字符/冒号是跨引擎的稳定误读点）', () => {
  assert.equal(normalizeForSpeech('2026-09-28 发布'), '2026年9月28日 发布');
  assert.equal(normalizeForSpeech('2026/09/28'), '2026年9月28日');
  assert.equal(normalizeForSpeech('12:59 开会'), '12点59分 开会');
});

test('normalizeForSpeech 不改写金额与百分比（避免双重朗读）', () => {
  assert.equal(normalizeForSpeech('营收增长 50%，约 3.5 亿元'), '营收增长 50%，约 3.5 亿元');
});

test('normalizeForSpeech 在中英边界插空格，帮助引擎分词', () => {
  assert.equal(normalizeForSpeech('用ArkTS写鸿蒙应用'), '用 ArkTS 写鸿蒙应用');
});

test('normalizeForSpeech 清理零宽字符与多余空白', () => {
  assert.equal(normalizeForSpeech('前\u200b面   有  空格'), '前面 有 空格');
  assert.equal(normalizeForSpeech('行1\n\n\n\n行2'), '行1\n\n行2');
});

test('normalizeForSpeech 可保留代码块的空白结构', () => {
  const code = 'function a() {\n    return  1;\n}';
  assert.equal(normalizeForSpeech(code, { preserveWhitespace: true }), code);
});

test('splitForSpeech 按中文句末标点切分', () => {
  const segs = splitForSpeech('第一句。第二句！第三句？');
  assert.deepEqual(segs.map((s) => s.text), ['第一句。', '第二句！', '第三句？']);
  assert.deepEqual(segs.map((s) => s.index), [0, 1, 2]);
});

test('splitForSpeech 不把小数与英文缩写切成两句', () => {
  const segs = splitForSpeech('圆周率约 3.14 左右。See e.g. Fig. 2 for details. 结束。');
  assert.equal(segs.length, 3, JSON.stringify(segs.map((s) => s.text)));
  assert.ok(segs[0].text.startsWith('圆周率约 3.14'));
  assert.ok(segs[1].text.includes('e.g.'));
  assert.ok(segs[1].text.includes('Fig. 2'));
});

test('splitForSpeech 段落偏移可用于把播放进度回映射到文档块', () => {
  const text = '第一句。第二句。';
  const segs = splitForSpeech(text);
  for (const s of segs) {
    assert.equal(text.slice(s.startOffset, s.endOffset).trim(), s.text);
  }
});

test('splitForSpeech 对超长无标点串硬切，保证有界内存与低首包延迟', () => {
  const long = '字'.repeat(1000);
  const segs = splitForSpeech(long, 300);
  assert.ok(segs.length >= 4, `段数 ${segs.length}`);
  for (const s of segs) {
    assert.ok(s.charCount <= 300, `段长 ${s.charCount}`);
  }
  assert.equal(segs.map((s) => s.text).join(''), long, '硬切不得丢字');
});

test('splitForSpeech 优先在逗号等软切点断开', () => {
  const sentence = `${'甲'.repeat(120)}，${'乙'.repeat(120)}，${'丙'.repeat(120)}。`;
  const segs = splitForSpeech(sentence, 300);
  const first = segs[0];
  assert.ok(first.charCount <= 300);
  assert.ok(first.text.endsWith('，'), `首段应以软切点结束: ${first.text.slice(-5)}`);
});

test('splitForSpeech 不产出空段，且默认上限为 300', () => {
  const segs = splitForSpeech('第一句。。。\n\n第二句。');
  for (const s of segs) {
    assert.ok(s.text.trim().length > 0);
  }
  assert.equal(DEFAULT_SEGMENT_MAX_CHARS, 300);
});
