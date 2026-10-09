/* A sheet as a tab: the toolbar, the formula bar, the grid, the tabs strip and the status strip. It reads the
 * workbook once and then keeps a local copy that every edit changes at once (`applyOps`, then `compute`),
 * while the ops go out behind it with `save` — queued, sent in order, one request at a time, coalesced over
 * a short pause — and the answered revision is recorded as the page's own. Another writer's revision makes
 * it read the workbook again and lay the ops not yet sent on top, keeping the selection, the scroll and an
 * edit in progress, and flash the cells the agent changed with a note naming it. Undo and redo are the
 * person's own edits, each kept as the ops that reverse it. The keyboard model, the clipboard and the
 * menus live here; the grid draws and reports pointer gestures, the editor edits text. */

import { addr, boundingBox, colName, parseAddr, parseQualified, parseRange, rangeText } from "./core/address.js";
import { compute } from "./core/engine.js";
import { alignOf, formatValue, PRESETS } from "./core/format.js";
import { editText, parseInput } from "./core/input.js";
import { isError } from "./core/values.js";
import { applyOps, findTab, LIMITS, newTabId, usedRange, validTabName } from "./core/workbook.js";
import { copyBlock, forgetCopy, lastCopy, pastePlan } from "./clipboard.js";
import { createEditor } from "./editor.js";
import { createGrid } from "./grid.js";
import { ALIGN_CENTER, ALIGN_LEFT, ALIGN_RIGHT, BOLD, CARET, DOWNLOAD, FILL, FREEZE, FX, ITALIC, MORE, PLUS, REDO, STRIKE, TEXT_COLOR, TRASH, UNDERLINE, UNDO, UPLOAD, WRAP } from "./icons.js";
import { clearValuesOp, inverseOf, keysIn, rangeArg, styleOps } from "./ops.js";
import { openPalette } from "./palette.js";
import { download } from "./sidebar.js";

const COALESCE_MS = 150;
const NOTE_MS = 6000;
const MAX_ROWS = LIMITS?.rows ?? 20000;
const MAX_COLS = LIMITS?.cols ?? 702;
const HISTORY = 200;
const MAX_OPS = 1000; // a save takes at most this many; the rest go in the next

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform ?? "");

/** A formula typed without its last closing parentheses gets them, as spreadsheets do. */
export function closeCalls(text) {
  if (!text.startsWith("=")) return text;
  let depth = 0;
  let inStr = false;
  for (const ch of text) {
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "(") depth += 1;
    else if (!inStr && ch === ")") depth -= 1;
  }
  return !inStr && depth > 0 ? text + ")".repeat(depth) : text;
}

