/* The spreadsheet grid as a view: native scrolling over a spacer as large as the whole tab, with only the
 * cells in sight (and a few around them) in the DOM, placed absolutely at their true offsets so the
 * compositor scrolls them with no work of ours, and recycled as the window moves. Frozen rows and columns,
 * and the letters and numbers, are sticky layers over the scrolled body: four quadrants (corner, top,
 * left, main), each with its own gridlines, cells and overlay, all placed from one geometry. Overlays —
 * the selection's wash and border, the active cell, the fill handle, the references of a formula being
 * written, the cells another writer changed, the copied range — are cut per quadrant. The view owns the
 * pointer: clicking, shift-clicking, dragging, headers, the corner, the fill handle, the header edges that
 * resize and fit, and the right-click; it reports to the tab through hooks and never changes the workbook
 * itself. Every position is set from code. */

import { colName } from "./core/address.js";
import { colAxis, HEAD_H, HEAD_W, rowAxis } from "./layout.js";

const OVER_ROWS = 10;
const OVER_COLS = 4;
const EDGE = 4; // px either side of a header boundary that grabs a resize
const SPILL_MAX = 24; // columns a text may run over to its right

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = (a, b) => ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });

/** Dark or light text for a fill, by its luminance, so a coloured cell reads in both themes. */
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.36 ? "#1d1d22" : "#f4f4f7";
}

/**
 * `hooks`: `view(r, c)` → null or `{ text, align, kind, b, i, u, s, color, fill, wrap, title }`;
 * `filled(r, c)` → whether the cell holds a value (text stops spilling there); `pointing()` → whether a
 * click should point at cells for a formula; `onSelect(sel)`, `onPoint(range, phase)`, `onActivate(r, c)`,
 * `onFill(from, to)`, `onResize(axis, index, px)`, `onFit(axis, index)`, `onMenu(at, hit)`, `onFocus()`.
 */
