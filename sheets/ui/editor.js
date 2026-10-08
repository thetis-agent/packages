/* Editing a cell: the in-cell editor laid over the cell and the formula bar's field, two textareas that
 * mirror each other, one of them focused. Typing over a cell opens it in "enter" mode (the arrows commit and
 * move, or point at cells while a formula wants a reference); F2, a double-click or a click in the bar opens
 * it in "edit" mode (the arrows move the caret). While a formula is written its references are handed to
 * the grid to outline in colours, the function names that fit what is typed are offered, and inside a call
 * the function's signature is shown with the current argument marked. Point mode: where a reference may go
 * (after `=`, `(`, `,` or an operator), an arrow key or a click on the grid writes the reference there, and
 * further arrows or a drag move or grow it. The editor never touches the workbook: it hands the text back. */

import { quoteTab, rangeText } from "./core/address.js";
import { refsOf } from "./core/formula.js";
import { FUNCTIONS } from "./core/functions.js";

const POINT_BEFORE = new Set(["=", "(", ",", "+", "-", "*", "/", "^", "&", "<", ">", ":", ";"]);
const NAME_TAIL = /(^|[=(,+\-*/^&<>:;\s])([A-Za-z][A-Za-z0-9._]*)$/;

/** The innermost function call around `caret` and which argument the caret is in, or null. */
export function callAt(text, caret) {
  const stack = [];
  let inStr = false;
  for (let i = 0; i < caret; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '"') {
        if (text[i + 1] === '"') i += 1;
        else inStr = false;
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "(") {
      const m = /([A-Za-z][A-Za-z0-9._]*)\s*$/.exec(text.slice(0, i));
      stack.push({ name: m ? m[1].toUpperCase() : null, arg: 0 });
    } else if (ch === ")") stack.pop();
    else if ((ch === "," || ch === ";") && stack.length) stack[stack.length - 1].arg += 1;
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name && FUNCTIONS[stack[k].name]) return stack[k];
  return null;
}

/** Whether the caret sits in a string literal. */
function inString(text, caret) {
  let inStr = false;
  for (let i = 0; i < caret; i++) if (text[i] === '"') inStr = !inStr;
  return inStr;
}

/** The function names a formula's text offers at the caret: the identifier being typed, and what it may become. */
export function suggestionsAt(text, caret) {
  if (!text.startsWith("=") || inString(text, caret)) return null;
  const m = NAME_TAIL.exec(text.slice(0, caret));
  if (!m) return null;
  if (/^[A-Za-z0-9._]/.test(text.slice(caret))) return null;
  const prefix = m[2].toUpperCase();
  const names = Object.keys(FUNCTIONS).filter((n) => n.startsWith(prefix) && n !== prefix).sort();
  if (!names.length) return null;
  return { start: caret - m[2].length, end: caret, names: names.slice(0, 8) };
}

