/**
 * 不可信 HTML 静态化清洗（S3-3；设计 §4.4 信任域分离 / G6 渲染隔离）。
 *
 * 定位：导入/采集到的 HTML 一律视为不可信内容。本模块把它清洗成**纯静态展示子集**
 * —— 无脚本、无事件属性、无 iframe/表单/重定向、无外部资源引用 —— 之后才可进入
 * 受控展示页（entry pages/HtmlRead + rawfile/htmlview 可信壳）。展示页另有
 * javaScriptAccess(false) 与 CSP 纵深防御（三道防线互不依赖）。
 *
 * 清洗口径（§4.4 逐条落地）：
 *  - 信任域分离：清洗在 ArkTS 侧完成（本文件），可信壳内不再执行任何内容脚本；
 *  - 元素白名单：只允许排版语义标签；script/style/svg/math/iframe/object 等
 *    「整段子树丢弃」（内容一并丢弃，连 fallback 文本都不留）；
 *    未知标签**解壳保留子节点**（文字不丢），meta/link/base 等空标签直接移除；
 *  - 事件属性 on* 一律剥除；style 属性一律剥除（CSS URL 通道随 style 一并关闭）；
 *  - URL 协议白名单：仅 attachment://<64hex>（本篇附件，授权由调用方核对）与
 *    data:image/*;base64；javascript:/vbscript:/data:text/html 及一切外部
 *    http(s) 引用全部拦截；数字字符实体解码后再判协议（防 `java&#115;cript:`）；
 *  - 拒绝 `..` 与编码变体：attachment 引用只接受内容摘要派生形态（sha256 寻址，
 *    天然无路径概念），非 64 位十六进制一律拦截；
 *  - 审计：每个被拦截的构造产生一条 HtmlAuditEvent（类别 + 截断细节，不记正文），
 *    由调用方写入 ILogger（设计 §4.5.5 审计口径）。
 *
 * 纯函数、平台无关：无 @ohos/@kit/Node 依赖，由 tools/ 本机用例直载验证。
 */

import { ATTACHMENT_SCHEME, attachmentRefOf } from './markdown';

/** HTML 笔记的内容类型标记（Note.contentType；数据层默认 'text/markdown'） */
export const CONTENT_TYPE_HTML: string = 'text/html';

export type HtmlBlockKind = 'tag_removed' | 'attr_removed' | 'url_blocked' | 'css_blocked';

/** 单个被拦截构造的审计记录；detail 已截断（≤64 字符），不含正文 */
export interface HtmlAuditEvent {
  readonly kind: HtmlBlockKind;
  readonly detail: string;
}

export interface HtmlSanitizeResult {
  /** 清洗后的静态 HTML（只含白名单标签与转义文本，可直接 innerHTML 进受控壳） */
  readonly html: string;
  readonly events: HtmlAuditEvent[];
  /** 清洗后文档引用到的 attachment:// 摘要（格式已校验；是否本篇授权由调用方核对） */
  readonly attachmentRefs: string[];
}

/** 审计事件上限：防恶意文档用海量事件撑爆日志（超出后静默不再记录，清洗本身不受影响） */
export const MAX_AUDIT_EVENTS: number = 200;

/** 审计细节截断长度（设计 §4.5.5：审计不记正文，URL/构造名截断保留） */
const MAX_DETAIL_CHARS: number = 64;

/** 判定 HTML 文档时扫描的前缀长度 */
const LOOKAHEAD_CHARS: number = 4096;

// ---------------------------------------------------------------------------
// 词法（tokenizer）：宽容解析，产出 token 流；不做任何安全决策
// ---------------------------------------------------------------------------

export type HtmlToken =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'start';
      readonly name: string; // 小写
      readonly attrs: Array<{ readonly name: string; readonly value: string | undefined }>; // name 小写
      readonly selfClose: boolean;
    }
  | { readonly type: 'end'; readonly name: string }; // 小写

