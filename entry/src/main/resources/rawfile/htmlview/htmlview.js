/**
 * ClipNote 受控 HTML 展示域桥接（可信脚本；S3-3；设计 §4.4 / G6）。
 *
 * 职责只有一件：把 ArkTS 侧 sanitizeHtml 的静态产物挂进 DOM。
 *  - 入参必须是 JSON 字符串（{ html: string }），由 pages/HtmlRead.ets
 *    经 runJavaScript 注入；本文件不做任何解析之外的加工，不引入远程内容；
 *  - 每次渲染全量重建（先清空 #content 再挂新节点），不存在增量注入面；
 *  - window.__clipnotePerf 暴露真机首屏计时（renderCount/lastHtmlBytes/lastBlockMs）。
 *
 * UMD：Node 下走 module.exports（tools 本机用例直载同一份文件验证桥接 roundtrip）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.__clipnoteHtmlView = api;
    root.__clipnoteSetHtml = api.setHtml;
    root.__clipnotePerf = api.state;
  }
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var state = {
    renderCount: 0,
    lastHtmlBytes: 0,
    lastBlockMs: 0
  };

  /**
   * 渲染静态产物：payload.html 只是排版标签 + 转义文本
   * （无脚本/事件属性/iframe/远程引用 —— 清洗层保证，CSP 与平台开关兜底）。
   */
  function render(doc, payload) {
    var content = doc.getElementById('content');
    // 全量重建：渲染前清空，杜绝跨文档残留与增量注入面
    content.textContent = '';
    var host = doc.createElement('div');
    host.setAttribute('data-clipnote-rendered', '1');
    host.innerHTML = payload.html;
    content.appendChild(host);
    state.renderCount += 1;
    state.lastHtmlBytes = payload.html.length;
  }

  /** ArkTS 注入入口：解析 JSON → 渲染 → 返回 renderCount（失败抛错，由 ArkTS 侧如实提示） */
  function setHtml(json) {
    var t0 = Date.now();
    var payload = JSON.parse(json);
    if (payload === null || typeof payload !== 'object' || typeof payload.html !== 'string') {
      throw new Error('__clipnoteSetHtml: bad payload');
    }
    render(document, payload);
    state.lastBlockMs = Date.now() - t0;
    return state.renderCount;
  }

  return { setHtml: setHtml, render: render, state: state };
}));