/** Whether a reference may be written at the caret of a formula. */
export function pointable(text, caret) {
  if (!text.startsWith("=") || inString(text, caret)) return false;
  const before = text.slice(0, caret).trimEnd();
  const after = text.slice(caret).trimStart();
  if (/^[A-Za-z0-9$'_.!]/.test(after)) return false;
  return POINT_BEFORE.has(before.at(-1));
}

/** The parts of a signature, with `arg` marked, for the help line. */
export function signatureParts(help, arg) {
  const open = help.indexOf("(");
  const close = help.lastIndexOf(")");
  if (open < 0 || close < open) return [{ text: help, on: false }];
  const params = help.slice(open + 1, close).split(/,\s*/).filter(Boolean);
  let at = arg;
  if (at >= params.length) at = params.findIndex((p) => p.includes("…") || p.includes("...")) >= 0 ? params.length - 1 : -1;
  const out = [{ text: help.slice(0, open + 1), on: false }];
  params.forEach((p, i) => {
    if (i) out.push({ text: ", ", on: false });
    out.push({ text: p, on: i === at });
  });
  out.push({ text: help.slice(close), on: false });
  return out;
}

/**
 * `opts`: `grid`, `bar` (the formula bar's textarea), `host` (where the help box goes), `tabName()` (the
 * tab being edited), `onCommit(text, move)` with move `{ dr, dc }`, `onCancel()`, `onInput(text)`.
 */
export function createEditor(ext, opts) {
  const { el, clear } = ext.dom;
  const { grid, bar, host } = opts;
  const cell = el("textarea", { class: "sht-editor", spellcheck: "false", rows: "1", "aria-label": "Cell contents", autocomplete: "off" });
  const assist = el("div", { class: "sht-assist", hidden: true, role: "listbox" });
  host.append(assist);
  let state = null; // { r, c, mode, from }
  let point = null; // { start, end, anchor: {r,c}, cur: {r,c} }
  let pointTab = null;
  let suggest = null; // { start, end, names, at }

  const focused = () => (state?.from === "bar" ? bar : cell);
  const text = () => focused().value;

  function sync(from) {
    const other = from === cell ? bar : cell;
    if (other.value !== from.value) other.value = from.value;
    fit();
    opts.onInput?.(from.value);
    refsChanged();
    drawAssist();
  }

  function fit() {
    if (!state) return;
    const b = grid.cellBox(state.r, state.c);
    cell.style.width = `${b.w}px`;
    cell.style.height = `${b.h}px`;
    const w = Math.min(b.maxW, Math.max(b.w, cell.scrollWidth + 4));
    cell.style.width = `${w}px`;
    const h = Math.max(b.h, cell.scrollHeight);
    cell.style.height = `${h}px`;
  }

  function placeCell() {
    if (!state) return;
    const b = grid.cellBox(state.r, state.c);
    if (cell.parentElement !== b.layer) b.layer.append(cell);
    grid.setEditor(cell);
    cell.style.transform = `translate(${b.x}px, ${b.y}px)`;
    fit();
  }

  // ---- references ----

  const TONES = 6;
  function refsChanged() {
    const value = state ? cell.value : "";
    if (!value.startsWith("=")) return grid.setRefs([]);
    let list = [];
    try {
      list = refsOf(value);
    } catch {
      list = [];
    }
    const name = (opts.tabName() ?? "").toLowerCase();
    const tones = new Map();
    const out = [];
    for (const ref of list) {
      if (ref.tab && ref.tab.toLowerCase() !== name) continue;
      const key = ref.text.replace(/\$/g, "").toUpperCase();
      if (!tones.has(key)) tones.set(key, tones.size % TONES);
      out.push({ range: ref.range, tone: tones.get(key) });
    }
    grid.setRefs(out);
  }

  // ---- the help box ----

  function drawAssist() {
    const input = focused();
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    clear(assist);
    suggest = state && input.selectionStart === input.selectionEnd ? suggestionsAt(value, caret) : null;
    if (suggest) {
      suggest.at = 0;
      suggest.names.forEach((name, i) =>
        assist.append(
          el("button", { type: "button", class: `sht-suggest${i === 0 ? " is-on" : ""}`, role: "option", "data-name": name, onPointerdown: (event) => { event.preventDefault(); accept(name); } },
            el("span", { class: "sht-suggest-name" }, name),
            el("span", { class: "sht-suggest-help" }, FUNCTIONS[name]?.help ?? ""))
        )
      );
    } else {
      const call = state && value.startsWith("=") ? callAt(value, caret) : null;
      if (call) {
        const help = FUNCTIONS[call.name]?.help ?? `${call.name}(…)`;
        assist.append(el("div", { class: "sht-help" }, ...signatureParts(help, call.arg).map((p) => (p.on ? el("b", {}, p.text) : p.text))));
      }
    }
    assist.hidden = !assist.firstChild;
    if (assist.hidden) return;
    const r = input === bar ? bar.getBoundingClientRect() : cell.getBoundingClientRect();
    const base = host.getBoundingClientRect();
    assist.style.left = `${Math.max(4, Math.min(r.left - base.left, base.width - 320))}px`;
    assist.style.top = `${r.bottom - base.top + 4}px`;
  }

  function moveSuggest(d) {
    if (!suggest) return;
    suggest.at = (suggest.at + d + suggest.names.length) % suggest.names.length;
    [...assist.children].forEach((n, i) => n.classList.toggle("is-on", i === suggest.at));
  }

  function accept(name) {
    if (!suggest) return;
    const input = focused();
    const v = input.value;
    const after = v.slice(suggest.end);
    const insert = after.startsWith("(") ? name : `${name}(`;
    input.value = v.slice(0, suggest.start) + insert + after;
    const caret = suggest.start + insert.length + (after.startsWith("(") ? 1 : 0);
    input.setSelectionRange(caret, caret);
    point = null;
    sync(input);
  }

  // ---- point mode ----

  function canPoint() {
    if (!state) return false;
    const input = focused();
    if (input.selectionStart !== input.selectionEnd) return false;
    const caret = input.selectionStart;
    if (point && caret === point.end) return true;
    return pointable(input.value, caret);
  }

  function writeRef(range) {
    const input = focused();
    const v = input.value;
    const start = point ? point.start : input.selectionStart;
    const end = point ? point.end : input.selectionEnd;
    const own = (opts.tabName() ?? "").toLowerCase();
    const prefix = pointTab && pointTab.toLowerCase() !== own ? `${quoteTab(pointTab)}!` : "";
    const ref = prefix + rangeText(range);
    input.value = v.slice(0, start) + ref + v.slice(end);
    point = { ...(point ?? {}), start, end: start + ref.length };
    input.setSelectionRange(point.end, point.end);
    sync(input);
  }

  function arrowPoint(event) {
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (!point?.cur) {
      const at = { r: state.r, c: state.c };
      point = { start: focused().selectionStart, end: focused().selectionStart, anchor: at, cur: at };
    }
    const lim = opts.limits();
    const cur = { r: Math.max(0, Math.min(lim.rows - 1, point.cur.r + d[0])), c: Math.max(0, Math.min(lim.cols - 1, point.cur.c + d[1])) };
    const anchor = event.shiftKey ? point.anchor : cur;
    point.cur = cur;
    point.anchor = anchor;
    writeRef({ r1: Math.min(anchor.r, cur.r), c1: Math.min(anchor.c, cur.c), r2: Math.max(anchor.r, cur.r), c2: Math.max(anchor.c, cur.c) });
    grid.reveal(cur.r, cur.c);
  }

  // ---- keys ----

  function onKey(event) {
    if (!state) return;
    const input = event.currentTarget;
    if (event.isComposing) return;
    const key = event.key;
    if (suggest && !assist.hidden) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        moveSuggest(key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (key === "Tab" || (key === "Enter" && !event.altKey && !event.ctrlKey)) {
        event.preventDefault();
        accept(suggest.names[suggest.at]);
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        suggest = null;
        assist.hidden = true;
        return;
      }
    }
    if (key === "Enter" && (event.altKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const s = input.selectionStart;
      input.value = `${input.value.slice(0, s)}\n${input.value.slice(input.selectionEnd)}`;
      input.setSelectionRange(s + 1, s + 1);
      sync(input);
      return;
    }
    if (key === "Enter" || key === "Tab") {
      event.preventDefault();
      const back = event.shiftKey ? -1 : 1;
      commit(key === "Enter" ? { dr: back, dc: 0 } : { dr: 0, dc: back });
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (key.startsWith("Arrow") && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (state.mode === "enter" && canPoint()) {
        event.preventDefault();
        arrowPoint(event);
        return;
      }
      if (state.mode === "enter" && !event.shiftKey) {
        event.preventDefault();
        const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
        commit({ dr: d[0], dc: d[1] });
        return;
      }
    }
    if (key !== "Shift" && key !== "Control" && key !== "Alt" && key !== "Meta") point = null;
  }

  for (const input of [cell, bar]) {
    input.addEventListener("keydown", onKey);
    input.addEventListener("input", (event) => {
      if (!state) return;
      sync(event.currentTarget);
    });
    input.addEventListener("click", () => {
      if (!state) return;
      point = null;
      drawAssist();
    });
  }
  cell.addEventListener("pointerdown", (event) => event.stopPropagation());

  function commit(move = { dr: 0, dc: 0 }) {
    if (!state) return;
    const value = focused().value;
    const at = { r: state.r, c: state.c };
    close();
    opts.onCommit(value, move, at);
  }

  function cancel() {
    if (!state) return;
    close();
    opts.onCancel();
  }

  function close() {
    state = null;
    point = null;
    pointTab = null;
    suggest = null;
    assist.hidden = true;
    cell.remove();
    grid.setEditor(null);
    grid.setRefs([]);
  }

  return {
    get open() {
      return Boolean(state);
    },
    get cell() {
      return state ? { r: state.r, c: state.c } : null;
    },
    get mode() {
      return state?.mode ?? null;
    },
    get text() {
      return state ? text() : null;
    },
    /** Opens the editor on cell (r, c) with `value`; `from` "cell" focuses the in-cell field, "bar" the formula bar. */
    start({ r, c, value, mode = "edit", from = "cell", select = false }) {
      state = { r, c, mode, from };
      point = null;
      pointTab = opts.tabName();
      cell.value = value;
      bar.value = value;
      placeCell();
      const input = focused();
      input.focus({ preventScroll: true });
      if (select) input.select();
      else input.setSelectionRange(value.length, value.length);
      sync(input);
    },
    /** A cell or range clicked or dragged over while pointing; null at the end of the gesture. */
    point(range, phase) {
      if (!state) return;
      focused().focus({ preventScroll: true });
      if (phase === "start" && !(point && focused().selectionStart === point.end)) point = null;
      if (range) {
        point = { ...(point ?? { start: focused().selectionStart, end: focused().selectionStart }), anchor: { r: range.r1, c: range.c1 }, cur: { r: range.r2, c: range.c2 } };
        writeRef(range);
      }
    },
    canPoint,
    commit,
    cancel,
    /** Puts the editor back over its cell after the grid's geometry changed. */
    reposition() {
      if (state) placeCell();
    },
    focus() {
      if (state) focused().focus({ preventScroll: true });
    },
    /** True when `node` is one of the editor's fields. */
    owns: (node) => node === cell || node === bar,
    dispose() {
      close();
      assist.remove();
    },
  };
}