function isAsciiLetter(ch: string): boolean {
  const c: number = ch.charCodeAt(0);
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isVoidName(name: string): boolean {
  switch (name) {
    case 'area':
    case 'base':
    case 'br':
    case 'col':
    case 'embed':
    case 'hr':
    case 'img':
    case 'input':
    case 'link':
    case 'meta':
    case 'param':
    case 'source':
    case 'track':
    case 'wbr':
      return true;
    default:
      return false;
  }
}

/**
 * 把输入切成 token 流。宽容口径贴近浏览器：`<` 后非字母/!// 一律按文本；
 * 注释与 `<!...>`/`<?...>` 声明整体跳过；属性支持引号值与无引号值。
 * 不处理 raw-text 元素（script 等）的特殊语义 —— 那是清洗层的子树丢弃职责。
 */
export function tokenizeHtml(input: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const n: number = input.length;
  let i: number = 0;
  let textStart: number = 0;
  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ type: 'text', text: input.slice(textStart, end) });
    }
  };
  while (i < n) {
    const ch: string = input.charAt(i);
    if (ch !== '<') {
      i++;
      continue;
    }
    const next: string = i + 1 < n ? input.charAt(i + 1) : '';
    if (isAsciiLetter(next)) {
      // 起始标签：<name ...> 或 <name .../>
      flushText(i);
      let j: number = i + 1;
      const nameStart: number = j;
      while (j < n && !isWhitespace(input.charAt(j)) && input.charAt(j) !== '/' && input.charAt(j) !== '>') {
        j++;
      }
      const name: string = input.slice(nameStart, j).toLowerCase();
      const attrs: Array<{ name: string; value: string | undefined }> = [];
      let selfClose: boolean = false;
      let closed: boolean = false;
      while (j < n && !closed) {
        while (j < n && isWhitespace(input.charAt(j))) {
          j++;
        }
        if (j >= n) {
          break;
        }
        const c: string = input.charAt(j);
        if (c === '>') {
          j++;
          closed = true;
          break;
        }
        if (c === '/') {
          // 仅当紧随其后是 > 才算自闭合；否则 / 是无名属性的一部分（宽容跳过）
          if (j + 1 < n && input.charAt(j + 1) === '>') {
            selfClose = true;
            j += 2;
            closed = true;
            break;
          }
          j++;
          continue;
        }
        // 属性名
        const attrStart: number = j;
        while (j < n && !isWhitespace(input.charAt(j)) && input.charAt(j) !== '=' &&
               input.charAt(j) !== '/' && input.charAt(j) !== '>') {
          j++;
        }
        const attrName: string = input.slice(attrStart, j).toLowerCase();
        while (j < n && isWhitespace(input.charAt(j))) {
          j++;
        }
        let attrValue: string | undefined = undefined;
        if (j < n && input.charAt(j) === '=') {
          j++;
          while (j < n && isWhitespace(input.charAt(j))) {
            j++;
          }
          if (j < n && (input.charAt(j) === '"' || input.charAt(j) === "'")) {
            const quote: string = input.charAt(j);
            const valueStart: number = j + 1;
            const closeQuote: number = input.indexOf(quote, valueStart);
            if (closeQuote === -1) {
              attrValue = input.slice(valueStart);
              j = n;
            } else {
              attrValue = input.slice(valueStart, closeQuote);
              j = closeQuote + 1;
            }
          } else {
            const valueStart: number = j;
            while (j < n && !isWhitespace(input.charAt(j)) && input.charAt(j) !== '>') {
              j++;
            }
            attrValue = input.slice(valueStart, j);
          }
        }
        if (attrName.length > 0) {
          attrs.push({ name: attrName, value: attrValue });
        }
      }
      if (!closed) {
        // 宽容：未闭合标签按到输入末尾处理
        j = n;
      }
      tokens.push({ type: 'start', name, attrs, selfClose });
      i = j;
      textStart = j;
      // raw-text 元素（script/style）：内容按原文直到匹配的闭合标签 ——
      // 浏览器同口径；不在词法层跳过的话，`<script>if(a<b)...` 里的 `<b`
      // 会被切成标签 token，把后面的 `</script>` 吞进伪造属性
      if ((name === 'script' || name === 'style') && !selfClose) {
        const closeRe = new RegExp('</' + name + '(?=[\\s/>])', 'i');
        closeRe.lastIndex = 0;
        const rest: string = input.slice(i);
        const m = closeRe.exec(rest);
        if (m !== null) {
          const closeIdx: number = i + m.index;
          const gt: number = input.indexOf('>', closeIdx + 2);
          tokens.push({ type: 'end', name });
          i = gt === -1 ? n : gt + 1;
          textStart = i;
        }
        // 无闭合标签：内容到输入末尾，token 流就此结束（清洗层丢子树到末尾）
      }
      continue;
    }
    if (next === '/') {
      const nameStart: number = i + 2;
      if (nameStart < n && isAsciiLetter(input.charAt(nameStart))) {
        let j: number = nameStart;
        while (j < n && !isWhitespace(input.charAt(j)) && input.charAt(j) !== '/' && input.charAt(j) !== '>') {
          j++;
        }
        const name: string = input.slice(nameStart, j).toLowerCase();
        const gt: number = input.indexOf('>', j);
        flushText(i);
        tokens.push({ type: 'end', name });
        i = gt === -1 ? n : gt + 1;
        textStart = i;
        continue;
      }
      // `</` 后非字母：按文本（如数学式 a</b> 的 stray 场景）
      i++;
      continue;
    }
    if (next === '!' || next === '?') {
      // 注释 / doctype / 处理指令：整体跳过
      let end: number;
      if (input.startsWith('<!--', i)) {
        const close: number = input.indexOf('-->', i + 4);
        end = close === -1 ? n : close + 3;
      } else {
        const gt: number = input.indexOf('>', i + 2);
        end = gt === -1 ? n : gt + 1;
      }
      flushText(i);
      i = end;
      textStart = end;
      continue;
    }
    // `<` 后是普通字符：按文本
    i++;
  }
  flushText(n);
  return tokens;
}

