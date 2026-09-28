import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';

import {
  parseDocument,
  extractPlainText,
  computeLineStarts,
  attachmentRefOf,
  attachmentVirtualPath,
  ATTACHMENT_SCHEME,
  IMarkdownTokenizer,
  mdTokensFromJson,
} from '../../common/src/main/ets/core/markdown';
import { BlockType, DocumentBlock } from '../../common/src/main/ets/core/model';
import { MarkdownItTokenizer } from './support/platform';

const SHA = 'c'.repeat(64);
const tokenizer: IMarkdownTokenizer = new MarkdownItTokenizer(new MarkdownIt({ html: true }));

function parse(md: string, revision = 1): DocumentBlock[] {
  return parseDocument(tokenizer, md, { docRevision: revision });
}

function types(blocks: readonly DocumentBlock[]): string[] {
  return blocks.map((b) => b.type as string);
}

test('computeLineStarts 给出每行起始偏移', () => {
  assert.deepEqual(computeLineStarts('a\nbb\nccc'), [0, 2, 5]);
});

test('标题：层级与源范围正确', () => {
  const md = '# 一级标题\n\n## 二级标题\n\n正文段落。';
  const blocks = parse(md);
  assert.equal(blocks[0].type, BlockType.HEADING);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].text, '一级标题');
  assert.deepEqual([blocks[0].range.startLine, blocks[0].range.endLine], [0, 1]);
  assert.equal(md.slice(blocks[0].range.startOffset, blocks[0].range.endOffset), '# 一级标题\n');
  assert.equal(blocks[1].level, 2);
  assert.equal(blocks[2].type, BlockType.PARAGRAPH);
  assert.equal(blocks[2].text, '正文段落。');
});

test('代码块：保留原始缩进与空行（不得粗暴规范化）', () => {
  const md = ['```ts', 'function a() {', '', '    return  1;', '}', '```'].join('\n');
  const blocks = parse(md);
  const code = blocks.find((b) => b.type === BlockType.CODE) as DocumentBlock;
  assert.ok(code, '应产出 CODE 块');
  assert.equal(code.text, 'ts\nfunction a() {\n\n    return  1;\n}');
});

test('缩进式代码块（code_block）内容取原文切片', () => {
  const md = '    缩进代码 line1\n    缩进代码 line2';
  const blocks = parse(md);
  const code = blocks.find((b) => b.type === BlockType.CODE) as DocumentBlock;
  assert.equal(code.text, md, '缩进式代码块按原文切片，缩进必须原样保留');
});

test('表格整段保留原文（单元格边界不被改动）', () => {
  const md = '| 指标  | 2026H1 |\n|---|---|\n| 营收  | 100 |';
  const blocks = parse(md);
  const table = blocks.find((b) => b.type === BlockType.TABLE) as DocumentBlock;
  assert.ok(table);
  assert.equal(table.text, md);
});

test('引用块整段保留原文', () => {
  const md = '> 引用第一行\n> 引用第二行';
  const blocks = parse(md);
  const quote = blocks.find((b) => b.type === BlockType.QUOTE) as DocumentBlock;
  assert.ok(quote);
  assert.equal(quote.text, md);
  assert.deepEqual(types(blocks), [BlockType.QUOTE as string]);
});

test('列表项被识别为 LIST_ITEM，而不是普通段落', () => {
  const md = '- 第一项\n- 第二项\n';
  const blocks = parse(md);
  assert.deepEqual(types(blocks), [BlockType.LIST_ITEM as string, BlockType.LIST_ITEM as string]);
  assert.deepEqual(blocks.map((b) => b.text), ['第一项', '第二项']);
});

test('图片：解析出附件引用（内容寻址）；外链图片不产生附件引用', () => {
  const md = `![截图](${ATTACHMENT_SCHEME}${SHA})\n\n![头像](https://example.com/a.png)`;
  const blocks = parse(md);
  const img = blocks[0];
  assert.equal(img.type, BlockType.IMAGE);
  assert.equal(img.attachmentRef, SHA);
  assert.equal(img.text, '截图', 'alt 进入朗读/索引文本，避免整张图被跳过');
  assert.equal(blocks[1].attachmentRef, undefined);
  assert.equal(attachmentVirtualPath(SHA), `blobs/cc/cc/${SHA}`);
});

test('attachmentRefOf 只接受合法摘要，不把任意路径当附件', () => {
  assert.equal(attachmentRefOf(`${ATTACHMENT_SCHEME}${SHA}`), SHA);
  assert.equal(attachmentRefOf(`blobs/cc/cc/${SHA}`), SHA);
  assert.equal(attachmentRefOf(`${ATTACHMENT_SCHEME}not-a-sha`), undefined);
  assert.equal(attachmentRefOf('https://example.com/a.png'), undefined);
  assert.equal(attachmentRefOf('../../etc/passwd'), undefined);
});

