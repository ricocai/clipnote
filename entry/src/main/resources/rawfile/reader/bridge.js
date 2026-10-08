/**
 * ArkWeb ←→ ArkTS 桥（可信域内联调用的唯一入口；设计 §4.3 桥接 Schema）。
 *
 * 为什么单独成文件：reader.html 的 CSP 是 script-src 'self'（无 inline、无 eval），
 * 桥接函数必须放在包内脚本里，而不是内联 <script>。
 *
 * 两个入口都由 ArkTS 侧 WebviewController.runJavaScript 调用：
 *  - __clipnoteTokenize(markdownJson) → 桥接 Schema JSON 字符串（再经 mdTokensFromJson 还原）
 *  - __clipnoteRender(blocksJson, sourceJson) → 块模型渲染进 DOM；耗时记录在 window.__clipnotePerf
 */
(function () {
  'use strict';

  window.__clipnoteTokenize = function (markdownJson) {
    return window.__clipnoteReader.tokenize(JSON.parse(markdownJson));
  };

  window.__clipnoteRender = function (blocksJson, sourceJson) {
    var t0 = performance.now();
    var blocks = JSON.parse(blocksJson);
    var source = sourceJson === undefined ? '' : JSON.parse(sourceJson);
    var html = window.__clipnoteReader.buildReaderHtml(blocks, source);
    var rootEl = document.getElementById('root');
    rootEl.innerHTML = html;
    // 段落双击 = 从该段开始朗读（真机验收 Q2b）：事件委托在 #root 上，
    // innerHTML 重绘不影响监听；块下标经 data-cl-i 锚点取回，交给 ArkTS 侧代理
    rootEl.ondblclick = function (ev) {
      var target = ev.target;
      var el = target && target.closest ? target.closest('[data-cl-i]') : null;
      if (el === null && target && target.getAttribute && target.getAttribute('data-cl-i') !== null) {
        el = target;
      }
      if (el && window.clipnoteBridge && typeof window.clipnoteBridge.onBlockDoubleTap === 'function') {
        window.clipnoteBridge.onBlockDoubleTap(Number(el.getAttribute('data-cl-i')));
      }
    };
    var t1 = performance.now();
    // 真机性能口径（长文首屏/渲染耗时直接可读；滚动流畅度仍需真机 FPS 实测）
    window.__clipnotePerf = {
      renderMs: t1 - t0,
      blocks: blocks.length,
      htmlBytes: html.length,
    };
    return String(blocks.length);
  };
})();