// ---------------------------------------------------------------------------
// 清洗（sanitizer）：白名单决策 + 审计记录
// ---------------------------------------------------------------------------

/**
 * 允许的元素 → 允许的属性。不在表内的元素一律不产出标签；
 * 不在表内的属性一律剥除。刻意不保留 class/id（无样式表可挂，保留只是注入面）。
 */
const ALLOWED_TAGS: Record<string, string[]> = {
  p: [],
  br: [],
  hr: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  div: [], span: [],
  blockquote: [],
  pre: [], code: [], kbd: [], samp: [], var: [],
  b: [], strong: [], i: [], em: [], u: [], s: [], del: [], ins: [], mark: [], small: [],
  sub: [], sup: [], abbr: [], cite: [], q: [], time: [],
  ul: [], ol: ['start'], li: ['value'],
  dl: [], dt: [], dd: [],
  figure: [], figcaption: [],
  table: [], caption: [], thead: [], tbody: [], tfoot: [],
  tr: [], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
  colgroup: [], col: ['span'],
  a: [],
  img: ['src', 'alt', 'title', 'width', 'height'],
  wbr: [],
};

/** 整段子树丢弃（内容一并丢弃，连 fallback 文本都不留出不可信面） */
const DROP_WITH_CONTENT: string[] = [
  'script', 'style', 'svg', 'math', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'portal', 'noscript', 'template',
  'canvas', 'video', 'audio', 'source', 'track', 'head', 'title',
];

/** 透明透传（不出标签本身；子节点照常流出；on* 仍记审计） */
const TRANSPARENT_TAGS: string[] = ['html', 'body'];

/** 数值型属性：只允许纯数字（防把 URL 或表达式塞进 width/colspan 之类的属性槽） */
const NUMERIC_ATTRS: string[] = ['width', 'height', 'colspan', 'rowspan', 'span', 'start', 'value'];

