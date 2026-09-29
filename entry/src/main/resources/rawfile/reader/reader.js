/**
 * ClipNote MD 阅读域渲染内核（设计 §4.3 / §4.4 / G6）。
 *
 * 本文件同时是：
 *  - 阅读页的运行时代码（ArkWeb 内以 <script src> 加载，window.__clipnoteReader）；
 *  - 本机验证基线的被测对象（tools/test/reader.test.ts 以 Node require 直接加载本文件，
 *    测试的**就是**交付物本身，不是镜像）。
 *
 * 安全口径（G6，阻断性门槛）：
 *  - buildReaderHtml 对一切笔记文本做全量 HTML 转义（escapeHtml），输入不可能注入脚本/事件/外链；
 *  - 图片只渲染「块模型给出的合法 sha256 附件摘要」（ATTACHMENT_SCHEME 由 ArkTS 侧拦截映射），
 *    拒绝任何其他 src（远程图、相对路径、伪协议）；
 *  - 未覆盖语法（RAW）降级为转义后的 <pre> 原文，绝不当 HTML 解释。
 *
 * 输出为 HTML **字符串**，由 bridge.js 一次性赋给 root.innerHTML —— 字符串全部来自
 * 本文件的受控拼接，转义在拼接前完成，因此 innerHTML 注入面与 textContent 方案等价。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__clipnoteReader = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var ATTACHMENT_SCHEME = 'attachment://';
  var SHA256_RE = /^[0-9a-f]{64}$/;

  /** 全量 HTML 转义：& < > " ' 五个字符，输入 → 文本的唯一通道 */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 转义后保留换行（引用/表格按原文换行展示） */
  function escapeHtmlWithBreaks(s) {
    return escapeHtml(s).replace(/\n/g, '<br>');
  }

  /**
   * markdown-it Token → 桥接 Schema 子集（与 common/src/main/ets/core/markdown.ts
   * 的 MdToken 成对维护；两边字段集必须一致，ArkTS 侧 mdTokensFromJson 按此还原）。
   * 只保留真正消费的字段，序列化体积最小化（长文性能口径）。
   */
  function slimToken(t) {
    var out = {
      type: t.type,
      tag: t.tag,
      nesting: t.nesting,
      map: t.map === null || t.map === undefined ? null : [t.map[0], t.map[1]],
      level: t.level,
      content: t.content === undefined ? '' : String(t.content),
      markup: t.markup === undefined ? '' : String(t.markup),
      info: t.info === undefined ? '' : String(t.info),
      children: null,
    };
    if (Array.isArray(t.children) && t.children.length > 0) {
      out.children = t.children.map(slimToken);
    }
    if (Array.isArray(t.attrs)) {
      out.attrs = t.attrs;
    }
    return out;
  }

  /**
   * 解析桥（设计 §4.3「ArkWeb 内运行 markdown-it」的落点）：
   * 禁 html（原始 HTML 一律降级为文本/RAW）、禁 linkify（不自动识别链接、不生成外链）。
   * 返回桥接 Schema 的 JSON 字符串，由 ArkTS 侧 mdTokensFromJson 还原。
   */
  function tokenize(source) {
    var g = typeof globalThis !== 'undefined' ? globalThis : root;
    if (typeof g.markdownit !== 'function') {
      throw new Error('markdown-it UMD not loaded');
    }
    var md = g.markdownit({ html: false, linkify: false, breaks: false });
    var tokens = md.parse(String(source), {});
    return JSON.stringify(tokens.map(slimToken));
  }

  /**
   * 代码块渲染内容：以源范围切片为准（块模型 text 首行带语言标签，不便直接展示）。
   * fence（```）剥掉首尾围栏行，语言标签单独作 data-lang；缩进式代码块按原文。
   */
  function codeParts(block, markdown) {
    var slice = markdown.slice(block.range.startOffset, block.range.endOffset);
    var lines = slice.split('\n');
    if (lines.length > 0 && lines[0].indexOf('```') === 0) {
      var lang = lines[0].replace(/^`{3,}/, '').trim();
      lines.shift();
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      if (lines.length > 0 && /^`{3,}\s*$/.test(lines[lines.length - 1].trim())) {
        lines.pop();
      }
      return { lang: lang, body: lines.join('\n') };
    }
    return { lang: '', body: slice.replace(/\n+$/, '') };
  }

  /**
   * DocumentBlock[] → 阅读页 HTML。
   * 契约：块来自 common parseDocument（docRevision 内稳定）；markdown 为同一 revision 的原文。
   */
  function buildReaderHtml(blocks, markdown) {
    var out = [];
    var i = 0;
    while (i < blocks.length) {
      var b = blocks[i];
      switch (b.type) {
        case 'heading': {
          var level = b.level >= 1 && b.level <= 6 ? b.level : 1;
          out.push('<h' + level + '>' + escapeHtml(b.text) + '</h' + level + '>');
          i += 1;
          break;
        }
        case 'paragraph':
          out.push('<p>' + escapeHtml(b.text) + '</p>');
          i += 1;
          break;
        case 'list_item': {
          // 连续 LIST_ITEM 合并为一个 <ul>（块模型按条目产出）
          out.push('<ul>');
          while (i < blocks.length && blocks[i].type === 'list_item') {
            out.push('<li>' + escapeHtml(blocks[i].text) + '</li>');
            i += 1;
          }
          out.push('</ul>');
          break;
        }
        case 'code': {
          var parts = codeParts(b, markdown);
          out.push(
            '<pre class="cl-code" data-lang="' + escapeHtml(parts.lang) + '"><code>' +
              escapeHtml(parts.body) + '</code></pre>'
          );
          i += 1;
          break;
        }
        case 'quote':
          out.push('<blockquote>' + escapeHtmlWithBreaks(b.text) + '</blockquote>');
          i += 1;
          break;
        case 'table':
          // 表格整段原文用等宽 pre 展示（单元格边界不被改动，设计 §4.3 块模型口径）
          out.push('<pre class="cl-table">' + escapeHtmlWithBreaks(b.text) + '</pre>');
          i += 1;
          break;
        case 'image': {
          // G6：只接受合法 sha256 附件摘要；其余（缺失/非法）给文字占位，不产生任何请求
          var ref = typeof b.attachmentRef === 'string' ? b.attachmentRef : '';
          if (SHA256_RE.test(ref)) {
            var alt = escapeHtml(b.text);
            out.push(
              '<figure><img src="' + ATTACHMENT_SCHEME + ref + '" alt="' + alt + '">' +
                (alt.length > 0 ? '<figcaption>' + alt + '</figcaption>' : '') +
                '</figure>'
            );
          } else {
            var label = escapeHtml(b.text);
            out.push(
              '<p class="cl-image-missing">[图片]' + (label.length > 0 ? ' ' + label : '') + '</p>'
            );
          }
          i += 1;
          break;
        }
        case 'thematic_break':
          out.push('<hr>');
          i += 1;
          break;
        case 'raw':
        default:
          // 未覆盖语法：转义后原文展示，绝不当 HTML 解释（G6）
          out.push('<pre class="cl-raw">' + escapeHtml(b.text) + '</pre>');
          i += 1;
          break;
      }
    }
    return out.join('\n');
  }

  return {
    escapeHtml: escapeHtml,
    slimToken: slimToken,
    tokenize: tokenize,
    buildReaderHtml: buildReaderHtml,
  };
});