export function openSheetTab(ext, model, root, handle) {
  const { el, icon } = ext.dom;
  const id = handle.id;
  let wb = null; // the local workbook: the server's plus every op not yet answered
  let values = null; // compute(wb)
  let tabId = null;
  let sel = { r: 0, c: 0, ar: 0, ac: 0, er: 0, ec: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
  const perTab = new Map(); // tab id -> the selection last left there
  let rev = 0; // the server revision the local copy is based on
  let seenRev = 0; // changes up to this revision have been looked at for flashing
  let queue = []; // ops not yet sent
  let sending = false;
  let foreign = 0; // the newest revision another writer made while a save was out
  let needReload = false;
  let flushTimer = null;
  let gone = false;
  let active = false;
  let started = false;
  const history = { undo: [], redo: [] };
  let noteTimer = null;

  const tab = () => findTab(wb, tabId) ?? wb.tabs[0];
  const agentName = () => ext.agent?.name || "Thetis";

  // ---- the chrome ----

  const tool = (label, path, run, extra = {}) => el("button", { type: "button", class: "icon-btn sm sht-tool", title: label, "aria-label": label, onClick: run, ...extra }, icon(path, { size: 15, width: 1.7 }));
  const titleBtn = el("button", { type: "button", class: "sht-title", title: "Rename this sheet", onClick: () => renameTitle() }, "…");
  const undoBtn = tool(`Undo (${isMac ? "⌘" : "Ctrl+"}Z)`, UNDO, () => undo());
  const redoBtn = tool(`Redo (${isMac ? "⌘⇧" : "Ctrl+"}${isMac ? "Z" : "Y"})`, REDO, () => redo());
  const fmtBtn = el("button", { type: "button", class: "sht-fmt", title: "Number format", "aria-label": "Number format", onClick: () => formatMenu() }, el("span", { class: "sht-fmt-label" }, "123"), icon(CARET, { size: 12, width: 1.8 }));
  const boldBtn = tool(`Bold (${isMac ? "⌘" : "Ctrl+"}B)`, BOLD, () => toggleStyle("b"), { "aria-pressed": "false" });
  const italicBtn = tool(`Italic (${isMac ? "⌘" : "Ctrl+"}I)`, ITALIC, () => toggleStyle("i"), { "aria-pressed": "false" });
  const underBtn = tool(`Underline (${isMac ? "⌘" : "Ctrl+"}U)`, UNDERLINE, () => toggleStyle("u"), { "aria-pressed": "false" });
  const strikeBtn = tool("Strikethrough", STRIKE, () => toggleStyle("s"), { "aria-pressed": "false" });
  const colorBar = el("span", { class: "sht-color-bar" });
  const fillBar = el("span", { class: "sht-color-bar" });
  const colorBtn = el("button", { type: "button", class: "icon-btn sm sht-tool sht-colored", title: "Text colour", "aria-label": "Text colour", onClick: () => colorMenu("color", colorBtn) }, icon(TEXT_COLOR, { size: 15, width: 1.7 }), colorBar);
  const fillBtn = el("button", { type: "button", class: "icon-btn sm sht-tool sht-colored", title: "Fill colour", "aria-label": "Fill colour", onClick: () => colorMenu("fill", fillBtn) }, icon(FILL, { size: 15, width: 1.7 }), fillBar);
  const alignBtns = {
    left: tool("Align left", ALIGN_LEFT, () => setAlign("left"), { "aria-pressed": "false" }),
    center: tool("Align centre", ALIGN_CENTER, () => setAlign("center"), { "aria-pressed": "false" }),
    right: tool("Align right", ALIGN_RIGHT, () => setAlign("right"), { "aria-pressed": "false" }),
  };
  const wrapBtn = tool("Wrap text", WRAP, () => toggleStyle("wrap"), { "aria-pressed": "false" });
  const freezeBtn = tool("Freeze rows and columns", FREEZE, () => freezeMenu());
  const note = el("span", { class: "sht-note", hidden: true, role: "status" });
  const moreBtn = tool("More", MORE, () => moreMenu());
  const sep = () => el("span", { class: "sht-sep" });
  const toolbar = el("div", { class: "sht-toolbar", role: "toolbar", "aria-label": "Sheet" },
    titleBtn, sep(), undoBtn, redoBtn, sep(), fmtBtn, sep(), boldBtn, italicBtn, underBtn, strikeBtn, colorBtn, fillBtn, sep(),
    alignBtns.left, alignBtns.center, alignBtns.right, wrapBtn, sep(), freezeBtn, el("span", { class: "sht-gap" }), note, moreBtn);

  const addrBox = el("input", { type: "text", class: "sht-addr", "aria-label": "Cell address; type one to go there", spellcheck: "false", autocomplete: "off" });
  const bar = el("textarea", { class: "sht-fx-input", rows: "1", spellcheck: "false", "aria-label": "Formula bar", autocomplete: "off" });
  const fxbar = el("div", { class: "sht-fxbar" }, addrBox, el("span", { class: "sht-fx-icon", "aria-hidden": "true" }, icon(FX, { size: 15, width: 1.5 })), bar);
  const banner = el("div", { class: "sht-banner", hidden: true });
  const body = el("div", { class: "sht-body" });
  const tabsStrip = el("div", { class: "sht-tabs", role: "tablist", "aria-label": "Tabs" });
  const status = el("div", { class: "sht-status", "aria-live": "polite" });
  const saveState = el("span", { class: "sht-save" });
  const foot = el("div", { class: "sht-foot" }, el("button", { type: "button", class: "icon-btn sm sht-tab-add", title: "Add a tab", "aria-label": "Add a tab", onClick: () => addTab() }, icon(PLUS, { size: 14, width: 1.8 })), tabsStrip, status, saveState);
  const sink = el("textarea", { class: "sht-sink", "aria-label": "Spreadsheet", "aria-multiline": "false", spellcheck: "false", autocomplete: "off", tabindex: "0" });
  const node = el("div", { class: "sht-tab", "data-sheet": id }, toolbar, fxbar, banner, body, foot);
  root.append(node);
  body.append(el("div", { class: "sht-loading" }, "Loading…"));

  // ---- the grid and the editor ----

  const grid = createGrid(ext, {
    view: cellView,
    filled: (r, c) => tab().cells[addr(r, c)] !== undefined,
    pointing: () => editor.open && editor.canPoint(),
    onSelect: (next) => setSel(next, { reveal: false }),
    onPoint: (range, phase) => editor.point(range, phase),
    onActivate: (r, c) => { setSel(single(r, c), { reveal: false }); startEdit({ mode: "edit" }); },
    onFill: (from, to) => fill(from, to),
    onResize: (axis, index, px) => resize(axis, index, px),
    onFit: (axis, index) => fit(axis, index),
    onMenu: (at, h) => cellMenu(at, h),
    onFocus: (h) => {
      if (editor.open) {
        if (h && h.area === "cell" && editor.canPoint()) return;
        editor.commit({ dr: 0, dc: 0 });
      }
      focusSink();
    },
  });
  const editor = createEditor(ext, {
    grid,
    bar,
    host: node,
    tabName: () => tab()?.name ?? "",
    limits: () => ({ rows: tab().rows, cols: tab().cols }),
    onCommit: (text, move, at) => commitEdit(text, move, at),
    onCancel: () => { drawBar(); focusSink(); },
  });
  grid.node.append(sink);

  function single(r, c) {
    return { r, c, ar: r, ac: c, er: r, ec: c, r1: r, c1: c, r2: r, c2: c };
  }

  function focusSink() {
    if (!active && document.activeElement !== sink && !node.contains(document.activeElement)) return;
    sink.focus({ preventScroll: true });
    sink.value = " ";
    sink.select();
  }

  // ---- what a cell shows ----

  function cellView(r, c) {
    const t = tab();
    const key = addr(r, c);
    const raw = t.cells[key];
    const st = t.styles?.[key];
    if (raw === undefined && !st) return null;
    if (raw === undefined) {
      if (!st.fill) return null;
      return { text: "", align: "left", kind: "empty", fill: st.fill };
    }
    const v = values ? values.value(t.id, key) : raw;
    const err = isError(v);
    let text;
    try {
      text = formatValue(v, st?.fmt ?? null);
    } catch {
      text = String(v);
    }
    return {
      text,
      align: st?.align ?? (err ? "center" : alignOf(v)),
      kind: err ? "err" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : "text",
      b: st?.b, i: st?.i, u: st?.u, s: st?.s, wrap: st?.wrap,
      color: st?.color, fill: st?.fill,
      title: err ? v.msg || v.err : null,
    };
  }

  /** The text a cell shows, for copying and the status strip. */
  function display(r, c) {
    const t = tab();
    const key = addr(r, c);
    if (t.cells[key] === undefined) return "";
    const v = values ? values.value(t.id, key) : t.cells[key];
    try {
      return formatValue(v, t.styles?.[key]?.fmt ?? null);
    } catch {
      return String(v);
    }
  }

  const rawAt = (r, c) => tab().cells[addr(r, c)];
  const styleAt = (r, c) => tab().styles?.[addr(r, c)] ?? {};
  const textAt = (r, c) => {
    const raw = rawAt(r, c);
    return raw === undefined ? "" : editText(raw, styleAt(r, c));
  };

  // ---- drawing the chrome ----

  function recompute() {
    try {
      values = compute(wb);
    } catch (err) {
      console.error("sheets: compute failed:", err);
      values = null;
    }
  }

  function drawTitle() {
    titleBtn.textContent = wb.title;
    titleBtn.title = `${wb.title} — click to rename`;
    handle.setTitle(wb.title);
  }

  function drawBar() {
    if (!wb) return;
    const t = tab();
    if (document.activeElement !== addrBox) addrBox.value = sel.r1 === sel.r2 && sel.c1 === sel.c2 ? addr(sel.r, sel.c) : rangeText(sel);
    if (!editor.open) bar.value = textAt(sel.r, sel.c);
    const st = styleAt(sel.r, sel.c);
    const press = (b, on) => { b.setAttribute("aria-pressed", String(Boolean(on))); b.classList.toggle("is-on", Boolean(on)); };
    press(boldBtn, st.b);
    press(italicBtn, st.i);
    press(underBtn, st.u);
    press(strikeBtn, st.s);
    press(wrapBtn, st.wrap);
    for (const [k, b] of Object.entries(alignBtns)) press(b, st.align === k);
    colorBar.style.backgroundColor = st.color ?? "";
    fillBar.style.backgroundColor = st.fill ?? "";
    const preset = PRESETS.find((p) => (p.fmt ?? null) === (st.fmt ?? null));
    fmtBtn.querySelector(".sht-fmt-label").textContent = preset ? (preset.id === "general" ? "123" : preset.label) : st.fmt;
    freezeBtn.classList.toggle("is-on", Boolean(t.freeze?.rows || t.freeze?.cols));
  }

  function drawHistory() {
    undoBtn.disabled = !history.undo.length;
    redoBtn.disabled = !history.redo.length;
  }

  function drawStatus() {
    status.replaceChildren();
    if (!wb || (sel.r1 === sel.r2 && sel.c1 === sel.c2)) return;
    const t = tab();
    const area = (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1);
    const keys = Object.keys(t.cells).length < area ? keysIn(t.cells, sel) : null;
    let sum = 0;
    let count = 0;
    let filled = 0;
    let fmt = null;
    const take = (key) => {
      if (t.cells[key] === undefined) return;
      filled += 1;
      const v = values ? values.value(t.id, key) : t.cells[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        count += 1;
        if (fmt === null) fmt = t.styles?.[key]?.fmt ?? null;
      }
    };
    if (keys) keys.forEach(take);
    else for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) take(addr(r, c));
    const f = (n) => {
      try {
        return formatValue(n, fmt && !/@/.test(fmt) ? fmt : null);
      } catch {
        return String(n);
      }
    };
    if (count) {
      status.append(
        el("span", { class: "sht-stat" }, el("span", { class: "sht-stat-k" }, "Sum"), el("span", { class: "sht-stat-v", "data-stat": "sum" }, f(sum))),
        el("span", { class: "sht-stat" }, el("span", { class: "sht-stat-k" }, "Average"), el("span", { class: "sht-stat-v", "data-stat": "average" }, f(sum / count))),
        el("span", { class: "sht-stat" }, el("span", { class: "sht-stat-k" }, "Count"), el("span", { class: "sht-stat-v", "data-stat": "count" }, String(count)))
      );
    } else if (filled) status.append(el("span", { class: "sht-stat" }, el("span", { class: "sht-stat-k" }, "Count"), el("span", { class: "sht-stat-v", "data-stat": "count" }, String(filled))));
  }

  function drawSave() {
    const busy = sending || queue.length > 0;
    saveState.textContent = gone ? "" : busy ? "Saving…" : model.status === "lost" ? "Offline" : "Saved";
    saveState.classList.toggle("is-busy", busy);
  }

  let renamingTab = null;
  function drawTabs() {
    tabsStrip.replaceChildren();
    for (const t of wb.tabs) {
      if (renamingTab === t.id) {
        tabsStrip.append(tabRenameField(t));
        continue;
      }
      const b = el("button", { type: "button", role: "tab", class: `sht-tabbtn${t.id === tabId ? " is-on" : ""}`, "aria-selected": String(t.id === tabId), "data-tab": t.id, title: `${t.name} — double-click to rename`, onClick: () => switchTab(t.id), onDblclick: () => { renamingTab = t.id; drawTabs(); } }, t.name);
      b.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        tabMenu({ x: event.clientX, y: event.clientY }, t);
      });
      tabsStrip.append(b);
    }
  }

  function redraw({ layout = false } = {}) {
    if (!wb) return;
    if (layout) {
      grid.setTab(tab());
      editor.reposition();
    } else grid.invalidate();
    clampSel();
    grid.setSelection(sel);
    drawTitle();
    drawBar();
    drawTabs();
    drawStatus();
    drawHistory();
    drawSave();
  }

  // ---- selection ----

  function clampSel() {
    const t = tab();
    const R = t.rows - 1;
    const C = t.cols - 1;
    sel = { r: clamp(sel.r, 0, R), c: clamp(sel.c, 0, C), ar: clamp(sel.ar, 0, R), ac: clamp(sel.ac, 0, C), er: clamp(sel.er ?? sel.r, 0, R), ec: clamp(sel.ec ?? sel.c, 0, C), r1: clamp(sel.r1, 0, R), c1: clamp(sel.c1, 0, C), r2: clamp(sel.r2, 0, R), c2: clamp(sel.c2, 0, C) };
  }

  function setSel(next, { reveal = true } = {}) {
    sel = { ...next };
    if (sel.er === undefined) {
      sel.er = sel.r === sel.r1 ? sel.r2 : sel.r1;
      sel.ec = sel.c === sel.c1 ? sel.c2 : sel.c1;
    }
    clampSel();
    grid.setSelection(sel);
    if (reveal) grid.reveal(sel.er, sel.ec);
    drawBar();
    drawStatus();
  }

  const filledAt = (r, c) => tab().cells[addr(r, c)] !== undefined;

  /** Where ctrl+arrow lands from (r, c): the edge of the data run, or the next data, or the grid's edge. */
  function dataEdge(r, c, dr, dc) {
    const t = tab();
    const inside = (y, x) => y >= 0 && y < t.rows && x >= 0 && x < t.cols;
    if (!inside(r + dr, c + dc)) return { r, c };
    let y = r + dr;
    let x = c + dc;
    if (filledAt(r, c) && filledAt(y, x)) {
      while (inside(y + dr, x + dc) && filledAt(y + dr, x + dc)) { y += dr; x += dc; }
      return { r: y, c: x };
    }
    while (inside(y, x) && !filledAt(y, x)) {
      if (!inside(y + dr, x + dc)) return { r: y, c: x };
      y += dr;
      x += dc;
    }
    return { r: y, c: x };
  }

  function move(dr, dc, { extend = false, edge = false } = {}) {
    const t = tab();
    if (extend) {
      const from = { r: sel.er, c: sel.ec };
      const to = edge ? dataEdge(from.r, from.c, dr, dc) : { r: clamp(from.r + dr, 0, t.rows - 1), c: clamp(from.c + dc, 0, t.cols - 1) };
      setSel({ r: sel.r, c: sel.c, ar: sel.r, ac: sel.c, er: to.r, ec: to.c, r1: Math.min(sel.r, to.r), c1: Math.min(sel.c, to.c), r2: Math.max(sel.r, to.r), c2: Math.max(sel.c, to.c) });
      return;
    }
    const to = edge ? dataEdge(sel.r, sel.c, dr, dc) : { r: clamp(sel.r + dr, 0, t.rows - 1), c: clamp(sel.c + dc, 0, t.cols - 1) };
    setSel(single(to.r, to.c));
  }

  /** Enter and Tab inside a selection of several cells walk it, as spreadsheets do; else they move. */
  function step(dr, dc) {
    const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2;
    if (!multi) return move(dr, dc);
    let r = sel.r + dr;
    let c = sel.c + dc;
    if (c > sel.c2) { c = sel.c1; r += 1; }
    if (c < sel.c1) { c = sel.c2; r -= 1; }
    if (r > sel.r2) { r = sel.r1; if (dc) c = sel.c1; }
    if (r < sel.r1) { r = sel.r2; if (dc) c = sel.c2; }
    setSel({ ...sel, r, c, er: sel.er, ec: sel.ec });
  }

  // ---- changing the workbook ----

  /**
   * Applies ops locally at once and queues them for the server. `record` keeps the reversing ops for undo
   * (or for redo, `into: "redo"`); a new edit clears the redo list, an undo or redo being replayed does not. Answers the applyOps result, or null after a refusal (toasted).
   */
  function apply(ops, { record = true, layout = false, into = "undo", replaying = false } = {}) {
    if (!wb || gone || !ops.length) return null;
    let res;
    try {
      res = applyOps(wb, ops);
    } catch (err) {
      ext.toast(err.message || String(err), { tone: "error" });
      return null;
    }
    let inverse = [];
    try {
      inverse = inverseOf(wb, res.workbook, ops, res.ranges);
    } catch (err) {
      console.warn("sheets: no undo for this edit:", err);
    }
    const before = wb;
    wb = res.workbook;
    if (!findTab(wb, tabId)) tabId = wb.tabs[0].id;
    if (record && inverse.length) {
      const entry = { ops: inverse, tab: tabId };
      if (into === "undo") {
        if (!replaying) history.redo = []; // a new edit ends the line redo would follow
        history.undo.push(entry);
        if (history.undo.length > HISTORY) history.undo.shift();
      } else history.redo.push(entry);
    }
    queue.push(...ops);
    recompute();
    const t = tab();
    const bt = findTab(before, t.id);
    const geometry = layout || !bt || bt.rows !== t.rows || bt.cols !== t.cols || bt.widths !== t.widths || bt.heights !== t.heights || bt.freeze?.rows !== t.freeze?.rows || bt.freeze?.cols !== t.freeze?.cols;
    redraw({ layout: geometry });
    schedule();
    return res;
  }

  function schedule() {
    drawSave();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), COALESCE_MS);
  }

  async function flush() {
    if (sending || !queue.length || gone) return;
    sending = true;
    foreign = 0;
    const ops = queue.slice(0, MAX_OPS);
    queue = queue.slice(MAX_OPS);
    drawSave();
    try {
      const out = await model.save(id, ops, rev);
      if (typeof out.rev === "number") rev = Math.max(rev, out.rev);
      if (out.merged || foreign > (out.rev ?? 0)) needReload = true;
    } catch (err) {
      ext.toast(`The change was not saved: ${err.message}`, { tone: "error" });
      if (/No sheet/i.test(err.message)) {
        sending = false;
        return showGone();
      }
      needReload = true;
    } finally {
      sending = false;
    }
    drawSave();
    if (queue.length) return void flush();
    if (needReload) await reload();
  }

  async function reload() {
    if (gone) return;
    needReload = false;
    let fresh;
    try {
      fresh = (await model.get(id)).sheet;
    } catch (err) {
      if (/No sheet/i.test(err.message)) return showGone();
      ext.toast(`The sheet could not be read: ${err.message}`, { tone: "error" });
      return;
    }
    if (!fresh) return;
    if (sending) {
      needReload = true; // a save went out meanwhile: read again once it is answered
      return;
    }
    let next = fresh;
    const kept = [];
    for (const op of queue) {
      try {
        next = applyOps(next, [op]).workbook;
        kept.push(op);
      } catch {
        /* an unsent edit the other writer's change made impossible is dropped */
      }
    }
    queue = kept;
    const changes = (fresh.changes ?? []).filter((ch) => ch.rev > seenRev && ch.by === "agent");
    seenRev = Math.max(seenRev, fresh.rev);
    rev = Math.max(rev, fresh.rev);
    const before = wb;
    wb = next;
    if (!findTab(wb, tabId)) tabId = wb.tabs[0].id;
    recompute();
    const t = tab();
    const bt = before && findTab(before, t.id);
    const geometry = !bt || bt.rows !== t.rows || bt.cols !== t.cols || JSON.stringify(bt.widths) !== JSON.stringify(t.widths) || JSON.stringify(bt.heights) !== JSON.stringify(t.heights) || JSON.stringify(bt.freeze) !== JSON.stringify(t.freeze);
    redraw({ layout: geometry });
    if (changes.length) showAgentChanges(changes);
  }

  function showAgentChanges(changes) {
    const here = [];
    const elsewhere = new Set();
    for (const ch of changes) {
      for (const { tab: tid, range } of ch.ranges ?? []) {
        const t = findTab(wb, tid);
        if (!t) continue;
        if (t.id !== tabId) {
          elsewhere.add(t.name);
          continue;
        }
        const r = parseRange(String(range), { rows: t.rows, cols: t.cols });
        if (r) here.push({ r, text: String(range) });
      }
    }
    if (here.length) grid.flash(here.map((h) => h.r));
    const parts = here.length > 1 ? [rangeText(boundingBox(here.map((h) => h.r)))] : here.map((h) => h.text);
    const shown = parts.slice(0, 3).join(", ") + (parts.length > 3 ? ` and ${parts.length - 3} more` : "");
    const other = [...elsewhere];
    const text = shown ? `${agentName()} changed ${shown}${other.length ? ` and ${other.join(", ")}` : ""}` : other.length ? `${agentName()} changed ${other.join(", ")}` : `${agentName()} changed this sheet`;
    note.textContent = text;
    note.hidden = false;
    note.classList.remove("is-fading");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note.classList.add("is-fading");
      noteTimer = setTimeout(() => { note.hidden = true; }, 600);
    }, NOTE_MS);
  }

  function showGone() {
    gone = true;
    clearTimeout(flushTimer);
    banner.hidden = false;
    banner.replaceChildren(el("span", {}, "This sheet was deleted."), el("button", { type: "button", class: "btn is-quiet", onClick: () => handle.close() }, "Close the tab"));
    node.classList.add("is-gone");
    drawSave();
  }

  // ---- undo ----

  function replay(from, into) {
    const entry = history[from].pop();
    if (!entry) return;
    if (findTab(wb, entry.tab)) tabId = entry.tab;
    const res = apply(entry.ops, { into, layout: true, replaying: true });
    if (!res) {
      drawHistory();
      return;
    }
    const mine = res.ranges.filter((r) => findTab(wb, r.tab)?.id === tabId);
    if (mine.length) {
      const t = tab();
      const r = parseRange(String(mine[0].range), { rows: t.rows, cols: t.cols });
      if (r) {
        setSel({ r: r.r1, c: r.c1, ar: r.r1, ac: r.c1, er: r.r2, ec: r.c2, ...r }, { reveal: false });
        grid.reveal(r.r1, r.c1);
      }
    }
    drawHistory();
  }
  const undo = () => { if (editor.open) editor.commit(); replay("undo", "redo"); focusSink(); };
  const redo = () => { if (editor.open) editor.commit(); replay("redo", "undo"); focusSink(); };

  // ---- editing ----

  function startEdit({ mode = "edit", value, from = "cell", select = false } = {}) {
    if (!wb || gone) return;
    grid.reveal(sel.r, sel.c);
    editor.start({ r: sel.r, c: sel.c, value: value ?? textAt(sel.r, sel.c), mode, from, select });
  }

  function commitEdit(text, mv, at) {
    const t = tab();
    const key = addr(at.r, at.c);
    const old = textAt(at.r, at.c);
    if (text !== old) {
      const parsed = parseInput(closeCalls(text));
      const raw = parsed.raw === undefined ? null : parsed.raw;
      if (!(raw === null && t.cells[key] === undefined)) {
        apply([{ op: "set", tab: t.id, cells: { [key]: raw }, ...(parsed.fmt ? { fmts: { [key]: parsed.fmt } } : {}) }]);
      }
    }
    if (mv.dr || mv.dc) {
      if (sel.r === at.r && sel.c === at.c) step(mv.dr, mv.dc);
      else setSel(single(clamp(at.r + mv.dr, 0, t.rows - 1), clamp(at.c + mv.dc, 0, t.cols - 1)));
    } else drawBar();
    focusSink();
  }

  /** The shell's menu, with the keys handed back to the grid after a choice (a menu at a point gives focus back to nobody). */
  function menu(at, items) {
    return ext.ui.menu(at, items.map((item) => (item === "-" || !item.run ? item : { ...item, run: () => { item.run(); setTimeout(() => { if (!editor.open && !renamingTitle && renamingTab === null && !node.querySelector(".sht-palette")) focusSink(); }, 0); } })));
  }

  // ---- formatting ----

  const selRange = () => ({ r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 });

  function style(patch) {
    if (editor.open) editor.commit();
    apply([{ op: "style", tab: tab().id, range: rangeArg(selRange()), style: patch }]);
    focusSink();
  }
  function toggleStyle(key) {
    style({ [key]: styleAt(sel.r, sel.c)[key] ? null : true });
  }
  function setAlign(align) {
    style({ align: styleAt(sel.r, sel.c).align === align ? null : align });
  }

  function formatMenu() {
    const current = styleAt(sel.r, sel.c).fmt ?? null;
    menu(fmtBtn, PRESETS.map((p) => ({ label: `${(p.fmt ?? null) === current ? "✓ " : ""}${p.label}`, hint: p.fmt ?? "As typed", run: () => style({ fmt: p.fmt ?? null }) })));
  }

  function colorMenu(key, anchor) {
    openPalette(ext, node, anchor, { title: key === "fill" ? "Fill colour" : "Text colour", current: styleAt(sel.r, sel.c)[key] ?? null, pick: (hex) => style({ [key]: hex }) });
  }

  function freezeMenu() {
    const t = tab();
    const f = t.freeze ?? { rows: 0, cols: 0 };
    const set = (rows, cols) => apply([{ op: "freeze", tab: t.id, rows, cols }], { layout: true });
    const mark = (on, label) => `${on ? "✓ " : ""}${label}`;
    menu(freezeBtn, [
      { label: mark(f.rows === 0, "No rows"), run: () => set(0, f.cols) },
      { label: mark(f.rows === 1, "1 row"), run: () => set(1, f.cols) },
      { label: mark(f.rows === 2, "2 rows"), run: () => set(2, f.cols) },
      { label: mark(f.rows === sel.r + 1 && sel.r > 1, `Up to row ${sel.r + 1}`), disabled: sel.r + 1 >= t.rows, run: () => set(sel.r + 1, f.cols) },
      "-",
      { label: mark(f.cols === 0, "No columns"), run: () => set(f.rows, 0) },
      { label: mark(f.cols === 1, "1 column"), run: () => set(f.rows, 1) },
      { label: mark(f.cols === 2, "2 columns"), run: () => set(f.rows, 2) },
      { label: mark(f.cols === sel.c + 1 && sel.c > 1, `Up to column ${colName(sel.c)}`), disabled: sel.c + 1 >= t.cols, run: () => set(f.rows, sel.c + 1) },
    ]);
  }

  // ---- the title ----

  let renamingTitle = false;
  function renameTitle() {
    if (renamingTitle || !wb || gone) return;
    renamingTitle = true;
    const input = el("input", { type: "text", class: "sht-title-edit", value: wb.title, "aria-label": "Sheet name", spellcheck: "false" });
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      renamingTitle = false;
      const title = input.value.trim();
      input.replaceWith(titleBtn);
      if (commit && title && title !== wb.title) apply([{ op: "title", title }]);
      focusSink();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    titleBtn.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- tabs ----

  function switchTab(next) {
    if (!wb || next === tabId) return;
    if (editor.open) editor.commit();
    perTab.set(tabId, sel);
    tabId = next;
    sel = perTab.get(next) ?? single(0, 0);
    grid.setTab(tab(), { keepScroll: false });
    redraw();
    forgetCopy();
    grid.setCopy(null);
    focusSink();
  }

  function uniqueName(base) {
    const taken = new Set(wb.tabs.map((t) => t.name.toLowerCase()));
    for (let n = wb.tabs.length + 1; ; n++) if (!taken.has(`${base}${n}`.toLowerCase())) return `${base}${n}`;
  }

  function addTab() {
    if (!wb || gone) return;
    if (editor.open) editor.commit();
    const newId = newTabId(wb);
    const res = apply([{ op: "addTab", name: uniqueName("Sheet"), id: newId }]);
    if (res) switchTab(newId);
  }

  function tabRenameField(t) {
    const input = el("input", { type: "text", class: "sht-tab-rename", value: t.name, "aria-label": "Tab name", spellcheck: "false" });
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      renamingTab = null;
      const name = input.value.trim();
      if (commit && name && name !== t.name) {
        const problem = validTabName(name, wb, t.id);
        if (problem) ext.toast(problem, { tone: "error" });
        else apply([{ op: "renameTab", tab: t.id, name }]);
      }
      drawTabs();
      focusSink();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return input;
  }

  function tabMenu(at, t) {
    const index = wb.tabs.findIndex((x) => x.id === t.id);
    menu(at, [
      { label: "Rename", run: () => { renamingTab = t.id; drawTabs(); } },
      { label: "Move left", disabled: index === 0, run: () => apply([{ op: "moveTab", tab: t.id, to: index - 1 }]) },
      { label: "Move right", disabled: index === wb.tabs.length - 1, run: () => apply([{ op: "moveTab", tab: t.id, to: index + 1 }]) },
      "-",
      { label: "Delete tab", icon: TRASH, danger: true, disabled: wb.tabs.length < 2, run: () => void removeTab(t) },
    ]);
  }

  async function removeTab(t) {
    const anchor = tabsStrip.querySelector(`[data-tab="${t.id}"]`) ?? tabsStrip;
    const ok = await ext.ui.confirm(anchor, { title: "Delete this tab?", lines: [["Tab", t.name], ["Cells", String(Object.keys(t.cells).length)]], note: "Formulas on other tabs that point here become #REF!. Undo brings it back.", confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    apply([{ op: "removeTab", tab: t.id }], { layout: true });
  }

  // ---- the sheet menu ----

  function moreMenu() {
    const t = tab();
    const xlsx = model.exportUrl(id, null, "xlsx");
    const csv = model.exportUrl(id, t.name, "csv");
    const tsv = model.exportUrl(id, t.name, "tsv");
    const raw = Boolean(ext.raw?.put);
    menu(moreBtn, [
      { label: "Import CSV as a new tab", icon: UPLOAD, hint: raw ? null : "This gateway cannot take files", disabled: !raw, run: () => pickImport() },
      { label: "Download every tab as .xlsx", icon: DOWNLOAD, hint: "For Google Sheets or Excel, formulas and formatting kept", disabled: !xlsx, run: () => download(ext, xlsx) },
      { label: "Download this tab as CSV", icon: DOWNLOAD, disabled: !csv, run: () => download(ext, csv) },
      { label: "Download this tab as TSV", icon: DOWNLOAD, disabled: !tsv, run: () => download(ext, tsv) },
      "-",
      { label: "Delete sheet", icon: TRASH, danger: true, run: () => void removeSheet() },
    ]);
  }

  function pickImport() {
    const input = el("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain", hidden: true });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const name = file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Imported";
        const out = await ext.raw.put("import", { id, name }, file);
        const tabOut = out?.data?.tab ?? out?.tab;
        await flushNow();
        await reload();
        if (tabOut && findTab(wb, tabOut)) switchTab(findTab(wb, tabOut).id);
        ext.toast(`Imported ${file.name}.`);
      } catch (err) {
        ext.toast(`The file was not imported: ${err.message}`, { tone: "error" });
      }
    });
    node.append(input);
    input.click();
  }

  async function flushNow() {
    clearTimeout(flushTimer);
    while (queue.length || sending) {
      if (!sending) await flush();
      else await new Promise((r) => setTimeout(r, 30));
    }
  }

  async function removeSheet() {
    const ok = await ext.ui.confirm(moreBtn, { title: "Delete this sheet?", lines: [["Sheet", wb?.title ?? id], ["Tabs", String(wb?.tabs.length ?? 0)]], note: "Every tab and cell is deleted for good.", confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    try {
      clearTimeout(flushTimer);
      queue = [];
      await model.remove(id);
      gone = true;
      handle.close();
    } catch (err) {
      ext.toast(`The sheet was not deleted: ${err.message}`, { tone: "error" });
    }
  }

  // ---- the grid's gestures ----

  function fill(from, to) {
    if (editor.open) editor.commit();
    const t = tab();
    const res = apply([{ op: "fill", tab: t.id, from: rangeArg(from), to: rangeArg(to) }]);
    if (res) setSel({ r: sel.r, c: sel.c, ar: sel.r, ac: sel.c, ...to, er: sel.r === to.r1 ? to.r2 : to.r1, ec: sel.c === to.c1 ? to.c2 : to.c1 });
  }

  function resize(axis, index, px) {
    const t = tab();
    const whole = axis === "col" ? sel.r1 === 0 && sel.r2 === t.rows - 1 && index >= sel.c1 && index <= sel.c2 : sel.c1 === 0 && sel.c2 === t.cols - 1 && index >= sel.r1 && index <= sel.r2;
    const from = whole ? (axis === "col" ? sel.c1 : sel.r1) : index;
    const to = whole ? (axis === "col" ? sel.c2 : sel.r2) : index;
    const map = {};
    for (let i = from; i <= to; i++) map[axis === "col" ? colName(i) : String(i + 1)] = px;
    apply([axis === "col" ? { op: "widths", tab: t.id, cols: map } : { op: "heights", tab: t.id, rows: map }], { layout: true });
  }

  function fit(axis, index) {
    const t = tab();
    if (axis === "row") return apply([{ op: "heights", tab: t.id, rows: { [String(index + 1)]: null } }], { layout: true });
    let widest = 0;
    for (const key of Object.keys(t.cells)) {
      const p = parseAddr(key);
      if (!p || p.col !== index) continue;
      const text = display(p.row, p.col);
      if (text) widest = Math.max(widest, grid.measure(text, Boolean(t.styles?.[key]?.b)));
    }
    const px = widest ? clamp(Math.ceil(widest + 16), 20, 1000) : null;
    apply([{ op: "widths", tab: t.id, cols: { [colName(index)]: px } }], { layout: true });
  }

  function cellMenu(at, h) {
    const t = tab();
    const rows = sel.r2 - sel.r1 + 1;
    const cols = sel.c2 - sel.c1 + 1;
    const n = (k, one, many) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
    const row = (k) => n(k, "row", "rows");
    const col = (k) => n(k, "column", "columns");
    const items = [];
    const rowItems = [
      { label: `Insert ${row(rows)} above`, run: () => structure({ op: "insertRows", at: sel.r1, count: rows }) },
      { label: `Insert ${row(rows)} below`, run: () => structure({ op: "insertRows", at: sel.r2 + 1, count: rows }) },
      { label: `Delete ${rows === 1 ? `row ${sel.r1 + 1}` : `rows ${sel.r1 + 1}–${sel.r2 + 1}`}`, danger: true, disabled: rows >= t.rows, run: () => structure({ op: "deleteRows", at: sel.r1, count: rows }) },
    ];
    const colItems = [
      { label: `Insert ${col(cols)} left`, run: () => structure({ op: "insertCols", at: sel.c1, count: cols }) },
      { label: `Insert ${col(cols)} right`, run: () => structure({ op: "insertCols", at: sel.c2 + 1, count: cols }) },
      { label: `Delete ${cols === 1 ? `column ${colName(sel.c1)}` : `columns ${colName(sel.c1)}–${colName(sel.c2)}`}`, danger: true, disabled: cols >= t.cols, run: () => structure({ op: "deleteCols", at: sel.c1, count: cols }) },
    ];
    const by = h.area === "row" ? sel.c : h.c;
    const sortItems = [
      { label: `Sort sheet A → Z by column ${colName(by)}`, run: () => sortBy(by, false) },
      { label: `Sort sheet Z → A by column ${colName(by)}`, run: () => sortBy(by, true) },
    ];
    const clearItem = { label: "Clear", key: "Delete", run: () => clearSelection() };
    if (h.area === "row") items.push(...rowItems, "-", clearItem);
    else if (h.area === "col") items.push(...colItems, "-", clearItem, "-", ...sortItems);
    else items.push(...rowItems, "-", ...colItems, "-", clearItem, "-", ...sortItems);
    menu(at, items);
  }

  function structure(op) {
    if (editor.open) editor.commit();
    const t = tab();
    const limit = op.op === "insertRows" ? MAX_ROWS - t.rows : op.op === "insertCols" ? MAX_COLS - t.cols : Infinity;
    if (op.count > limit) {
      ext.toast(limit > 0 ? `This tab can take only ${limit} more ${op.op === "insertRows" ? "rows" : "columns"}.` : `This tab is as large as a tab can be.`, { tone: "error" });
      return;
    }
    const res = apply([{ ...op, tab: t.id }], { layout: true });
    if (!res) return;
    if (op.op === "insertRows") setSel({ r: op.at, c: sel.c, ar: op.at, ac: sel.c, er: op.at + op.count - 1, ec: sel.ec, r1: op.at, r2: op.at + op.count - 1, c1: sel.c1, c2: sel.c2 }, { reveal: false });
    else if (op.op === "insertCols") setSel({ r: sel.r, c: op.at, ar: sel.r, ac: op.at, er: sel.er, ec: op.at + op.count - 1, r1: sel.r1, r2: sel.r2, c1: op.at, c2: op.at + op.count - 1 }, { reveal: false });
    else setSel(sel, { reveal: false });
    focusSink();
  }

  function sortBy(col, desc) {
    const t = tab();
    const used = usedRange(t);
    if (!used) return;
    const r1 = Math.max(used.r1, t.freeze?.rows ?? 0);
    if (r1 >= used.r2) return;
    apply([{ op: "sort", tab: t.id, range: rangeArg({ r1, c1: used.c1, r2: used.r2, c2: Math.max(used.c2, col) }), by: col, desc }]);
  }

  function clearSelection() {
    const op = clearValuesOp(tab(), selRange());
    if (op) apply([op]);
  }

  // ---- the address box ----

  addrBox.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      drawBar();
      focusSink();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = addrBox.value.trim();
    const q = parseQualified(text);
    let target = tab();
    if (q?.tab) {
      target = findTab(wb, q.tab);
      if (!target) {
        ext.toast(`No tab called ${q.tab}.`, { tone: "error" });
        return;
      }
    }
    const r = q && parseRange(q.range, { rows: target.rows, cols: target.cols });
    if (!r || r.r2 >= target.rows || r.c2 >= target.cols) {
      ext.toast("Type a cell like B12, a range like A1:C4, or a tab and a cell like Sheet2!A1.", { tone: "error" });
      return;
    }
    if (target.id !== tabId) switchTab(target.id);
    setSel({ r: r.r1, c: r.c1, ar: r.r1, ac: r.c1, er: r.r2, ec: r.c2, ...r });
    grid.reveal(r.r1, r.c1);
    addrBox.blur();
    focusSink();
  });
  addrBox.addEventListener("focus", () => addrBox.select());
  addrBox.addEventListener("blur", () => drawBar());

  // ---- the formula bar ----

  bar.addEventListener("focus", () => {
    if (!wb || gone || editor.open) return;
    const caret = bar.selectionStart;
    editor.start({ r: sel.r, c: sel.c, value: bar.value, mode: "edit", from: "bar" });
    if (typeof caret === "number") bar.setSelectionRange(caret, caret);
  });
  bar.addEventListener("pointerdown", (event) => {
    // A click in the bar while the in-cell editor is open moves the edit to the bar, text and all.
    if (editor.open && document.activeElement !== bar) {
      event.preventDefault();
      const value = editor.text;
      const at = editor.cell;
      editor.cancel();
      editor.start({ r: at.r, c: at.c, value, mode: "edit", from: "bar" });
    }
  });

  // ---- the keyboard ----

  function onKey(event) {
    if (!wb || editor.open || event.isComposing) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const k = event.key;
    const handled = () => event.preventDefault();
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) {
      handled();
      return move(arrows[k][0], arrows[k][1], { extend: event.shiftKey, edge: ctrl });
    }
    if (ctrl && !event.altKey) {
      const lower = k.toLowerCase();
      if (lower === "z") { handled(); return event.shiftKey ? redo() : undo(); }
      if (lower === "y") { handled(); return redo(); }
      if (lower === "b") { handled(); return toggleStyle("b"); }
      if (lower === "i") { handled(); return toggleStyle("i"); }
      if (lower === "u") { handled(); return toggleStyle("u"); }
      if (lower === "a") { handled(); const t = tab(); return setSel({ r: sel.r, c: sel.c, ar: 0, ac: 0, er: t.rows - 1, ec: t.cols - 1, r1: 0, c1: 0, r2: t.rows - 1, c2: t.cols - 1 }, { reveal: false }); }
      if (k === "Home") { handled(); grid.home(); return setSel(single(0, 0)); }
      if (k === "End") {
        handled();
        const used = usedRange(tab());
        return setSel(single(used?.r2 ?? 0, used?.c2 ?? 0));
      }
      return; // ctrl+C, ctrl+X, ctrl+V and the browser's own keys go on
    }
    switch (k) {
      case "Tab": handled(); return step(0, event.shiftKey ? -1 : 1);
      case "Enter": handled(); return step(event.shiftKey ? -1 : 1, 0);
      case "Home": handled(); return move(0, -sel.c, { extend: event.shiftKey });
      case "End": {
        handled();
        const t = tab();
        let last = 0;
        for (let c = t.cols - 1; c >= 0; c--) if (filledAt(sel.r, c)) { last = c; break; }
        return move(0, last - sel.c, { extend: event.shiftKey });
      }
      case "PageDown": handled(); return move(grid.pageRows(), 0, { extend: event.shiftKey });
      case "PageUp": handled(); return move(-grid.pageRows(), 0, { extend: event.shiftKey });
      case "Delete":
      case "Backspace": handled(); return clearSelection();
      case "F2": handled(); return startEdit({ mode: "edit" });
      case "Escape":
        if (lastCopy()) {
          handled();
          forgetCopy();
          grid.setCopy(null);
        }
        return;
      default:
        break;
    }
    if (k.length === 1 && !event.altKey) {
      handled();
      startEdit({ mode: "enter", value: k });
    }
  }
  sink.addEventListener("keydown", onKey);
  sink.addEventListener("input", () => { if (!editor.open && sink.value !== " ") { const v = sink.value.trim(); sink.value = " "; if (v) startEdit({ mode: "enter", value: v }); } });

  // ---- the clipboard ----

  function onCopy(event, cut) {
    if (!wb || editor.open) return;
    event.preventDefault();
    const range = selRange();
    const t = tab();
    const text = copyBlock({ sheet: id, tab: t, range, display, cut });
    event.clipboardData?.setData("text/plain", text);
    grid.setCopy(range);
  }

  function onPaste(event) {
    if (!wb || editor.open || gone) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const t = tab();
    let plan;
    try {
      plan = pastePlan(text, selRange(), parseInput);
    } catch (err) {
      ext.toast(`That could not be pasted: ${err.message}`, { tone: "error" });
      return;
    }
    const needRows = plan.range.r2 + 1;
    const needCols = plan.range.c2 + 1;
    if (needRows > MAX_ROWS || needCols > MAX_COLS) {
      ext.toast(`That block does not fit: a tab has at most ${MAX_ROWS} rows and ${MAX_COLS} columns.`, { tone: "error" });
      return;
    }
    const ops = [];
    if (needRows > t.rows || needCols > t.cols) ops.push({ op: "resize", tab: t.id, rows: Math.max(t.rows, needRows), cols: Math.max(t.cols, needCols) });
    const from = plan.from;
    if (from?.cut && from.sheet === id && findTab(wb, from.tab)) {
      const src = findTab(wb, from.tab);
      const clear = {};
      for (const key of keysIn(src.cells, from.range)) {
        const p = parseAddr(key);
        const inTarget = src.id === t.id && p.row >= plan.range.r1 && p.row <= plan.range.r2 && p.col >= plan.range.c1 && p.col <= plan.range.c2;
        if (!inTarget) clear[key] = null;
      }
      if (Object.keys(clear).length) ops.push({ op: "set", tab: src.id, cells: clear });
      const styled = keysIn(src.styles, from.range).map((k) => [k, {}]);
      if (styled.length) ops.push(...styleOps(src.id, styled));
    }
    ops.push({ op: "set", tab: t.id, cells: plan.cells, ...(Object.keys(plan.fmts).length ? { fmts: plan.fmts } : {}) });
    if (plan.styles.length) ops.push(...styleOps(t.id, plan.styles.map(([k, s]) => [k, s ?? {}])));
    const res = apply(ops, { layout: ops[0].op === "resize" });
    if (!res) return;
    if (from?.cut) {
      forgetCopy();
      grid.setCopy(null);
    }
    const r = plan.range;
    setSel({ r: r.r1, c: r.c1, ar: r.r1, ac: r.c1, er: r.r2, ec: r.c2, ...r }, { reveal: false });
  }

  sink.addEventListener("copy", (event) => onCopy(event, false));
  sink.addEventListener("cut", (event) => onCopy(event, true));
  sink.addEventListener("paste", onPaste);

  // ---- changes in ----

  const unwatch = model.onSheet(id, (event) => {
    if (!started) return;
    if (event.kind === "removed") return showGone();
    if (event.kind === "changed" || event.kind === "snapshot") {
      if (event.own || event.rev <= rev) return;
      if (sending) {
        foreign = Math.max(foreign, event.rev);
        needReload = true;
        return;
      }
      void reload();
    }
  });
  const unwatchList = model.watch(drawSave);

  // ---- start ----

  async function start() {
    try {
      const out = await model.get(id);
      if (!out.sheet) throw new Error(`No sheet ${id}.`);
      wb = out.sheet;
    } catch (err) {
      body.replaceChildren();
      if (/No sheet/i.test(err.message)) return showGone();
      body.append(el("div", { class: "sht-error" }, `The sheet could not be opened: ${err.message}`));
      return;
    }
    rev = wb.rev ?? 0;
    seenRev = rev;
    tabId = wb.tabs[0].id;
    recompute();
    body.replaceChildren(grid.node);
    started = true;
    grid.setTab(tab(), { keepScroll: false });
    redraw();
    if (handle.params?.rename) setTimeout(renameTitle, 50);
    else if (active) focusSink();
    if (active) model.setActive(id);
  }
  void start();

  return {
    activate() {
      active = true;
      model.setActive(id);
      if (wb) {
        grid.invalidate();
        if (!renamingTitle) setTimeout(focusSink, 0);
      }
    },
    deactivate() {
      active = false;
      if (model.active === id) model.setActive(null);
    },
    unmount() {
      unwatch();
      unwatchList();
      clearTimeout(noteTimer);
      clearTimeout(flushTimer);
      if (queue.length && !gone) void flush();
      if (model.active === id) model.setActive(null);
      editor.dispose();
      grid.dispose();
      node.remove();
    },
  };
}