test('原始 HTML 降级为 RAW 且不执行（负向用例）', () => {
  const md = '<script>alert(1)</script>\n\n正常段落。';
  const blocks = parse(md);
  const raw = blocks[0];
  assert.equal(raw.type, BlockType.RAW);
  assert.equal(raw.text, '<script>alert(1)</script>');
  assert.equal(blocks[1].type, BlockType.PARAGRAPH);
  assert.ok(!extractPlainText(blocks, true).includes('alert(1)'), 'READ 原文不得进入朗读/检索文本');
});

test('分隔线产出 THEMATIC_BREAK', () => {
  const blocks = parse('段落一\n\n---\n\n段落二');
  assert.ok(types(blocks).includes(BlockType.THEMATIC_BREAK as string));
});

test('块 ID 只在同一 revision 内稳定；跨 revision 必须变化', () => {
  const md = '# 标题\n\n正文';
  const a1 = parse(md, 1);
  const a2 = parse(md, 1);
  const b = parse(md, 2);
  assert.deepEqual(a1.map((x) => x.id), a2.map((x) => x.id));
  assert.notDeepEqual(a1.map((x) => x.id), b.map((x) => x.id));
  assert.ok(a1.every((x) => x.docRevision === 1));
  assert.ok(b.every((x) => x.docRevision === 2));
});

test('块 ID 全局唯一（同一 revision 内）', () => {
  const md = '# a\n\nb\n\n- c\n- d\n\n> e\n\n```\nf\n```\n\n---';
  const blocks = parse(md, 7);
  const ids = new Set(blocks.map((b) => b.id));
  assert.equal(ids.size, blocks.length);
});

test('extractPlainText 复用块模型，供朗读/检索/导出一致使用', () => {
  const md = '# 标题\n\n正文内容。\n\n```ts\nconst a = 1;\n```\n\n---\n\n结尾。';
  const blocks = parse(md);
  const withCode = extractPlainText(blocks, true);
  const withoutCode = extractPlainText(blocks, false);
  assert.ok(withCode.includes('const a = 1;'));
  assert.ok(!withoutCode.includes('const a = 1;'));
  assert.ok(!withoutCode.includes('---'));
  assert.ok(withoutCode.includes('标题') && withoutCode.includes('结尾。'));
});

test('未覆盖语法在 keepRawBlocks=false 时被丢弃而不报错', () => {
  const md = '<div>块级 HTML</div>\n\n段落。';
  const blocks = parseDocument(tokenizer, md, { docRevision: 1, keepRawBlocks: false });
  assert.deepEqual(types(blocks), [BlockType.PARAGRAPH as string]);
});

test('空文档产出空块列表', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('\n\n'), []);
});

test('mdTokensFromJson：桥接 JSON 往返与真实 markdown-it 直出等价（S3-2 桥接 Schema）', () => {
  const md = '# 标题\n\n正文 **加粗** 与 `代码`。\n\n- 甲\n- 乙\n\n![图](attachment://' + SHA + ')\n\n> 引用\n\n```ts\nconst a = 1;\n```';
  // 模拟桥接：真实 markdown-it 产出 → JSON 序列化（reader.js slimToken 同构）→ 还原
  const direct = parseDocument(tokenizer, md, { docRevision: 3 });
  const rawTokens = (tokenizer as unknown as { parse: (s: string) => unknown[] }).parse(md);
  const restored = mdTokensFromJson(JSON.stringify(rawTokens));
  const viaBridge = parseDocument({ parse: () => restored }, md, { docRevision: 3 });
  assert.deepEqual(viaBridge, direct);
});

test('mdTokensFromJson：字段缺失给缺省值而不是抛错（桥接两侧版本演进容忍）', () => {
  const payload = JSON.stringify([{ type: 'paragraph_open' }, { type: 'inline', content: 'x', children: null }]);
  const tokens = mdTokensFromJson(payload);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].tag, '');
  assert.equal(tokens[0].nesting, 0);
  assert.equal(tokens[0].map, null);
  assert.equal(tokens[1].children, null);
});

test('mdTokensFromJson：非数组负载抛错（桥接故障不得静默成"空文档"）', () => {
  assert.throws(() => mdTokensFromJson('{}'), /not an array/);
  assert.throws(() => mdTokensFromJson('null'), /not an array/);
});
