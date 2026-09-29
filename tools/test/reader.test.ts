/**
 * MD 阅读域验证（S3-2；设计 §4.3 / §4.4 / G6）。
 *
 * 被测对象**就是交付物本身**：entry/src/main/resources/rawfile/reader/ 下的
 * reader.js（Node require 直载，UMD）与 reader.html（CSP 口径断言）。
 * 这里不是镜像测试 —— 浏览器里跑的与本机跑的同一份文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';

import { parseDocument, mdTokensFromJson, IMarkdownTokenizer } from '../../common/src/main/ets/core/markdown';
import { DocumentBlock } from '../../common/src/main/ets/core/model';
import { MarkdownItTokenizer } from './support/platform';

const READER_DIR = path.join(__dirname, '..', '..', '..', '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'reader');

// reader.js 是 UMD：Node 下走 module.exports；markdown-it 也由 Node 注入全局
// （浏览器里由 markdown-it.min.js 的 UMD 头注入，同一个函数签名）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reader = require(path.join(READER_DIR, 'reader.js')) as {
  escapeHtml: (s: string) => string;
  tokenize: (source: string) => string;
  buildReaderHtml: (blocks: DocumentBlock[], markdown: string) => string;
  highlight: (blockIndex: number) => void;
};
(globalThis as Record<string, unknown>)['markdownit'] = MarkdownIt;

const tokenizer: IMarkdownTokenizer = new MarkdownItTokenizer(new MarkdownIt({ html: true }));

const SHA = 'c'.repeat(64);

function parse(md: string): DocumentBlock[] {
  return parseDocument(tokenizer, md, { docRevision: 1 });
}

function render(md: string): string {
  return reader.buildReaderHtml(parse(md), md);
}

// ---------------------------------------------------------------------------
// 桥接 Schema：reader.js tokenize → mdTokensFromJson → parseDocument 全链路
// ---------------------------------------------------------------------------

test('ArkWeb 桥接全链路：reader.js tokenize 与真实 markdown-it 直出产出同一块模型', () => {
  const md = [
    '# 标题',
    '',
    '正文 **加粗**、`行内代码`。',
    '',
    '- 甲',
    '- 乙',
    '',
    `![示意图](${'attachment://'}${SHA})`,
    '',
    '> 引用一行',
    '',
    '```ts',
    'const a = 1;',
    '```',
  ].join('\n');
  const direct = parse(md);
  const viaBridge = parseDocument(
    { parse: () => mdTokensFromJson(reader.tokenize(md)) },
    md,
    { docRevision: 1 },
  );
  assert.deepEqual(viaBridge, direct);
  assert.ok(viaBridge.some((b) => b.attachmentRef === SHA));
});

test('桥接配置：html:false —— 原始 HTML 不会以 html token 进入块模型', () => {
  const md = '<script>alert(1)</script>\n\n段落。';
  const payload = JSON.parse(reader.tokenize(md));
  const types = payload.map((t: { type: string }) => t.type);
  assert.ok(!types.includes('html_block'), 'html:false 时 markdown-it 不产生 html_block');
  assert.ok(!types.includes('html_inline'));
});

// ---------------------------------------------------------------------------
// G6 渲染隔离：转义、附件白名单、远程资源收敛
// ---------------------------------------------------------------------------

test('G6：脚本注入尝试被全量转义，输出不存在可执行标签/事件', () => {
  const md = '正文 <script>alert(1)</script> <img src=x onerror=alert(2)> 结束。';
  // 走真实桥接配置（html:false）：原始 HTML 是文本，必须被转义而不是丢弃或执行
  const blocks = parseDocument({ parse: () => mdTokensFromJson(reader.tokenize(md)) }, md, { docRevision: 1 });
  const html = reader.buildReaderHtml(blocks, md);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('结束。'));
});

test('G6：RAW 降级块（未覆盖语法）按转义原文展示，绝不当 HTML 解释', () => {
  const md = '<div class="x">块级 HTML</div>\n\n正常段落。';
  const html = render(md);
  const rawPart = html.split('\n').find((line) => line.includes('cl-raw')) as string;
  assert.ok(rawPart.includes('&lt;div'));
  assert.ok(!rawPart.includes('<div class'));
  assert.ok(html.includes('>正常段落。</p>'));
  assert.ok(/<p data-cl-i="\d+">正常段落。<\/p>/.test(html), '段落应带朗读锚点（S5-2）');
});

test('G6：图片只接受合法 sha256 附件摘要；非法引用给占位且不发请求', () => {
  const good = render(`![图](${'attachment://'}${SHA})`);
  assert.ok(good.includes(`src="${'attachment://'}${SHA}"`));

  const badRef = parseDocument(tokenizer, '![图](attachment://not-a-sha)', { docRevision: 1 });
  const htmlBad = reader.buildReaderHtml(badRef, '![图](attachment://not-a-sha)');
  assert.ok(!htmlBad.includes('<img'));
  assert.ok(htmlBad.includes('[图片]'));

  // 块模型没带 attachmentRef、只有远程 imageSrc 时（外链图），同样不得产生请求
  const noRef = parseDocument(tokenizer, '![图](https://evil.example/a.png)', { docRevision: 1 });
  const htmlNoRef = reader.buildReaderHtml(noRef, '![图](https://evil.example/a.png)');
  assert.ok(!htmlNoRef.includes('<img'));
  assert.ok(!htmlNoRef.includes('http'));
});

test('G6：渲染输出永远不含 http(s) 链接（默认离线，链接语法只留文字）', () => {
  const md = '[钓鱼链接](https://evil.example/) 与 ![远程图](https://evil.example/x.png)\n\n正文。';
  const html = render(md);
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(html.includes('钓鱼链接'));
});

test('渲染：连续 LIST_ITEM 合并为单个 <ul>；标题层级正确', () => {
  const html = render('# H1\n\n- 甲\n- 乙\n- 丙\n\n正文。');
  assert.equal((html.match(/<ul[ >]/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.ok(html.includes('data-cl-i="0">H1</h1>'), '标题应带朗读锚点且为首个块（S5-2）');
  assert.ok(html.includes('>正文。</p>'));
});

test('渲染：fence 代码块剥围栏行、语言作 data-lang；缩进代码块保原文', () => {
  const fenced = render('```ts\nconst a = 1;\n\nconst b = 2;\n```');
  assert.ok(fenced.includes('data-lang="ts"'));
  assert.ok(fenced.includes('const a = 1;'));
  assert.ok(!fenced.includes('```'));

  const indented = render('    缩进代码\n      更多缩进');
  assert.ok(indented.includes('缩进代码'));
  assert.ok(indented.includes('更多缩进'));
  assert.ok(!indented.includes('data-lang="ts"'));
});

test('渲染：引用/表格整段原文展示且换行保留', () => {
  const md = '> 第一行\n> 第二行\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const html = render(md);
  // 引用块按"整段原文"口径保留（含 > 标记，同表格），换行保留
  assert.ok(html.includes('data-cl-i=') && html.includes('&gt; 第一行<br>&gt; 第二行</blockquote>'));
  assert.ok(html.includes('cl-table'));
  assert.ok(html.includes('| a | b |'));
});

test('渲染：空文档/纯分隔线不产出正文标签', () => {
  assert.equal(render('').trim(), '');
  const html = render('---');
  assert.ok(!html.includes('<p>'));
  assert.ok(html.includes('<hr data-cl-i='));
});

// ---------------------------------------------------------------------------
// reader.html CSP 口径（可信域分离的静态断言）
// ---------------------------------------------------------------------------

test('CSP：script-src 仅 self（无 inline/eval），img-src 仅 attachment/data，默认全断', () => {
  const html = fs.readFileSync(path.join(READER_DIR, 'reader.html'), 'utf8');
  const csp = /Content-Security-Policy"?\s+content="([^"]+)"/.exec(html);
  assert.ok(csp, 'reader.html 必须内联 CSP');
  const policy = csp[1];
  // script-src 单独断言：style-src 允许 'unsafe-inline'（仅本页内联样式），
  // 脚本面必须严格 'self'（禁 inline/eval）
  const scriptSrc = /script-src ([^;]+)/.exec(policy) as RegExpExecArray;
  assert.ok(scriptSrc[1].includes("'self'"));
  assert.ok(!scriptSrc[1].includes('unsafe-inline'));
  assert.ok(!scriptSrc[1].includes('unsafe-eval'));
  assert.ok(policy.includes('img-src attachment: data:'));
  assert.ok(policy.includes("default-src 'none'"));
  assert.ok(policy.includes("connect-src 'none'"));
  assert.ok(policy.includes("object-src 'none'"));
  assert.ok(policy.includes("base-uri 'none'"));
});

test('CSP：页面资产全部包内脚本（无内联 script 块）', () => {
  const html = fs.readFileSync(path.join(READER_DIR, 'reader.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'));
  assert.ok(!body.includes('<script>'), 'body 内不得有内联 <script>（CSP script-src self 口径）');
  for (const asset of ['markdown-it.min.js', 'reader.js', 'bridge.js']) {
    assert.ok(body.includes(`src="${asset}"`), `缺少包内脚本 ${asset}`);
  }
});

// ---------------------------------------------------------------------------
// S5-2 朗读高亮锚点（data-cl-i）与 highlight() 导出
// ---------------------------------------------------------------------------

test('朗读高亮：每个顶层元素带 data-cl-i 锚点，值=源块下标', () => {
  const md = ['# 标题', '', '段落一。', '', '- 甲', '- 乙', '', '> 引用', '', '```ts', 'x', '```', '', '---'].join('\n');
  const html = render(md);
  // 带锚点的行 = 顶层元素（</ul> 等闭合行无锚点，天然排除）
  const anchored = html.split('\n').filter((l: string) => l.includes('data-cl-i='));
  assert.equal(anchored.length, 6, '6 个顶层元素（ul 合并两条列表）');
  const seen: number[] = anchored.map((l: string) => Number(/data-cl-i="(\d+)"/.exec(l)![1]));
  // 锚点即源块下标：合并的 <ul> 取首条列表项下标（2），其后顺延
  assert.deepEqual(seen, [0, 1, 2, 4, 5, 6]);
});

test('朗读高亮：highlight 导出为函数（无 DOM 环境可安全调用为空操作）', () => {
  assert.equal(typeof reader.highlight, 'function');
  // Node 下无 document：必须静默返回而不是抛错（ArkWeb 注入前也不会被调用）
  assert.doesNotThrow(() => (reader.highlight as (n: number) => void)(0));
  assert.doesNotThrow(() => (reader.highlight as (n: number) => void)(-1));
});
