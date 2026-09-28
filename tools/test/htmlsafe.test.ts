/**
 * 受控 HTML 展示域验证（S3-3；设计 §4.4 信任域分离 / G6 渲染隔离）。
 *
 * 被测对象**就是交付物本身**：common/src/main/ets/core/htmlsafe.ts（清洗器，
 * Node 直载）与 entry/src/main/resources/rawfile/htmlview/（可信壳页面，CSP 口径断言）。
 * 负向用例覆盖任务口径的恶意构造：script / iframe / meta refresh / 外联图片 /
 * 事件属性 / javascript: URL / 编码绕过 / 路径越界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CONTENT_TYPE_HTML,
  MAX_AUDIT_EVENTS,
  htmlToPlainText,
  looksLikeHtml,
  sanitizeHtml,
  tokenizeHtml,
} from '../../common/src/main/ets/core/htmlsafe';

const HTMLVIEW_DIR = path.join(__dirname, '..', '..', '..', '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'htmlview');

const SHA_A: string = 'a'.repeat(64);
const SHA_B: string = '0123456789abcdef'.repeat(4);

function kinds(html: string): string[] {
  return sanitizeHtml(html).events.map((e) => `${e.kind}:${e.detail}`);
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

test('tokenizer: 文本与标签切分，标签名小写', () => {
  const tokens = tokenizeHtml('Hi <B Class="x">bold</B>');
  assert.equal(tokens[0].type, 'text');
  const start = tokens[1];
  assert.equal(start.type, 'start');
  if (start.type === 'start') {
    assert.equal(start.name, 'b');
    assert.deepEqual(start.attrs, [{ name: 'class', value: 'x' }]);
  }
  assert.equal(tokens[3].type, 'end');
});

test('tokenizer: 裸 < 与非标签尖括号按文本处理', () => {
  const tokens = tokenizeHtml('a < 2 且 b > 1 和 c </ d');
  assert.equal(tokens.length, 1);
  if (tokens[0].type === 'text') {
    assert.equal(tokens[0].text, 'a < 2 且 b > 1 和 c </ d');
  }
});

test('tokenizer: 注释与 doctype 整体跳过', () => {
  const tokens = tokenizeHtml('<!--[if IE]><script>x()</script><![endif]--><!DOCTYPE html><p>a</p>');
  assert.equal(tokens.length, 3); // <p> a </p>
  assert.equal(tokens[0].type, 'start');
});

test('tokenizer: 无引号属性与布尔属性', () => {
  const tokens = tokenizeHtml('<td colspan=2 nowrap>x</td>');
  const start = tokens[0];
  if (start.type === 'start') {
    assert.deepEqual(start.attrs, [{ name: 'colspan', value: '2' }, { name: 'nowrap', value: undefined }]);
  }
});

// ---------------------------------------------------------------------------
// 元素白名单
// ---------------------------------------------------------------------------

test('script 整段子树丢弃并有审计', () => {
  const r = sanitizeHtml('<p>前</p><script>if (a<b) alert(1)</script><p>后</p>');
  assert.equal(r.html, '<p>前</p><p>后</p>');
  assert.deepEqual(kinds('<script>x</script>'), ['tag_removed:script']);
});

test('iframe / object / embed / svg 子树丢弃', () => {
  for (const tag of ['iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'applet']) {
    const r = sanitizeHtml(`<${tag} src="https://evil.example/x"><p>inner</p></${tag}>`);
    assert.equal(r.html, '', `${tag} 子树应整体丢弃`);
    assert.ok(r.events.some((e) => e.kind === 'tag_removed' && e.detail === tag));
  }
});

test('meta refresh 拦截（meta 不在白名单）', () => {
  const r = sanitizeHtml('<meta http-equiv="refresh" content="0;url=https://evil.example">');
  assert.equal(r.html, '');
  assert.deepEqual(r.events.map((e) => e.kind), ['tag_removed']);
  assert.equal(r.events[0].detail, 'meta');
});

test('base / link 拦截（无外链加载通道）', () => {
  const r = sanitizeHtml('<base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/a.css">');
  assert.equal(r.html, '');
  assert.ok(r.events.every((e) => e.kind === 'tag_removed'));
});

test('style 标签与 style 属性分别记 tag_removed / css_blocked', () => {
  const r = sanitizeHtml('<style>p{color:red}</style><p style="background:url(https://evil/x)">t</p>');
  assert.equal(r.html, '<p>t</p>');
  assert.ok(r.events.some((e) => e.kind === 'tag_removed' && e.detail === 'style'));
  assert.ok(r.events.some((e) => e.kind === 'css_blocked' && e.detail === 'p.style'));
});

test('head 子树丢弃（head 内的 title/meta 一并不出）', () => {
  const r = sanitizeHtml('<html><head><title>T</title><meta charset="utf-8"></head><body><p>b</p></body></html>');
  assert.equal(r.html, '<p>b</p>');
});

test('未知标签解壳保留文字（marquee → 文字保留、标签记审计）', () => {
  const r = sanitizeHtml('<marquee>hi</marquee>');
  assert.equal(r.html, 'hi');
  assert.deepEqual(r.events, [{ kind: 'tag_removed', detail: 'marquee' }]);
});

test('表单控件解壳：button 文字保留，input 标签移除', () => {
  const r = sanitizeHtml('<form action="https://evil"><button type="submit">提交</button><input name="x"></form>');
  assert.ok(r.html.includes('提交'));
  assert.ok(!r.html.includes('<form'));
  assert.ok(!r.html.includes('<input'));
  assert.ok(!r.html.includes('https://evil'));
});

test('排版标签与合法属性保留', () => {
  const r = sanitizeHtml('<h1 id="x" class="y">T</h1><table><tr><td colspan="2" nowrap>a</td></tr></table><ol start="3"><li value="4">i</li></ol>');
  assert.ok(r.html.includes('<h1>T</h1>'));
  assert.ok(r.html.includes('<td colspan="2">a</td>'));
  assert.ok(r.html.includes('<ol start="3"><li value="4">i</li></ol>'));
  // id/class/nowrap 不在白名单
  assert.ok(!r.html.includes('id='));
  assert.ok(!r.html.includes('class='));
  assert.ok(!r.html.includes('nowrap'));
});

test('数值属性拒绝非数字值', () => {
  const r = sanitizeHtml('<td colspan="2; DROP TABLE">a</td><img src="x" width="10">');
  assert.ok(!r.html.includes('DROP'));
  assert.ok(!r.html.includes('colspan'));
});

// ---------------------------------------------------------------------------
// 事件属性与 URL 协议白名单
// ---------------------------------------------------------------------------

test('on* 事件属性一律剥除并记审计', () => {
  const r = sanitizeHtml('<p onclick="x()" OnMouseOver="y">t</p><img src="x" onerror="z">');
  assert.ok(!r.html.includes('onclick'));
  assert.ok(!r.html.includes('OnMouseOver'));
  assert.ok(!r.html.includes('onerror'));
  assert.ok(r.events.some((e) => e.kind === 'attr_removed' && e.detail === 'p.onclick'));
  assert.ok(r.events.some((e) => e.kind === 'attr_removed' && e.detail === 'p.onmouseover'));
});

test('外联图片拦截：http(s) src 不产出，降级为文字', () => {
  const r = sanitizeHtml('<img src="https://evil.example/a.png" alt="示意图">');
  assert.ok(!r.html.includes('<img'));
  assert.ok(!r.html.includes('https://evil'));
  assert.equal(r.html, '[图片：示意图]');
  assert.deepEqual(r.events.map((e) => e.kind), ['url_blocked']);
});

test('无 alt 的外联图片降级为 [图片]', () => {
  const r = sanitizeHtml('<img src="http://evil/a.png">');
  assert.equal(r.html, '[图片]');
});

test('javascript:/vbscript:/data:text/html 的 img src 拦截', () => {
  for (const src of ['javascript:alert(1)', 'vbscript:x', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
    const r = sanitizeHtml(`<img src="${src}">`);
    assert.ok(!r.html.includes('<img'), src);
    assert.ok(r.events.some((e) => e.kind === 'url_blocked'), src);
  }
});

test('a.href 不保留：危险协议记 url_blocked，普通链接记 attr_removed', () => {
  const r = sanitizeHtml('<a href="https://example.com">正常</a><a href="javascript:alert(1)">坏</a>');
  assert.ok(!r.html.includes('href'));
  assert.ok(r.events.some((e) => e.kind === 'url_blocked' && e.detail.startsWith('a.href=javascript')));
  assert.ok(r.events.some((e) => e.kind === 'attr_removed' && e.detail === 'a.href'));
  assert.ok(r.html.includes('正常') && r.html.includes('坏'));
});

test('数字字符实体解码后判协议（java&#115;cript: 拦截）', () => {
  const r = sanitizeHtml('<a href="java&#115;cript:alert(1)">x</a><img src="&#106;avascript:x">');
  assert.ok(r.events.some((e) => e.kind === 'url_blocked' && e.detail.includes('javascript')));
  assert.ok(!r.html.includes('<img'));
});

test('十六进制实体与空白控制字符绕过同样拦截', () => {
  const r = sanitizeHtml('<img src="  javascript\t:alert(1)"><a href="&#x6a;avascript:x">y</a>');
  assert.ok(r.events.filter((e) => e.kind === 'url_blocked').length >= 2);
});

test('data:image 内联图允许；data:image 以外的 data: 拦截', () => {
  const ok = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
  assert.ok(ok.html.includes('<img src="data:image/png;base64,iVBORw0KGgo=">'));
  const bad = sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">');
  assert.ok(!bad.html.includes('<img'));
  assert.ok(bad.events.some((e) => e.kind === 'url_blocked'));
});

test('attachment:// 只接受 64 位十六进制摘要；越界/非十六进制一律拦截', () => {
  const ok = sanitizeHtml(`<img src="attachment://${SHA_A}">`);
  assert.ok(ok.html.includes(`src="attachment://${SHA_A}"`));
  assert.deepEqual(ok.attachmentRefs, [SHA_A]);

  for (const bad of [`attachment://../../etc/passwd`, `attachment://xyz`, `attachment://${SHA_A}/../x`, `attachment://`]) {
    const r = sanitizeHtml(`<img src="${bad}">`);
    assert.ok(!r.html.includes('src='), bad);
    assert.ok(r.events.some((e) => e.kind === 'url_blocked'), bad);
  }
});

test('attachment 引用去重收集到 attachmentRefs', () => {
  const r = sanitizeHtml(`<img src="attachment://${SHA_A}"><img src="attachment://${SHA_B}"><img src="attachment://${SHA_A}">`);
  assert.deepEqual(r.attachmentRefs, [SHA_A, SHA_B]);
});

// ---------------------------------------------------------------------------
// 输出安全性不变量
// ---------------------------------------------------------------------------

test('输出永不含脚本/事件/外部 URL（复合恶意文档）', () => {
  const evil = [
    '<!DOCTYPE html><html><head>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<script src="https://evil.example/s.js"></script>',
    '<style>@import url(https://evil.example/c.css)</style>',
    '</head><body onload="x()">',
    '<iframe src="https://evil.example"></iframe>',
    '<p onclick="y()">正文</p>',
    '<img src="https://evil.example/t.png">',
    '<a href="javascript:z()">链</a>',
    '</body></html>',
  ].join('');
  const r = sanitizeHtml(evil);
  // head 子树整体丢弃（meta/script/style 随 head 一并移除，只记 head 一条）；
  // a 标签保留为纯文本包装（V0.1 页内不导航）
  assert.equal(r.html, '<p>正文</p>[图片]<a>链</a>');
  assert.ok(!r.html.includes('http'));
  assert.ok(!r.html.includes('script'));
  assert.ok(!r.html.includes('onload'));
  assert.ok(!r.html.includes('onclick'));
  assert.ok(!r.html.includes('iframe'));
  assert.ok(!r.html.includes('meta'));
  // 顶层被拦截构造逐一有审计（嵌套在已丢弃子树内的不重复记）
  assert.ok(r.events.length >= 6, `events=${JSON.stringify(r.events)}`);
  assert.ok(r.events.every((e) => e.detail.length <= 64));
});

test('文本转义：裸尖括号转义、实体引用原样保留', () => {
  const r = sanitizeHtml('<p>1 < 2 &amp; 3 > 2 &eacute;</p>');
  assert.equal(r.html, '<p>1 &lt; 2 &amp; 3 &gt; 2 &eacute;</p>');
});

test('属性值中的引号转义，无法借属性逃逸', () => {
  const r = sanitizeHtml('<img src="data:image/png;base64,AAAA" alt=\'a"b\'>');
  assert.ok(r.html.includes('alt="a&quot;b"'));
  assert.ok(!r.html.includes('b\'>'));
});

test('游离闭合标签忽略，不破坏结构', () => {
  const r = sanitizeHtml('</div><p>a</p>');
  assert.equal(r.html, '<p>a</p>');
});

test('未闭合标签宽容处理：流末自动闭合', () => {
  const r = sanitizeHtml('<p>abc');
  assert.equal(r.html, '<p>abc</p>');
});

test('审计事件上限：海量恶意构造不撑爆事件表', () => {
  const evil: string[] = [];
  for (let i = 0; i < 500; i++) {
    evil.push(`<script>${i}</script>`);
  }
  const r = sanitizeHtml(evil.join(''));
  assert.equal(r.events.length, MAX_AUDIT_EVENTS);
});

// ---------------------------------------------------------------------------
// looksLikeHtml / htmlToPlainText
// ---------------------------------------------------------------------------

test('looksLikeHtml：doctype 与 html 前缀直接认定', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html><p>x</p>'), true);
  assert.equal(looksLikeHtml('  <html lang="zh"><body>x'), true);
});

test('looksLikeHtml：≥2 个块级标签才认定，单标签/散文不误判', () => {
  assert.equal(looksLikeHtml('<p>只有一个</p>'), false);
  assert.equal(looksLikeHtml('<div><table><tr><td>x</td></tr></table></div>'), true);
  assert.equal(looksLikeHtml('数学 a<b 且 c>d 的讨论'), false);
  assert.equal(looksLikeHtml('# 标题\n\n- 列表'), false);
});

test('looksLikeHtml：BOM 与大小写不影响判定', () => {
  assert.equal(looksLikeHtml('\uFEFF<!doctype HTML><p>x'), true);
});

test('htmlToPlainText：标签剥离、script 内容不进预览、空白折叠', () => {
  const t = htmlToPlainText('<html><head><title>T</title></head><body><h1>标题</h1><p>a<b>b</b>c</p><script>evil()</script></body></html>');
  assert.equal(t, '标题 a b c');
});

test('CONTENT_TYPE_HTML 常量口径', () => {
  assert.equal(CONTENT_TYPE_HTML, 'text/html');
});

// ---------------------------------------------------------------------------
// 可信壳（rawfile/htmlview）
// ---------------------------------------------------------------------------

test('htmlview.html：CSP 全严格（同 reader 口径 + form-action）', () => {
  const html = fs.readFileSync(path.join(HTMLVIEW_DIR, 'htmlview.html'), 'utf-8');
  const m = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, 'CSP meta 必须存在');
  const csp = m![1];
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "img-src attachment: data:",
    "connect-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(csp.includes(directive), `CSP 缺少 ${directive}`);
  }
  assert.ok(!csp.includes('unsafe-eval'));
});

test('htmlview.js：UMD 桥接 roundtrip（Node DOM 桩）', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const view = require(path.join(HTMLVIEW_DIR, 'htmlview.js')) as {
    setHtml: (json: string) => number;
    state: { renderCount: number; lastHtmlBytes: number };
  };
  let assigned: string | undefined = undefined;
  interface StubEl {
    innerHTML: string;
    textContent: string;
    children: StubEl[];
    setAttribute: (k: string, v: string) => void;
    appendChild: (el: StubEl) => void;
  }
  const makeEl = (): StubEl => {
    const el: StubEl = {
      innerHTML: '',
      textContent: '',
      children: [],
      setAttribute: (k: string, v: string): void => {
        if (k === 'data-clipnote-rendered') {
          assigned = v;
        }
      },
      appendChild: (child: StubEl): void => {
        el.children.push(child);
      },
    };
    return el;
  };
  const elements: Record<string, StubEl> = {};
  const doc = {
    getElementById: (id: string): StubEl => {
      if (elements[id] === undefined) {
        elements[id] = makeEl();
      }
      return elements[id];
    },
    createElement: (): StubEl => makeEl(),
  };
  (globalThis as Record<string, unknown>)['document'] = doc;
  try {
    const n = view.setHtml(JSON.stringify({ html: '<p>静态</p>' }));
    assert.equal(n, 1);
    assert.equal(view.state.renderCount, 1);
    assert.equal(assigned, '1');
    assert.equal(elements['content'].children.length, 1);
    assert.equal(elements['content'].children[0].innerHTML, '<p>静态</p>');
    // 重建语义：第二次渲染前先清空（textContent 置空即清栈）
    void assigned;
  } finally {
    delete (globalThis as Record<string, unknown>)['document'];
  }
});
