/* The runtime the gateway puts into every artboard on its way to the sandboxed frame (lib/props.js
 * `injectRuntime`). A plain script, no module, no globals but `window.__canvas`. It reads the artboard's
 * `#canvas-props` block, applies the prop values the page sends — as CSS custom properties `--prop-<key>`
 * on the root, as `data-prop-<key>` attributes on it, and as the text of `[data-prop="<key>"]` elements
 * (or the `src` of an `<img data-prop>`) — and tells the page when it is ready and how tall the document
 * is. The frame's origin is opaque, so messages carry the nonce the page put in the URL's fragment, and
 * only the parent window's messages with that nonce are taken. Links do nothing: an artboard is a picture
 * of a page, not a page, and navigating the frame would leave the token's scope. */
(function () {
  "use strict";
  var nonce = String(location.hash || "").slice(1);
  var decl = null;
  var values = {};
  var block = document.getElementById("canvas-props");
  if (block) {
    try {
      var parsed = JSON.parse(block.textContent || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) decl = parsed;
    } catch (e) {
      decl = null;
    }
  }

  function valueOf(key) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    var spec = decl && decl[key];
    return spec && typeof spec === "object" ? spec["default"] : undefined;
  }

  function apply() {
    var keys = {};
    var k;
    if (decl) for (k in decl) if (Object.prototype.hasOwnProperty.call(decl, k)) keys[k] = true;
    for (k in values) if (Object.prototype.hasOwnProperty.call(values, k)) keys[k] = true;
    var root = document.documentElement;
    for (k in keys) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k)) continue;
      var v = valueOf(k);
      if (v === undefined || v === null) continue;
      var text = String(v);
      root.style.setProperty("--prop-" + k, text);
      root.setAttribute("data-prop-" + k, text);
      var targets = document.querySelectorAll('[data-prop="' + k + '"]');
      for (var i = 0; i < targets.length; i++) {
        var el = targets[i];
        if (el.tagName === "IMG") el.setAttribute("src", text);
        else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = text;
        else el.textContent = text;
      }
    }
  }

  function post(message) {
    message.nonce = nonce;
    try {
      window.parent.postMessage(message, "*");
    } catch (e) {
      /* no parent: opened on its own */
    }
  }

  var lastW = -1;
  var lastH = -1;
  var pending = false;
  function measure() {
    pending = false;
    var root = document.documentElement;
    var body = document.body;
    var board = document.getElementById("board");
    var w = Math.ceil(Math.max(board ? board.scrollWidth : 0, root.scrollWidth, body ? body.scrollWidth : 0));
    var h = Math.ceil(Math.max(board ? board.scrollHeight : 0, root.scrollHeight, body ? body.scrollHeight : 0));
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    post({ type: "size", width: w, height: h });
  }
  function sizeSoon() {
    if (pending) return;
    pending = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(measure);
    else setTimeout(measure, 16);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object" || event.data.nonce !== nonce) return;
    if (event.data.type === "props") {
      var next = event.data.values;
      values = next && typeof next === "object" && !Array.isArray(next) ? next : {};
      apply();
      sizeSoon();
    } else if (event.data.type === "measure") sizeSoon();
  });

  document.addEventListener(
    "click",
    function (event) {
      var a = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (a) event.preventDefault();
    },
    true
  );
  document.addEventListener("submit", function (event) { event.preventDefault(); }, true);

  function start() {
    apply();
    post({ type: "ready" });
    measure();
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(sizeSoon);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    window.addEventListener("load", sizeSoon);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeSoon, function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__canvas = { apply: apply, values: function () { return values; } };
})();