export function createGrid(ext, hooks) {
  const { el } = ext.dom;
  let tab = null; // { rows, cols, freeze, heights, widths }
  let R = null; // the row axis
  let C = null; // the column axis
  let fr = 0;
  let fc = 0;
  let geo = 0; // bumped on every relayout
  let ver = 0; // bumped on every data change
  let sel = { r: 0, c: 0, ar: 0, ac: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
  let refs = []; // [{ range, tone }]
  let copyRange = null;
  let flashes = []; // [{ range, until }]
  let fillPreview = null;
  let measureCtx = null;
  let fonts = null;

  // ---- the structure ----

  const node = el("div", { class: "sht-grid" });
  const scroller = el("div", { class: "sht-scroller" });
  const top = el("div", { class: "sht-top" });
  const corner = el("div", { class: "sht-corner" });
  const mid = el("div", { class: "sht-mid" });
  const left = el("div", { class: "sht-left" });
  const main = el("div", { class: "sht-main" });
  const guide = el("div", { class: "sht-guide", hidden: true });
  top.append(corner);
  mid.append(main, left);
  scroller.append(top, mid);
  node.append(scroller, guide);

  function quadrant(name, host) {
    const lines = el("div", { class: "sht-lines" });
    const cells = el("div", { class: "sht-cells" });
    const heads = el("div", { class: "sht-heads" });
    const ov = el("div", { class: "sht-ov" });
    host.append(lines, cells, ov, heads);
    return { name, host, lines, cells, heads, ov, nodes: new Map(), lineNodes: [], headNodes: new Map(), rows: [0, 0], cols: [0, 0], x: null, y: null };
  }
  const Q = { main: quadrant("main", main), left: quadrant("left", left), top: quadrant("top", top), corner: quadrant("corner", corner) };
  const quads = [Q.main, Q.left, Q.top, Q.corner];
  const cornerBox = el("div", { class: "sht-cornerbox", title: "Select everything" });
  Q.corner.heads.append(cornerBox);

  // ---- geometry ----

  const fw = () => C.start(fc); // frozen width
  const fh = () => R.start(fr);
  const topH = () => HEAD_H + fh();
  const leftW = () => HEAD_W + fw();

  function layout() {
    if (!tab) return;
    R = rowAxis(tab);
    C = colAxis(tab);
    fr = clamp(tab.freeze?.rows ?? 0, 0, tab.rows - 1);
    fc = clamp(tab.freeze?.cols ?? 0, 0, tab.cols - 1);
    geo += 1;
    const W = leftW() + C.total - fw();
    const midH = R.total - fh();
    top.style.width = `${W}px`;
    top.style.height = `${topH()}px`;
    corner.style.width = `${leftW()}px`;
    corner.style.height = `${topH()}px`;
    mid.style.width = `${W}px`;
    mid.style.height = `${midH}px`;
    left.style.width = `${leftW()}px`;
    left.style.height = `${midH}px`;
    main.style.width = `${W}px`;
    main.style.height = `${midH}px`;
    node.classList.toggle("has-frozen-rows", fr > 0);
    node.classList.toggle("has-frozen-cols", fc > 0);
    const mx = (c) => leftW() + C.start(c) - fw();
    const my = (r) => R.start(r) - fh();
    const fx = (c) => HEAD_W + C.start(c);
    const fy = (r) => HEAD_H + R.start(r);
    Object.assign(Q.main, { rows: [fr, tab.rows], cols: [fc, tab.cols], x: mx, y: my });
    Object.assign(Q.top, { rows: [0, fr], cols: [fc, tab.cols], x: mx, y: fy });
    Object.assign(Q.left, { rows: [fr, tab.rows], cols: [0, fc], x: fx, y: my });
    Object.assign(Q.corner, { rows: [0, fr], cols: [0, fc], x: fx, y: fy });
    cornerBox.style.width = `${HEAD_W}px`;
    cornerBox.style.height = `${HEAD_H}px`;
  }

  /** The rows and columns in sight in the scrolled body, with some to spare either side. */
  function windowOf() {
    const sL = scroller.scrollLeft;
    const sT = scroller.scrollTop;
    const vw = Math.max(scroller.clientWidth, 1);
    const vh = Math.max(scroller.clientHeight, 1);
    const r0 = Math.max(fr, R.at(fh() + sT) - OVER_ROWS);
    const r1 = Math.min(tab.rows - 1, R.at(fh() + sT + Math.max(0, vh - topH())) + OVER_ROWS);
    const c0 = Math.max(fc, C.at(fw() + sL) - OVER_COLS);
    const c1 = Math.min(tab.cols - 1, C.at(fw() + sL + Math.max(0, vw - leftW())) + OVER_COLS);
    return { r0, r1, c0, c1 };
  }

  // ---- drawing ----

  const place = (n, x, y, w, h) => {
    n.style.transform = `translate(${x}px, ${y}px)`;
    n.style.width = `${w}px`;
    n.style.height = `${h}px`;
  };

  function measure(text, bold) {
    if (!measureCtx) {
      measureCtx = document.createElement("canvas").getContext("2d");
      const cs = getComputedStyle(Q.main.cells);
      fonts = { normal: `${cs.fontSize} ${cs.fontFamily}`, bold: `700 ${cs.fontSize} ${cs.fontFamily}` };
    }
    measureCtx.font = bold ? fonts.bold : fonts.normal;
    return measureCtx.measureText(text).width;
  }

  /** How far a left-aligned text runs right over empty neighbours, in px; its own width when it fits. */
  function spillWidth(q, r, c, v, own) {
    if (v.wrap || v.align !== "left" || v.kind !== "text" || !v.text || v.text.includes("\n")) return own;
    if (v.text.length * 5 < own - 10) return own;
    const need = measure(v.text, v.b) + 12;
    if (need <= own) return own;
    let w = own;
    for (let k = c + 1; k < Math.min(q.cols[1], c + 1 + SPILL_MAX) && w < need; k++) {
      if (hooks.filled(r, k)) break;
      w += C.size(k);
    }
    return w;
  }

  function drawCell(q, n, r, c, v) {
    const own = C.size(c);
    const w = spillWidth(q, r, c, v, own);
    place(n, q.x(c), q.y(r), w > own ? w - 1 : w, R.size(r)); // a spill stops short of the last gridline
    n.textContent = v.text ?? "";
    let cls = `sht-cell is-${v.align ?? "left"}`;
    if (v.kind === "err") cls += " is-err";
    if (v.b) cls += " is-b";
    if (v.i) cls += " is-i";
    if (v.u) cls += " is-u";
    if (v.s) cls += " is-s";
    if (v.wrap) cls += " is-wrap";
    if (w > own) cls += " is-spill";
    if (v.fill) cls += " has-fill";
    n.className = cls;
    n.style.backgroundColor = v.fill ?? "";
    n.style.color = v.color ?? (v.fill ? inkFor(v.fill) : "");
    if (v.title) n.title = v.title;
    else n.removeAttribute("title");
    n.dataset.addr = `${colName(c)}${r + 1}`;
  }

  function paintCells(q, win) {
    const rows = [Math.max(q.rows[0], q === Q.main || q === Q.left ? win.r0 : 0), Math.min(q.rows[1] - 1, q === Q.main || q === Q.left ? win.r1 : q.rows[1] - 1)];
    const cols = [Math.max(q.cols[0], q === Q.main || q === Q.top ? win.c0 : 0), Math.min(q.cols[1] - 1, q === Q.main || q === Q.top ? win.c1 : q.cols[1] - 1)];
    const keep = new Set();
    if (rows[0] <= rows[1] && cols[0] <= cols[1]) {
      // A text further left than the window may spill into it, so the scan starts a little before.
      const from = Math.max(q.cols[0], cols[0] - (q === Q.main || q === Q.top ? 6 : 0));
      for (let r = rows[0]; r <= rows[1]; r++) {
        for (let c = from; c <= cols[1]; c++) {
          const v = hooks.view(r, c);
          if (!v) continue;
          const key = `${r}:${c}`;
          keep.add(key);
          let n = q.nodes.get(key);
          if (n && n._ver === ver && n._geo === geo) continue;
          if (!n) {
            n = document.createElement("div");
            q.nodes.set(key, n);
            q.cells.append(n);
          }
          n._ver = ver;
          n._geo = geo;
          drawCell(q, n, r, c, v);
        }
      }
    }
    for (const [key, n] of q.nodes) {
      if (keep.has(key)) continue;
      n.remove();
      q.nodes.delete(key);
    }
    // the gridlines: one 1px line per row and column edge in sight, recycled
    let i = 0;
    const line = (x, y, w, h) => {
      let n = q.lineNodes[i];
      if (!n) {
        n = el("div", { class: "sht-line" });
        q.lineNodes.push(n);
        q.lines.append(n);
      }
      n.hidden = false;
      place(n, x, y, w, h);
      i += 1;
    };
    if (rows[0] <= rows[1] && cols[0] <= cols[1]) {
      const x0 = q.x(cols[0]);
      const x1 = q.x(cols[1]) + C.size(cols[1]);
      const y0 = q.y(rows[0]);
      const y1 = q.y(rows[1]) + R.size(rows[1]);
      for (let c = cols[0]; c <= cols[1]; c++) line(q.x(c) + C.size(c) - 1, y0, 1, y1 - y0);
      for (let r = rows[0]; r <= rows[1]; r++) line(x0, q.y(r) + R.size(r) - 1, x1 - x0, 1);
    }
    for (let k = i; k < q.lineNodes.length; k++) q.lineNodes[k].hidden = true;
    return { rows, cols };
  }

  function paintHeads(win) {
    const want = new Map(); // host quadrant -> [{ key, axis, i }]
    const colsFull = sel.r1 === 0 && sel.r2 === tab.rows - 1;
    const rowsFull = sel.c1 === 0 && sel.c2 === tab.cols - 1;
    const heads = [
      { q: Q.top, axis: "col", from: Math.max(fc, win.c0), to: win.c1 },
      { q: Q.corner, axis: "col", from: 0, to: fc - 1 },
      { q: Q.left, axis: "row", from: Math.max(fr, win.r0), to: win.r1 },
      { q: Q.corner, axis: "row", from: 0, to: fr - 1 },
    ];
    for (const h of heads) {
      if (!want.has(h.q)) want.set(h.q, new Set());
      const keep = want.get(h.q);
      for (let i = h.from; i <= h.to; i++) {
        const key = `${h.axis}${i}`;
        keep.add(key);
        let n = h.q.headNodes.get(key);
        if (!n) {
          n = el("div", { class: `sht-head is-${h.axis}` }, h.axis === "col" ? colName(i) : String(i + 1));
          h.q.headNodes.set(key, n);
          h.q.heads.append(n);
        }
        if (n._geo !== geo) {
          n._geo = geo;
          if (h.axis === "col") place(n, h.q.x(i), 0, C.size(i), HEAD_H);
          else place(n, 0, h.q.y(i), HEAD_W, R.size(i));
        }
        const inSel = h.axis === "col" ? i >= sel.c1 && i <= sel.c2 : i >= sel.r1 && i <= sel.r2;
        n.classList.toggle("is-sel", inSel);
        n.classList.toggle("is-full", inSel && (h.axis === "col" ? colsFull : rowsFull));
      }
    }
    for (const q of quads) {
      const keep = want.get(q) ?? new Set();
      for (const [key, n] of q.headNodes) {
        if (keep.has(key)) continue;
        n.remove();
        q.headNodes.delete(key);
      }
    }
    cornerBox.classList.toggle("is-full", colsFull && rowsFull);
  }

  let lastWin = null;
  function paint() {
    if (!tab) return;
    const win = windowOf();
    lastWin = win;
    for (const q of quads) paintCells(q, win);
    paintHeads(win);
  }

  // ---- overlays ----

  /** `range` cut to quadrant `q`, as a box in its coordinates with the sides that are real edges. */
  function clip(q, range) {
    const r1 = Math.max(range.r1, q.rows[0]);
    const r2 = Math.min(range.r2, q.rows[1] - 1);
    const c1 = Math.max(range.c1, q.cols[0]);
    const c2 = Math.min(range.c2, q.cols[1] - 1);
    if (r1 > r2 || c1 > c2) return null;
    const x = q.x(c1);
    const y = q.y(r1);
    return { x, y, w: q.x(c2) + C.size(c2) - x, h: q.y(r2) + R.size(r2) - y, t: r1 === range.r1, b: r2 === range.r2, l: c1 === range.c1, r: c2 === range.c2 };
  }

  function box(q, range, cls) {
    const b = clip(q, range);
    if (!b) return null;
    const n = el("div", { class: `sht-box ${cls}${b.t ? "" : " no-t"}${b.b ? "" : " no-b"}${b.l ? "" : " no-l"}${b.r ? "" : " no-r"}` });
    place(n, b.x, b.y, b.w, b.h);
    q.ov.append(n);
    return n;
  }

  let editorNode = null; // kept across overlay redraws

  function overlays() {
    if (!tab) return;
    for (const q of quads) {
      for (const child of [...q.ov.children]) if (child !== editorNode) child.remove();
    }
    const now = Date.now();
    flashes = flashes.filter((f) => f.until > now);
    for (const q of quads) {
      for (const f of flashes) box(q, f.range, "is-flash");
      for (const ref of refs) box(q, ref.range, `is-ref is-tone${ref.tone % 6}`);
      if (copyRange) box(q, copyRange, "is-copy");
      const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2;
      if (multi) box(q, sel, "is-sel");
      box(q, { r1: sel.r, c1: sel.c, r2: sel.r, c2: sel.c }, "is-active");
      if (fillPreview) box(q, fillPreview, "is-fillto");
    }
    // the fill handle, at the bottom-right corner of the selection, in the quadrant that holds that corner
    const q = quads.find((x) => sel.r2 >= x.rows[0] && sel.r2 < x.rows[1] && sel.c2 >= x.cols[0] && sel.c2 < x.cols[1]);
    if (q && !(sel.r1 === 0 && sel.r2 === tab.rows - 1 && sel.c1 === 0 && sel.c2 === tab.cols - 1)) {
      const handle = el("div", { class: "sht-fill", title: "Drag to fill" });
      place(handle, q.x(sel.c2) + C.size(sel.c2) - 4, q.y(sel.r2) + R.size(sel.r2) - 4, 7, 7);
      handle.addEventListener("pointerdown", startFill);
      q.ov.append(handle);
    }
  }

  // ---- hit testing ----

  function hit(clientX, clientY) {
    const rect = scroller.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const sL = scroller.scrollLeft;
    const sT = scroller.scrollTop;
    const inColHead = y < HEAD_H;
    const inRowHead = x < HEAD_W;
    const c = x < leftW() ? C.at(x - HEAD_W) : C.at(fw() + sL + (x - leftW()));
    const r = y < topH() ? R.at(y - HEAD_H) : R.at(fh() + sT + (y - topH()));
    const colLeft = (i) => (i < fc ? HEAD_W + C.start(i) : leftW() + C.start(i) - fw() - sL);
    const rowTop = (i) => (i < fr ? HEAD_H + R.start(i) : topH() + R.start(i) - fh() - sT);
    const out = { x, y, r: clamp(r, 0, tab.rows - 1), c: clamp(c, 0, tab.cols - 1), area: inColHead && inRowHead ? "corner" : inColHead ? "col" : inRowHead ? "row" : "cell", edge: null };
    if (out.area === "col") {
      const right = colLeft(out.c) + C.size(out.c);
      if (Math.abs(x - right) <= EDGE) out.edge = { axis: "col", index: out.c, at: right };
      else if (out.c > 0 && Math.abs(x - colLeft(out.c)) <= EDGE) out.edge = { axis: "col", index: out.c - 1, at: colLeft(out.c) };
    } else if (out.area === "row") {
      const bottom = rowTop(out.r) + R.size(out.r);
      if (Math.abs(y - bottom) <= EDGE) out.edge = { axis: "row", index: out.r, at: bottom };
      else if (out.r > 0 && Math.abs(y - rowTop(out.r)) <= EDGE) out.edge = { axis: "row", index: out.r - 1, at: rowTop(out.r) };
    }
    return out;
  }

  // ---- pointer gestures ----

  let drag = null; // { kind, ... }
  let autoTimer = null;
  let lastMove = null;

  function selectionFor(h, anchor) {
    if (h.area === "corner") return { r: 0, c: 0, ar: 0, ac: 0, r1: 0, c1: 0, r2: tab.rows - 1, c2: tab.cols - 1 };
    if (h.area === "col") {
      const a = anchor ?? h.c;
      return { r: 0, c: a, ar: 0, ac: a, r1: 0, r2: tab.rows - 1, c1: Math.min(a, h.c), c2: Math.max(a, h.c), whole: "col" };
    }
    if (h.area === "row") {
      const a = anchor ?? h.r;
      return { r: a, c: 0, ar: a, ac: 0, c1: 0, c2: tab.cols - 1, r1: Math.min(a, h.r), r2: Math.max(a, h.r), whole: "row" };
    }
    const a = anchor ?? { r: h.r, c: h.c };
    return { r: a.r, c: a.c, ar: a.r, ac: a.c, ...norm(a, h) };
  }

  function onPointerDown(event) {
    if (!tab || event.button > 0) return;
    if (event.target.closest(".sht-editor, .sht-fill")) return;
    const h = hit(event.clientX, event.clientY);
    if (event.pointerType === "touch") {
      drag = { kind: "tap", x: event.clientX, y: event.clientY, h };
      return;
    }
    event.preventDefault();
    hooks.onFocus?.(h);
    if (h.edge) {
      drag = { kind: "resize", edge: h.edge, start: h.edge.axis === "col" ? event.clientX : event.clientY, size: h.edge.axis === "col" ? C.size(h.edge.index) : R.size(h.edge.index) };
      showGuide(h.edge.axis, h.edge.at);
    } else if (h.area === "cell" && hooks.pointing()) {
      drag = { kind: "point", anchor: { r: h.r, c: h.c } };
      hooks.onPoint({ r1: h.r, c1: h.c, r2: h.r, c2: h.c }, "start");
    } else {
      let next;
      if (event.shiftKey) {
        const anchor = h.area === "col" ? sel.ac : h.area === "row" ? sel.ar : { r: sel.r, c: sel.c };
        next = h.area === "cell" ? { ...sel, ...norm({ r: sel.r, c: sel.c }, h) } : selectionFor(h, anchor);
        if (h.area !== "cell") Object.assign(next, { r: sel.r, c: sel.c });
      } else next = selectionFor(h);
      drag = { kind: "select", area: h.area, anchor: h.area === "col" ? next.ac : h.area === "row" ? next.ar : { r: next.r, c: next.c } };
      hooks.onSelect(next);
    }
    lastMove = { x: event.clientX, y: event.clientY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    clearInterval(autoTimer);
    autoTimer = setInterval(autoScroll, 40);
  }

  function onPointerMove(event) {
    if (!drag) return;
    lastMove = { x: event.clientX, y: event.clientY };
    track();
  }

  function track() {
    if (!drag || !lastMove) return;
    if (drag.kind === "resize") {
      const d = (drag.edge.axis === "col" ? lastMove.x : lastMove.y) - drag.start;
      const min = drag.edge.axis === "col" ? 20 : 16;
      const size = clamp(drag.size + d, min, drag.edge.axis === "col" ? 1000 : 400);
      drag.next = Math.round(size);
      showGuide(drag.edge.axis, drag.edge.at + (size - drag.size));
      return;
    }
    const h = hit(lastMove.x, lastMove.y);
    if (drag.kind === "select") {
      const area = drag.area === "cell" ? "cell" : drag.area;
      const next = drag.area === "corner" ? selectionFor({ area: "corner" }) : selectionFor({ ...h, area }, drag.anchor);
      if (next.r1 !== sel.r1 || next.r2 !== sel.r2 || next.c1 !== sel.c1 || next.c2 !== sel.c2) hooks.onSelect(next);
    } else if (drag.kind === "point") {
      hooks.onPoint(norm(drag.anchor, h), "move");
    } else if (drag.kind === "fill") {
      const s = drag.from;
      const below = h.r - s.r2;
      const above = s.r1 - h.r;
      const right = h.c - s.c2;
      const leftward = s.c1 - h.c;
      const vert = Math.max(below, above);
      const horiz = Math.max(right, leftward);
      let to = { ...s };
      if (vert > 0 && vert >= horiz) to = below > 0 ? { ...s, r2: h.r } : { ...s, r1: h.r };
      else if (horiz > 0) to = right > 0 ? { ...s, c2: h.c } : { ...s, c1: h.c };
      fillPreview = to.r1 === s.r1 && to.r2 === s.r2 && to.c1 === s.c1 && to.c2 === s.c2 ? null : to;
      overlays();
    }
  }

  function autoScroll() {
    if (!drag || !lastMove || drag.kind === "resize" || drag.kind === "tap") return;
    const rect = scroller.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (lastMove.x > rect.right - 8) dx = Math.min(60, lastMove.x - rect.right + 20);
    else if (lastMove.x < rect.left + leftW() && drag.area !== "row" && scroller.scrollLeft > 0) dx = -Math.min(60, rect.left + leftW() - lastMove.x + 20);
    if (lastMove.y > rect.bottom - 8) dy = Math.min(80, lastMove.y - rect.bottom + 24);
    else if (lastMove.y < rect.top + topH() && drag.area !== "col" && scroller.scrollTop > 0) dy = -Math.min(80, rect.top + topH() - lastMove.y + 24);
    if (!dx && !dy) return;
    scroller.scrollLeft += dx;
    scroller.scrollTop += dy;
    track();
  }

  function onPointerUp(event) {
    window.removeEventListener("pointermove", onPointerMove);
    clearInterval(autoTimer);
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "resize") {
      hideGuide();
      if (d.next && d.next !== Math.round(d.size)) hooks.onResize(d.edge.axis, d.edge.index, d.next);
    } else if (d.kind === "point") {
      hooks.onPoint(null, "end");
    } else if (d.kind === "fill") {
      const to = fillPreview;
      fillPreview = null;
      overlays();
      if (to) hooks.onFill(d.from, to);
    } else if (d.kind === "tap" && event && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 8) {
      hooks.onFocus?.(d.h);
      if (d.h.area === "cell" && hooks.pointing()) {
        hooks.onPoint({ r1: d.h.r, c1: d.h.c, r2: d.h.r, c2: d.h.c }, "start");
        hooks.onPoint(null, "end");
      } else hooks.onSelect(selectionFor(d.h));
    }
  }

  function startFill(event) {
    if (event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    hooks.onFocus?.();
    drag = { kind: "fill", from: { r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 } };
    lastMove = { x: event.clientX, y: event.clientY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    clearInterval(autoTimer);
    autoTimer = setInterval(autoScroll, 40);
  }

  function showGuide(axis, at) {
    guide.hidden = false;
    guide.className = `sht-guide is-${axis}`;
    if (axis === "col") {
      guide.style.transform = `translateX(${at - 1}px)`;
      guide.style.width = "";
      guide.style.height = "";
    } else {
      guide.style.transform = `translateY(${at - 1}px)`;
    }
  }
  const hideGuide = () => { guide.hidden = true; };

  function onDoubleClick(event) {
    if (!tab || event.target.closest(".sht-editor")) return;
    const h = hit(event.clientX, event.clientY);
    if (h.edge) hooks.onFit(h.edge.axis, h.edge.index);
    else if (h.area === "cell") hooks.onActivate(h.r, h.c);
  }

  function onContextMenu(event) {
    if (!tab || event.target.closest(".sht-editor")) return;
    event.preventDefault();
    const h = hit(event.clientX, event.clientY);
    const inside = h.area === "cell" ? h.r >= sel.r1 && h.r <= sel.r2 && h.c >= sel.c1 && h.c <= sel.c2 : h.area === "col" ? h.c >= sel.c1 && h.c <= sel.c2 && sel.r1 === 0 && sel.r2 === tab.rows - 1 : h.area === "row" ? h.r >= sel.r1 && h.r <= sel.r2 && sel.c1 === 0 && sel.c2 === tab.cols - 1 : true;
    if (!inside) hooks.onSelect(selectionFor(h));
    hooks.onMenu({ x: event.clientX, y: event.clientY }, h);
  }

  function onHover(event) {
    if (drag || !tab) return;
    const h = hit(event.clientX, event.clientY);
    scroller.classList.toggle("is-col-resize", h.edge?.axis === "col");
    scroller.classList.toggle("is-row-resize", h.edge?.axis === "row");
  }

  scroller.addEventListener("pointerdown", onPointerDown);
  scroller.addEventListener("pointermove", onHover);
  scroller.addEventListener("dblclick", onDoubleClick);
  scroller.addEventListener("contextmenu", onContextMenu);
  scroller.addEventListener("scroll", () => paint(), { passive: true });
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => paint()) : null;
  resizeObserver?.observe(scroller);
  let flashTimer = null;

  // ---- the surface the tab uses ----

  return {
    node,
    scroller,
    /** A new tab, or new sizes or freeze on this one; `keepScroll` false scrolls back to the start. */
    setTab(next, { keepScroll = true } = {}) {
      const switched = !tab || next.id !== tab.id;
      tab = next;
      layout();
      ver += 1;
      if (switched || !keepScroll) {
        for (const q of quads) {
          for (const n of q.nodes.values()) n.remove();
          q.nodes.clear();
        }
        scroller.scrollTop = 0;
        scroller.scrollLeft = 0;
      }
      paint();
      overlays();
    },
    /** The values changed: every cell in sight is drawn again. */
    invalidate() {
      ver += 1;
      paint();
    },
    setSelection(next) {
      sel = next;
      paintHeads(lastWin ?? windowOf());
      overlays();
    },
    get selection() {
      return sel;
    },
    setRefs(list) {
      refs = list;
      overlays();
    },
    setCopy(range) {
      copyRange = range;
      overlays();
    },
    flash(ranges, ms = 2000) {
      const until = Date.now() + ms;
      for (const range of ranges) flashes.push({ range, until });
      overlays();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(overlays, ms + 20);
    },
    /** Scrolls the body so cell (r, c) is in sight; frozen cells are always in sight on their axis. */
    reveal(r, c) {
      if (!tab) return;
      const vh = scroller.clientHeight;
      const vw = scroller.clientWidth;
      if (r >= fr) {
        const top0 = R.start(r) - fh();
        const bottom = top0 + R.size(r);
        const room = vh - topH();
        if (top0 < scroller.scrollTop) scroller.scrollTop = top0;
        else if (bottom > scroller.scrollTop + room) scroller.scrollTop = bottom - room;
      }
      if (c >= fc) {
        const left0 = C.start(c) - fw();
        const right = left0 + C.size(c);
        const room = vw - leftW();
        if (left0 < scroller.scrollLeft) scroller.scrollLeft = left0;
        else if (right > scroller.scrollLeft + room) scroller.scrollLeft = Math.min(left0, right - room);
      }
      paint();
    },
    /** Back to the top-left corner, frozen panes or not (ctrl+Home). */
    home() {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      paint();
    },
    /** Where cell (r, c) is: the overlay layer of its quadrant and its box there, for the in-cell editor. */
    cellBox(r, c) {
      const q = quads.find((x) => r >= x.rows[0] && r < x.rows[1] && c >= x.cols[0] && c < x.cols[1]) ?? Q.main;
      return { layer: q.ov, x: q.x(c), y: q.y(r), w: C.size(c), h: R.size(r), maxW: q === Q.main || q === Q.top ? Math.max(C.size(c), scroller.clientWidth - (q.x(c) - scroller.scrollLeft) - 8) : C.size(c) * 3 };
    },
    /** The node the editor lives in, kept when the overlays are drawn again. */
    setEditor(n) {
      editorNode = n;
      node.classList.toggle("is-editing", Boolean(n));
    },
    /** Rows that fit in the body at once, for PageUp and PageDown. */
    pageRows() {
      if (!tab) return 20;
      const room = scroller.clientHeight - topH();
      return Math.max(1, Math.floor(room / 24) - 1);
    },
    /** The text width a column needs, for double-click fitting. */
    measure,
    get frozen() {
      return { rows: fr, cols: fc };
    },
    dispose() {
      resizeObserver?.disconnect();
      clearInterval(autoTimer);
      clearTimeout(flashTimer);
      window.removeEventListener("pointermove", onPointerMove);
      node.remove();
    },
  };
}