const DATA_IMAGE_PATTERN: RegExp = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const SHA256_PATTERN: RegExp = /^[0-9a-f]{64}$/;
const ENTITY_LIKE_PATTERN: RegExp = /&(?!(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g;

/** 文本转义：保留实体引用原样（浏览器本就会解码），转义裸 & < > */
function escapeText(s: string): string {
  return s.replace(ENTITY_LIKE_PATTERN, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性值转义（双引号包裹） */
function escapeAttr(s: string): string {
  return s.replace(ENTITY_LIKE_PATTERN, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 数字字符实体 + 五个核心命名实体的解码（URL 协议判定的前置；防编码绕过） */
function decodeBasicEntities(s: string): string {
  return s.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|amp|lt|gt|quot|apos|nbsp);/g,
    (whole: string, body: string): string => {
      if (body.charAt(0) === '#') {
        const hex: boolean = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        const code: number = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!isNaN(code) && code > 0 && code <= 0x10FFFF) {
          try {
            return String.fromCodePoint(code);
          } catch (_e) {
            return whole;
          }
        }
        return whole;
      }
      switch (body) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return ' ';
        default: return whole;
      }
    });
}

/** URL 判定前清洗：剥控制字符、空白与零宽字符（浏览器协议解析同样忽略它们） */
function cleanForUrlCheck(s: string): string {
  return decodeBasicEntities(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\u0000-\u0020\u007F]/g, '');
}

function clipDetail(s: string): string {
  return s.slice(0, MAX_DETAIL_CHARS);
}

export function sanitizeHtml(input: string): HtmlSanitizeResult {
  const tokens: HtmlToken[] = tokenizeHtml(input);
  const out: string[] = [];
  const events: HtmlAuditEvent[] = [];
  const refs: string[] = [];
  const seenRef: Set<string> = new Set();

  const record = (kind: HtmlBlockKind, detail: string): void => {
    if (events.length < MAX_AUDIT_EVENTS) {
      events.push({ kind, detail: clipDetail(detail) });
    }
  };

  const isDataImage = (value: string): boolean => DATA_IMAGE_PATTERN.test(value);
  const isAllowedAttachment = (value: string): string | undefined => {
    const ref: string | undefined = attachmentRefOf(value);
    if (ref !== undefined && SHA256_PATTERN.test(ref)) {
      return ref;
    }
    return undefined;
  };

  /** img 单独处理：src 走 URL 白名单；src 无效时降级为 [图片：alt] 文本 */
  const emitImg = (tok: Extract<HtmlToken, { type: 'start' }>): void => {
    let src: string | undefined = undefined;
    let srcWasBlocked: boolean = false;
    let alt: string = '';
    for (let k: number = 0; k < tok.attrs.length; k++) {
      const attr = tok.attrs[k];
      if (attr.name === 'alt' && attr.value !== undefined) {
        alt = attr.value;
        continue;
      }
      if (attr.name === 'src') {
        if (attr.value === undefined) {
          continue;
        }
        const cleaned: string = cleanForUrlCheck(attr.value);
        const ref: string | undefined = isAllowedAttachment(cleaned);
        if (ref !== undefined) {
          src = `${ATTACHMENT_SCHEME}${ref}`;
          if (!seenRef.has(ref)) {
            seenRef.add(ref);
            refs.push(ref);
          }
          continue;
        }
        if (isDataImage(cleaned)) {
          src = attr.value;
          continue;
        }
        record('url_blocked', `img.src=${clipDetail(cleaned)}`);
        srcWasBlocked = true;
        continue;
      }
      // 其余属性走通用过滤（在下方 emitAllowedTag 之外的补充，img 不经过 emitAllowedTag）
    }
    if (src === undefined) {
      // 无可用 src：不产出 <img>（避免裂图/请求面），降级为文字说明
      if (srcWasBlocked) {
        out.push(alt.length > 0 ? `[图片：${escapeText(alt)}]` : '[图片]');
      }
      return;
    }
    let tag: string = `<img src="${escapeAttr(src)}"`;
    if (alt.length > 0) {
      tag += ` alt="${escapeAttr(alt)}"`;
    }
    for (let k: number = 0; k < tok.attrs.length; k++) {
      const attr = tok.attrs[k];
      if (attr.name === 'src' || attr.name === 'alt') {
        continue;
      }
      if (attr.name === 'title' && attr.value !== undefined && !attr.value.includes('<') && !attr.value.includes('>')) {
        tag += ` title="${escapeAttr(attr.value)}"`;
        continue;
      }
      if ((attr.name === 'width' || attr.name === 'height') && attr.value !== undefined &&
          /^[0-9]{1,4}$/.test(attr.value)) {
        tag += ` ${attr.name}="${attr.value}"`;
      }
    }
    out.push(`${tag}>`);
  };

  const emitAllowedTag = (tok: Extract<HtmlToken, { type: 'start' }>, spec: string[]): void => {
    let tag: string = `<${tok.name}`;
    for (let k: number = 0; k < tok.attrs.length; k++) {
      const attr = tok.attrs[k];
      const name: string = attr.name;
      if (name.length === 0) {
        continue;
      }
      if (name.startsWith('on')) {
        record('attr_removed', `${tok.name}.${name}`);
        continue;
      }
      if (name === 'style') {
        record('css_blocked', `${tok.name}.style`);
        continue;
      }
      if (!spec.includes(name)) {
        // a.href：一律不保留（V0.1 页内不导航）；危险协议单独记 url_blocked
        if (tok.name === 'a' && name === 'href' && attr.value !== undefined) {
          const cleaned: string = cleanForUrlCheck(attr.value);
          if (/^(javascript|vbscript|data):/i.test(cleaned)) {
            record('url_blocked', `a.href=${clipDetail(cleaned)}`);
          } else {
            record('attr_removed', 'a.href');
          }
        } else {
          record('attr_removed', `${tok.name}.${name}`);
        }
        continue;
      }
      if (attr.value === undefined) {
        continue;
      }
      if (attr.value.includes('<') || attr.value.includes('>')) {
        record('attr_removed', `${tok.name}.${name}`);
        continue;
      }
      if (NUMERIC_ATTRS.includes(name)) {
        if (!/^[0-9]{1,4}$/.test(attr.value)) {
          record('attr_removed', `${tok.name}.${name}`);
          continue;
        }
      }
      tag += ` ${name}="${escapeAttr(attr.value)}"`;
    }
    out.push(`${tag}>`);
  };

  let cursor: number = 0;
  /** 已产出未闭合的白名单标签栈：收到对应闭合标签（或流到末尾）时回发闭合，保证输出结构可预期 */
  const openStack: string[] = [];
  const closeThrough = (name: string): void => {
    for (let k: number = openStack.length - 1; k >= 0; k--) {
      if (openStack[k] === name) {
        while (openStack.length > k) {
          const popped: string = openStack.pop() as string;
          out.push(`</${popped}>`);
        }
        return;
      }
    }
    // 栈里没有这个名字：游离闭合标签，忽略（与 HTML 解析口径一致）
  };
  while (cursor < tokens.length) {
    const idx: number = cursor;
    cursor++;
    const tok = tokens[idx];
    if (tok.type === 'text') {
      out.push(escapeText(tok.text));
      continue;
    }
    if (tok.type === 'end') {
      closeThrough(tok.name);
      continue;
    }
    // 起始标签
    const name: string = tok.name;
    if (TRANSPARENT_TAGS.includes(name)) {
      for (let k: number = 0; k < tok.attrs.length; k++) {
        if (tok.attrs[k].name.startsWith('on')) {
          record('attr_removed', `${name}.${tok.attrs[k].name}`);
        }
      }
      continue;
    }
    if (name === 'img') {
      emitImg(tok);
      continue;
    }
    const spec: string[] | undefined = ALLOWED_TAGS[name];
    if (spec !== undefined) {
      emitAllowedTag(tok, spec);
      if (!isVoidName(name) && !tok.selfClose) {
        openStack.push(name);
      }
      continue;
    }
    if (DROP_WITH_CONTENT.includes(name)) {
      record('tag_removed', name);
      // 子树整体丢弃：跳到匹配的闭合标签（首个同名闭合即出，与浏览器 raw-text 口径一致）
      let depth: number = 1;
      while (cursor < tokens.length && depth > 0) {
        const inner = tokens[cursor];
        if (inner.type === 'start' && inner.name === name) {
          depth++;
        } else if (inner.type === 'end' && inner.name === name) {
          depth--;
        }
        cursor++;
      }
      continue;
    }
    // 未知标签：解壳（子节点照常流出），标签本身记审计
    record('tag_removed', name);
    continue;
  }
  while (openStack.length > 0) {
    const popped: string = openStack.pop() as string;
    out.push(`</${popped}>`);
  }

  return { html: out.join(''), events, attachmentRefs: refs };
}

// ---------------------------------------------------------------------------
// HTML 文档判定与纯文本提取（收件箱/列表使用）
// ---------------------------------------------------------------------------

/**
 * 判定一段文本是否应作为 HTML 文档处理（存为笔记时的 contentType 判定）。
 * 口径从严：doctype/<html> 前缀直接认定；否则前缀窗口内需出现 ≥2 个块级标签，
 * 避免把含零星尖括号的文章误判为 HTML。
 */
export function looksLikeHtml(text: string): boolean {
  let head: string = text.slice(0, LOOKAHEAD_CHARS);
  if (head.charCodeAt(0) === 0xFEFF) {
    head = head.slice(1);
  }
  const trimmed: string = head.trimStart().toLowerCase();
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
    return true;
  }
  const blockTags: string[] = [
    '<p', '<div', '<table', '<h1', '<h2', '<h3', '<h4', '<h5', '<h6',
    '<ul', '<ol', '<blockquote', '<section', '<article', '<header', '<footer', '<nav', '<hr', '<body',
  ];
  let hits: number = 0;
  for (let k: number = 0; k < blockTags.length; k++) {
    if (head.toLowerCase().includes(blockTags[k])) {
      hits++;
      if (hits >= 2) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 提取纯文本（列表预览/标题派生用）：跳过标签与注释，script/style 等
 * 丢弃子树的内容也不进入预览；空白折叠为单空格。
 */
export function htmlToPlainText(html: string): string {
  const tokens: HtmlToken[] = tokenizeHtml(html);
  const parts: string[] = [];
  let cursor: number = 0;
  while (cursor < tokens.length) {
    const tok = tokens[cursor];
    cursor++;
    if (tok.type === 'text') {
      parts.push(tok.text);
      continue;
    }
    if (tok.type === 'start' && DROP_WITH_CONTENT.includes(tok.name)) {
      let depth: number = 1;
      while (cursor < tokens.length && depth > 0) {
        const inner = tokens[cursor];
        if (inner.type === 'start' && inner.name === tok.name) {
          depth++;
        } else if (inner.type === 'end' && inner.name === tok.name) {
          depth--;
        }
        cursor++;
      }
      continue;
    }
    // 块级边界补一个空格，避免文字粘连
    if (tok.type === 'start' || tok.type === 'end') {
      parts.push(' ');
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}
