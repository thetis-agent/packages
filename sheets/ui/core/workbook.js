/* The workbook record and every change to it. The server's tools and the page's edits both describe a
 * change as ops and hand them to `applyOps`, which answers a new workbook (the input is never mutated:
 * what changes is copied, what does not is shared), the ranges touched and a short phrase for the change
 * log. Structural ops keep formulas right everywhere: inserting or deleting rows and columns rewrites
 * every formula in every tab with `shiftRefs`, renaming a tab rewrites references to it, deleting one
 * turns them into #REF!, and sort and fill move formulas the way a spreadsheet does with `translate`.
 * Refusals are thrown Errors whose message is a sentence naming the way out. */
import { addr, boundingBox, colIndex, colName, MAX_COLS, MAX_ROWS, parseAddr, parseRange, rangeText } from "./address.js";
import { compute } from "./engine.js";
import { dropTabRefs, renameTabRefs, shiftRefs, translate } from "./formula.js";
import { resolveFormat } from "./format.js";

export const LIMITS = {
  sheets: 256,
  tabs: 32,
  rows: MAX_ROWS,
  cols: MAX_COLS,
  cells: 250000,
  styles: 250000,
  cellChars: 32767,
  fileBytes: 16 * 1024 * 1024,
  formulaChars: 8192,
  changes: 40,
  changeRanges: 20,
  titleChars: 120,
  tabNameChars: 64,
};

export const DEFAULTS = { rows: 1000, cols: 26, width: 100, height: 24 };

const fail = (message) => {
  throw new Error(message);
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export const isSheetId = (id) => typeof id === "string" && /^sh_[0-9a-f]{8}$/.test(id);
export const isTabId = (id) => typeof id === "string" && /^t[0-9]{1,4}$/.test(id);

/** A tab id never used by this workbook's tabs or recent changes: one above the highest seen. */
export function newTabId(wb) {
  let max = 0;
  const see = (id) => {
    if (isTabId(id)) max = Math.max(max, Number(id.slice(1)));
  };
  for (const t of wb.tabs ?? []) see(t.id);
  for (const c of wb.changes ?? []) for (const r of c.ranges ?? []) see(r.tab);
  if (max >= 9999) fail("This sheet has used up its tab ids; copy it to a new sheet.");
  return `t${max + 1}`;
}

/** Why a tab name cannot be used, as a sentence, or null when it can. With `wb`, a name another tab
 * (other than `exceptId`) has, in any case, is taken. */
export function validTabName(name, wb, exceptId) {
  if (typeof name !== "string" || !name.length) return "A tab needs a name.";
  if (name.trim() !== name) return "A tab name cannot start or end with a space.";
  if (name.length > LIMITS.tabNameChars) return `A tab name is at most ${LIMITS.tabNameChars} characters.`;
  if (/['!\[\]*?/\\:]/.test(name)) return "A tab name cannot hold any of ' ! [ ] * ? / \\ :";
  if (/[\x00-\x1f]/.test(name)) return "A tab name cannot hold control characters.";
  if (wb) {
    const low = name.toLowerCase();
    const other = (wb.tabs ?? []).find((t) => t.id !== exceptId && String(t.name).toLowerCase() === low);
    if (other) return `There is already a tab named ${other.name}; choose another name.`;
  }
  return null;
}

const iso = (now) => (now instanceof Date ? now.toISOString() : typeof now === "string" && now ? now : new Date().toISOString());

const blankTab = (id, name, rows = DEFAULTS.rows, cols = DEFAULTS.cols) => ({ id, name, rows, cols, cells: {}, styles: {}, widths: {}, heights: {}, freeze: { rows: 0, cols: 0 } });

/** A new workbook with empty tabs (one Sheet1 unless names are given). */
export function emptyWorkbook({ id, title, project = null, createdBy = null, now, tabs } = {}) {
  const names = Array.isArray(tabs) && tabs.length ? tabs.map((n) => String(n).trim()) : ["Sheet1"];
  if (names.length > LIMITS.tabs) fail(`A sheet holds at most ${LIMITS.tabs} tabs.`);
  const wb = { v: 1, id, title: String(title ?? "Untitled sheet").trim() || "Untitled sheet", project: project ?? null, createdBy: createdBy ?? null, createdAt: iso(now), updatedAt: iso(now), rev: 0, tabs: [], changes: [] };
  names.forEach((name, i) => {
    const why = validTabName(name, wb);
    if (why) fail(why);
    wb.tabs.push(blankTab(`t${i + 1}`, name));
  });
  return wb;
}

const intIn = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

/** The record with every missing field filled with its default, so older or hand-edited files read. */
export function completeWorkbook(record) {
  const r = isObj(record) ? record : {};
  const at = typeof r.updatedAt === "string" ? r.updatedAt : typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString();
  const tabs = (Array.isArray(r.tabs) ? r.tabs : []).filter(isObj).map((t, i) => ({
    id: typeof t.id === "string" ? t.id : `t${i + 1}`,
    name: typeof t.name === "string" ? t.name : `Sheet${i + 1}`,
    rows: intIn(t.rows, 1, LIMITS.rows, DEFAULTS.rows),
    cols: intIn(t.cols, 1, LIMITS.cols, DEFAULTS.cols),
    cells: isObj(t.cells) ? t.cells : {},
    styles: isObj(t.styles) ? t.styles : {},
    widths: isObj(t.widths) ? t.widths : {},
    heights: isObj(t.heights) ? t.heights : {},
    freeze: { rows: intIn(t.freeze?.rows, 0, LIMITS.rows, 0), cols: intIn(t.freeze?.cols, 0, LIMITS.cols, 0) },
  }));
  if (!tabs.length) tabs.push(blankTab("t1", "Sheet1"));
  return {
    v: 1,
    id: r.id,
    title: typeof r.title === "string" ? r.title : "Untitled sheet",
    project: typeof r.project === "string" ? r.project : null,
    createdBy: typeof r.createdBy === "string" ? r.createdBy : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : at,
    updatedAt: at,
    rev: Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0,
    tabs,
    changes: Array.isArray(r.changes) ? r.changes.filter(isObj) : [],
  };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const STYLE_KEYS = ["b", "i", "u", "s", "color", "fill", "align", "wrap", "fmt"];

function checkStyle(s, where) {
  if (!isObj(s)) fail(`The style of ${where} must be an object.`);
  for (const [k, v] of Object.entries(s)) {
    if (!STYLE_KEYS.includes(k)) fail(`The style of ${where} has an unknown key ${k}; the keys are ${STYLE_KEYS.join(", ")}.`);
    if (["b", "i", "u", "s", "wrap"].includes(k) && v !== true) fail(`The style of ${where} sets ${k} to something other than true.`);
    if ((k === "color" || k === "fill") && !(typeof v === "string" && COLOR.test(v))) fail(`The ${k} of ${where} must be a colour like #1a2b3c.`);
    if (k === "align" && !["left", "center", "right"].includes(v)) fail(`The alignment of ${where} is left, center or right.`);
    if (k === "fmt") {
      if (typeof v !== "string" || !v) fail(`The number format of ${where} must be a pattern.`);
      resolveFormat(v);
    }
  }
}

function checkRaw(raw, where) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) fail(`${where} holds a number that is not finite; write a finite number or text.`);
  } else if (typeof raw === "string") {
    if (!raw.length) fail(`${where} holds empty text; a cleared cell is left out.`);
    if (raw.length > LIMITS.cellChars) fail(`${where} holds more than ${LIMITS.cellChars} characters; shorten it.`);
    if (raw[0] === "=" && raw.length > LIMITS.formulaChars) fail(`The formula in ${where} is longer than ${LIMITS.formulaChars} characters; split it across cells.`);
  } else if (typeof raw !== "boolean") fail(`${where} must hold a number, text or a boolean.`);
}

/** Throws a sentence on anything in the workbook out of the rules or the limits; answers the workbook. */
export function checkWorkbook(wb) {
  if (!isObj(wb)) fail("A workbook is an object.");
  if (wb.id !== undefined && wb.id !== null && !isSheetId(wb.id)) fail("A sheet id looks like sh_1a2b3c4d.");
  if (typeof wb.title !== "string" || !wb.title.trim() || wb.title.length > LIMITS.titleChars) fail(`A sheet's title is 1 to ${LIMITS.titleChars} characters.`);
  if (wb.project !== null && wb.project !== undefined && typeof wb.project !== "string") fail("A sheet's project is a project id or null.");
  if (!Array.isArray(wb.tabs) || !wb.tabs.length) fail("A sheet has at least one tab.");
  if (wb.tabs.length > LIMITS.tabs) fail(`A sheet holds at most ${LIMITS.tabs} tabs; delete some first.`);
  const ids = new Set();
  let cells = 0;
  let styles = 0;
  for (const t of wb.tabs) {
    if (!isObj(t) || !isTabId(t.id)) fail("A tab id looks like t1.");
    if (ids.has(t.id)) fail(`The tab id ${t.id} is used twice.`);
    ids.add(t.id);
    const why = validTabName(t.name, wb, t.id);
    if (why) fail(why);
    if (!Number.isInteger(t.rows) || t.rows < 1 || t.rows > LIMITS.rows) fail(`The tab ${t.name} has ${t.rows} rows; a tab has 1 to ${LIMITS.rows}.`);
    if (!Number.isInteger(t.cols) || t.cols < 1 || t.cols > LIMITS.cols) fail(`The tab ${t.name} has ${t.cols} columns; a tab has 1 to ${LIMITS.cols}.`);
    const inside = (a, what) => {
      const p = parseAddr(a);
      if (!p || a !== addr(p.row, p.col)) fail(`The tab ${t.name} has ${what} at "${a}", which is not an address like B3.`);
      if (p.row >= t.rows || p.col >= t.cols) fail(`The tab ${t.name} has ${what} at ${a}, outside its ${t.rows} rows and ${t.cols} columns; resize it.`);
    };
    if (!isObj(t.cells) || !isObj(t.styles) || !isObj(t.widths) || !isObj(t.heights)) fail(`The tab ${t.name} is missing its cells, styles, widths or heights.`);
    for (const [a, raw] of Object.entries(t.cells)) {
      inside(a, "a cell");
      checkRaw(raw, `${t.name}!${a}`);
      cells++;
    }
    for (const [a, s] of Object.entries(t.styles)) {
      inside(a, "a style");
      checkStyle(s, `${t.name}!${a}`);
      styles++;
    }
    for (const [c, px] of Object.entries(t.widths)) {
      const i = colIndex(c);
      if (i < 0 || i >= t.cols || colName(i) !== c) fail(`The tab ${t.name} has a width for "${c}", which is not one of its columns.`);
      if (!Number.isInteger(px) || px < 20 || px > 1000) fail(`A column width is 20 to 1000 px; ${c} has ${px}.`);
    }
    for (const [r, px] of Object.entries(t.heights)) {
      const i = Number(r);
      if (!/^[1-9][0-9]*$/.test(r) || i > t.rows) fail(`The tab ${t.name} has a height for "${r}", which is not one of its rows.`);
      if (!Number.isInteger(px) || px < 16 || px > 400) fail(`A row height is 16 to 400 px; row ${r} has ${px}.`);
    }
    if (!isObj(t.freeze) || !Number.isInteger(t.freeze.rows) || !Number.isInteger(t.freeze.cols) || t.freeze.rows < 0 || t.freeze.cols < 0 || t.freeze.rows > t.rows || t.freeze.cols > t.cols)
      fail(`The tab ${t.name} freezes more rows or columns than it has.`);
  }
  if (cells > LIMITS.cells) fail(`A sheet holds at most ${LIMITS.cells.toLocaleString("en-US")} non-empty cells; this one has ${cells.toLocaleString("en-US")}. Split it into two sheets.`);
  if (styles > LIMITS.styles) fail(`A sheet holds formatting for at most ${LIMITS.styles.toLocaleString("en-US")} cells; clear some first.`);
  if (wb.changes !== undefined && (!Array.isArray(wb.changes) || wb.changes.length > LIMITS.changes)) fail(`A sheet keeps at most ${LIMITS.changes} changes.`);
  return wb;
}

/** A tab by id, else by name without case, else null. */
export function findTab(wb, ref) {
  if (ref === null || ref === undefined || !wb?.tabs) return null;
  const s = String(ref);
  return wb.tabs.find((t) => t.id === s) ?? wb.tabs.find((t) => String(t.name).toLowerCase() === s.toLowerCase()) ?? null;
}

/** The box around a tab's non-empty cells, or null for an empty tab. */
export function usedRange(tab) {
  let out = null;
  for (const a in tab.cells) {
    const p = parseAddr(a);
    if (!p) continue;
    if (!out) out = { r1: p.row, c1: p.col, r2: p.row, c2: p.col };
    else {
      if (p.row < out.r1) out.r1 = p.row;
      if (p.row > out.r2) out.r2 = p.row;
      if (p.col < out.c1) out.c1 = p.col;
      if (p.col > out.c2) out.c2 = p.col;
    }
  }
  return out;
}

/** How many non-empty cells the workbook holds. */
export const cellCount = (wb) => wb.tabs.reduce((n, t) => n + Object.keys(t.cells).length, 0);

/** Rectangles covering a set of cells (`[{ row, col }]` or addresses): runs per row, stacked where rows
 * repeat the same run; beyond `max` rectangles, their bounding box. */
export function cellRanges(cells, max = LIMITS.changeRanges) {
  const byRow = new Map();
  for (const c of cells) {
    const p = typeof c === "string" ? parseAddr(c) : c;
    if (!p) continue;
    let list = byRow.get(p.row);
    if (!list) byRow.set(p.row, (list = []));
    list.push(p.col);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const open = new Map();
  const done = [];
  for (const r of rows) {
    const cols = [...new Set(byRow.get(r))].sort((a, b) => a - b);
    const runs = [];
    for (const c of cols) {
      const last = runs[runs.length - 1];
      if (last && last[1] === c - 1) last[1] = c;
      else runs.push([c, c]);
    }
    const next = new Map();
    for (const [c1, c2] of runs) {
      const k = `${c1}:${c2}`;
      const prev = open.get(k);
      if (prev && prev.r2 === r - 1) {
        prev.r2 = r;
        next.set(k, prev);
        open.delete(k);
      } else next.set(k, { r1: r, c1, r2: r, c2 });
    }
    for (const g of open.values()) done.push(g);
    open.clear();
    for (const [k, g] of next) open.set(k, g);
  }
  for (const g of open.values()) done.push(g);
  done.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
  return done.length > max ? [boundingBox(done)] : done;
}

/** At most `max` change ranges: beyond that, each tab's ranges merged into their bounding box. */
export function compactRanges(ranges, max = LIMITS.changeRanges) {
  if (ranges.length <= max) return ranges;
  const byTab = new Map();
  for (const { tab, range } of ranges) {
    const g = typeof range === "string" ? parseRange(range) : range;
    if (!g) continue;
    byTab.set(tab, boundingBox([byTab.get(tab), g]));
  }
  return [...byTab].slice(0, max).map(([tab, g]) => ({ tab, range: rangeText(g) }));
}

const sameStyle = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

/** The ranges whose raw values or styles differ between two workbooks, per tab of `after`. */
export function diffCells(before, after) {
  const out = [];
  for (const t of after.tabs) {
    const b = before.tabs.find((x) => x.id === t.id);
    const changed = [];
    const keys = new Set([...Object.keys(t.cells), ...Object.keys(t.styles), ...(b ? [...Object.keys(b.cells), ...Object.keys(b.styles)] : [])]);
    for (const k of keys) {
      if (!b) changed.push(k);
      else if (t.cells[k] !== b.cells[k] || !sameStyle(t.styles[k], b.styles[k])) changed.push(k);
    }
    for (const g of cellRanges(changed)) out.push({ tab: t.id, range: rangeText(g) });
  }
  return out;
}

/* ---------- applyOps ---------- */

const int = (v, what) => {
  const n = typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n)) fail(`${what} must be a whole number.`);
  return n;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function rangeIn(t, range, what = "range") {
  let g = null;
  if (isObj(range) && Number.isInteger(range.r1)) g = { r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2 };
  else if (typeof range === "string") g = parseRange(range, { rows: t.rows, cols: t.cols });
  if (!g) fail(`The ${what} "${typeof range === "string" ? range : JSON.stringify(range)}" is not a range like A1:D4, B:B or 2:2.`);
  return g;
}

const clip = (t, g) => {
  const out = { r1: g.r1, c1: g.c1, r2: Math.min(g.r2, t.rows - 1), c2: Math.min(g.c2, t.cols - 1) };
  if (out.r1 > out.r2 || out.c1 > out.c2) fail(`${rangeText(g)} is outside the tab ${t.name}, which has ${t.rows} rows and ${t.cols} columns.`);
  return out;
};

function growTo(t, g) {
  if (g.r2 >= t.rows) t.rows = g.r2 + 1;
  if (g.c2 >= t.cols) t.cols = g.c2 + 1;
}

/** Moves the address keys of a sparse object along one axis: insert (count > 0) or delete (count < 0). */
function moveKeys(obj, axis, at, count) {
  const out = {};
  const n = -count;
  for (const a in obj) {
    const p = parseAddr(a);
    if (!p) continue;
    let { row, col } = p;
    const v = axis === "row" ? row : col;
    let w = v;
    if (v >= at) {
      if (count > 0) w = v + count;
      else if (v < at + n) continue;
      else w = v - n;
    }
    if (axis === "row") row = w;
    else col = w;
    out[addr(row, col)] = obj[a];
  }
  return out;
}

function moveLines(obj, at, count, toIndex, fromIndex) {
  const out = {};
  const n = -count;
  for (const k in obj) {
    const v = toIndex(k);
    if (v < 0) continue;
    let w = v;
    if (v >= at) {
      if (count > 0) w = v + count;
      else if (v < at + n) continue;
      else w = v - n;
    }
    out[fromIndex(w)] = obj[k];
  }
  return out;
}

function normStyle(style) {
  if (!isObj(style)) fail("A style change is an object like { b: true, fill: \"#fff2cc\" }.");
  const sets = {};
  const unsets = [];
  for (const [k, v] of Object.entries(style)) {
    if (!STYLE_KEYS.includes(k)) fail(`Unknown style key ${k}; the keys are ${STYLE_KEYS.join(", ")}.`);
    if (v === null || v === false || v === undefined) {
      unsets.push(k);
      continue;
    }
    if (["b", "i", "u", "s", "wrap"].includes(k)) {
      if (v !== true) fail(`${k} is true, false or null.`);
      sets[k] = true;
    } else if (k === "color" || k === "fill") {
      if (typeof v !== "string" || !COLOR.test(v)) fail(`${k === "fill" ? "A fill" : "A text colour"} is a colour like #1a2b3c.`);
      sets[k] = v.toLowerCase();
    } else if (k === "align") {
      if (!["left", "center", "right"].includes(v)) fail("align is left, center, right or null.");
      sets[k] = v;
    } else if (k === "fmt") {
      const p = resolveFormat(v);
      if (p === null) unsets.push(k);
      else sets[k] = p;
    }
  }
  return { sets, unsets };
}

const sortRank = (v) => (v === null || v === undefined || v === "" ? 4 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3);

function sortCompare(a, b) {
  const ra = sortRank(a);
  const rb = sortRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a - b;
  if (ra === 1) {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ra === 2) return Number(a) - Number(b);
  return 0;
}

const isNum = (raw) => typeof raw === "number";

/** A constant step through a list of raw numbers, or null when the list is not such a series. */
function stepOf(list) {
  if (list.length < 2 || !list.every(isNum)) return null;
  const step = list[1] - list[0];
  for (let k = 2; k < list.length; k++) {
    const d = list[k] - list[k - 1];
    if (Math.abs(d - step) > 1e-9 * Math.max(1, Math.abs(step))) return null;
  }
  return step;
}

const OPS = ["set", "style", "insertRows", "deleteRows", "insertCols", "deleteCols", "sort", "fill", "resize", "widths", "heights", "freeze", "addTab", "renameTab", "removeTab", "moveTab", "title"];

/** Applies ops to a workbook without changing it: `{ workbook, ranges: [{ tab, range }], what }`. Throws a
 * sentence on a bad op. Indexes are 0-based; `tab` is an id or a name (the first tab when left out). */
export function applyOps(wb, ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  const next = { ...wb, tabs: wb.tabs.slice() };
  const copied = new Set();
  const ranges = [];
  const phrases = [];
  const touched = new Map();

  const indexOf = (ref) => {
    if (ref === undefined || ref === null) return 0;
    const t = findTab(next, ref);
    if (!t) fail(`There is no tab ${ref} in this sheet; the tabs are ${next.tabs.map((x) => x.name).join(", ")}.`);
    return next.tabs.indexOf(t);
  };
  const mut = (i) => {
    const t = next.tabs[i];
    if (copied.has(t)) return t;
    const c = { ...t, freeze: { ...t.freeze } };
    next.tabs[i] = c;
    copied.add(c);
    return c;
  };
  const note = (tab, g) => ranges.push({ tab: tab.id, range: rangeText(g) });
  const field = (t, key) => {
    let set = touched.get(t);
    if (!set) touched.set(t, (set = new Set()));
    if (!set.has(key)) {
      t[key] = { ...t[key] };
      set.add(key);
    }
    return t[key];
  };
  const rewriteAll = (fn) => {
    next.tabs.forEach((t, i) => {
      let cells = null;
      for (const a in t.cells) {
        const raw = t.cells[a];
        if (typeof raw !== "string" || raw[0] !== "=") continue;
        const out = fn(raw, t);
        if (out === raw) continue;
        if (!cells) cells = field(mut(i), "cells");
        cells[a] = out;
      }
    });
  };

  for (const op of list) {
    if (!isObj(op) || typeof op.op !== "string") fail(`An op is an object like { op: "set", tab, cells }; the ops are ${OPS.join(", ")}.`);
    switch (op.op) {
      case "set": {
        if (!isObj(op.cells)) fail("set needs cells: { A1: value, … }.");
        const i = indexOf(op.tab);
        const t = mut(i);
        const cells = field(t, "cells");
        const written = [];
        let cleared = 0;
        for (const [a, raw] of Object.entries(op.cells)) {
          const p = parseAddr(a);
          if (!p) fail(`"${a}" is not a cell address like B3 (columns A to ZZ, rows 1 to ${LIMITS.rows}).`);
          const key = addr(p.row, p.col);
          if (raw === null || raw === undefined || raw === "") {
            if (own(cells, key)) delete cells[key];
            cleared++;
          } else {
            checkRaw(raw, key);
            cells[key] = raw;
          }
          growTo(t, { r2: p.row, c2: p.col });
          written.push(p);
        }
        if (isObj(op.fmts)) {
          for (const [a, fmt] of Object.entries(op.fmts)) {
            const p = parseAddr(a);
            if (!p) fail(`"${a}" is not a cell address like B3.`);
            const key = addr(p.row, p.col);
            const pattern = resolveFormat(fmt);
            if (pattern === null || t.styles[key]?.fmt) continue;
            const styles = field(t, "styles");
            styles[key] = { ...styles[key], fmt: pattern };
            growTo(t, { r2: p.row, c2: p.col });
          }
        }
        for (const g of cellRanges(written)) note(t, g);
        phrases.push(cleared === written.length && cleared ? `cleared ${plural(cleared, "cell")}` : `wrote ${plural(written.length, "cell")}`);
        break;
      }
      case "style": {
        const i = indexOf(op.tab);
        const t = mut(i);
        const g = clip(t, rangeIn(t, op.range));
        const { sets, unsets } = normStyle(op.style ?? {});
        const styles = field(t, "styles");
        const hasSets = Object.keys(sets).length > 0;
        if (op.clear || !hasSets) {
          for (const a of Object.keys(styles)) {
            const p = parseAddr(a);
            if (!p || p.row < g.r1 || p.row > g.r2 || p.col < g.c1 || p.col > g.c2) continue;
            if (op.clear) delete styles[a];
            else {
              const s = { ...styles[a] };
              for (const k of unsets) delete s[k];
              if (Object.keys(s).length) styles[a] = s;
              else delete styles[a];
            }
          }
        }
        if (hasSets) {
          const area = (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1);
          if (area > LIMITS.styles) fail(`Formatting ${rangeText(g)} would touch ${area.toLocaleString("en-US")} cells; format a smaller range.`);
          for (let r = g.r1; r <= g.r2; r++)
            for (let c = g.c1; c <= g.c2; c++) {
              const a = addr(r, c);
              const s = { ...styles[a], ...sets };
              for (const k of unsets) delete s[k];
              styles[a] = s;
            }
          if (Object.keys(styles).length > LIMITS.styles) fail(`A sheet holds formatting for at most ${LIMITS.styles.toLocaleString("en-US")} cells; format a smaller range.`);
        }
        note(t, g);
        phrases.push(op.clear && !hasSets && !unsets.length ? `cleared the formatting of ${rangeText(g)}` : `formatted ${rangeText(g)}`);
        break;
      }
      case "insertRows":
      case "deleteRows":
      case "insertCols":
      case "deleteCols": {
        const i = indexOf(op.tab);
        const t = mut(i);
        const isRow = op.op.endsWith("Rows");
        const insert = op.op.startsWith("insert");
        const at = int(op.at, "at");
        const count = op.count === undefined ? 1 : int(op.count, "count");
        if (count < 1) fail("count is 1 or more.");
        const size = isRow ? t.rows : t.cols;
        const limit = isRow ? LIMITS.rows : LIMITS.cols;
        const noun = isRow ? "row" : "column";
        const label = (k) => (isRow ? String(k + 1) : colName(k));
        if (insert) {
          if (at < 0 || at > size) fail(`Insert ${noun}s at 1 to ${isRow ? size + 1 : colName(size)}; the tab has ${plural(size, noun)}.`);
          if (size + count > limit) fail(`The tab would grow past ${limit.toLocaleString("en-US")} ${noun}s; delete some first or insert fewer.`);
        } else {
          if (at < 0 || at + count > size) fail(`There are only ${plural(size, noun)}; delete ${noun}s within them.`);
          if (count >= size) fail(`A tab keeps at least one ${noun}.`);
        }
        const signed = insert ? count : -count;
        const axis = isRow ? "row" : "col";
        t.cells = moveKeys(t.cells, axis, at, signed);
        t.styles = moveKeys(t.styles, axis, at, signed);
        const tk = touched.get(t) ?? new Set();
        tk.add("cells").add("styles");
        if (isRow) {
          t.heights = moveLines(t.heights, at, signed, (k) => Number(k) - 1, (w) => String(w + 1));
          tk.add("heights");
          t.rows = size + signed;
        } else {
          t.widths = moveLines(t.widths, at, signed, (k) => colIndex(k), (w) => colName(w));
          tk.add("widths");
          t.cols = size + signed;
        }
        touched.set(t, tk);
        const fk = isRow ? "rows" : "cols";
        if (at < t.freeze[fk]) t.freeze[fk] = insert ? t.freeze[fk] + count : t.freeze[fk] - (Math.min(t.freeze[fk], at + count) - at);
        const target = t.name;
        rewriteAll((raw, tab) => shiftRefs(raw, { ownTab: tab.name, tab: target, axis, at, count: signed }));
        const span = insert ? { lo: at, hi: at + count - 1 } : { lo: Math.min(at, (isRow ? t.rows : t.cols) - 1), hi: Math.min(at, (isRow ? t.rows : t.cols) - 1) };
        note(t, isRow ? { r1: span.lo, c1: 0, r2: span.hi, c2: t.cols - 1 } : { r1: 0, c1: span.lo, r2: t.rows - 1, c2: span.hi });
        phrases.push(`${insert ? "inserted" : "deleted"} ${plural(count, noun)} at ${noun} ${label(at)}`);
        break;
      }
      case "sort": {
        const i = indexOf(op.tab);
        const t = mut(i);
        const used = usedRange(t);
        const g0 = op.range === undefined || op.range === null ? used : rangeIn(t, op.range);
        if (!g0) {
          phrases.push("sorted nothing");
          break;
        }
        const g = clip(t, g0);
        const by = typeof op.by === "string" ? colIndex(op.by.trim()) : op.by;
        if (!Number.isInteger(by) || by < g.c1 || by > g.c2) fail(`Sort by a column inside ${rangeText(g)} (${colName(g.c1)} to ${colName(g.c2)}).`);
        const top = op.header ? g.r1 + 1 : g.r1;
        const last = used ? Math.min(g.r2, used.r2) : -1;
        if (top > last) {
          phrases.push("sorted nothing");
          break;
        }
        const values = compute(next);
        const rowsIn = [];
        for (let r = top; r <= last; r++) rowsIn.push({ r, v: values.value(t.id, addr(r, by)) });
        const desc = Boolean(op.desc);
        rowsIn.sort((a, b) => {
          const ra = sortRank(a.v);
          const rb = sortRank(b.v);
          if (ra === 4 || rb === 4) return ra === rb ? 0 : ra === 4 ? 1 : -1;
          return desc ? sortCompare(b.v, a.v) : sortCompare(a.v, b.v);
        });
        const cells = field(t, "cells");
        const styles = field(t, "styles");
        const oldCells = { ...cells };
        const oldStyles = { ...styles };
        rowsIn.forEach(({ r: from }, k) => {
          const to = top + k;
          if (from === to) return;
          for (let c = g.c1; c <= g.c2; c++) {
            const src = addr(from, c);
            const dst = addr(to, c);
            const raw = oldCells[src];
            if (raw === undefined) delete cells[dst];
            else cells[dst] = typeof raw === "string" && raw[0] === "=" ? translate(raw, to - from, 0) : raw;
            if (oldStyles[src] === undefined) delete styles[dst];
            else styles[dst] = oldStyles[src];
          }
        });
        note(t, g);
        phrases.push(`sorted ${rangeText(g)} by column ${colName(by)}${desc ? " descending" : ""}`);
        break;
      }
      case "fill": {
        const i = indexOf(op.tab);
        const t = mut(i);
        const from = rangeIn(t, op.from, "source range");
        const to = rangeIn(t, op.to, "range to fill");
        if (to.r1 > from.r1 || to.c1 > from.c1 || to.r2 < from.r2 || to.c2 < from.c2) fail(`The range to fill (${rangeText(to)}) must contain the source (${rangeText(from)}).`);
        const area = (to.r2 - to.r1 + 1) * (to.c2 - to.c1 + 1);
        if (area > LIMITS.cells) fail(`Filling ${rangeText(to)} would write ${area.toLocaleString("en-US")} cells; fill a smaller range.`);
        growTo(t, to);
        const h = from.r2 - from.r1 + 1;
        const w = from.c2 - from.c1 + 1;
        const vertical = to.c1 === from.c1 && to.c2 === from.c2;
        const horizontal = to.r1 === from.r1 && to.r2 === from.r2;
        const cells = field(t, "cells");
        const styles = field(t, "styles");
        const steps = new Map();
        if (vertical && !horizontal) {
          for (let c = from.c1; c <= from.c2; c++) {
            const list = [];
            for (let r = from.r1; r <= from.r2; r++) list.push(cells[addr(r, c)]);
            const s = stepOf(list);
            if (s !== null) steps.set(c, { first: list[0], step: s });
          }
        } else if (horizontal && !vertical) {
          for (let r = from.r1; r <= from.r2; r++) {
            const list = [];
            for (let c = from.c1; c <= from.c2; c++) list.push(cells[addr(r, c)]);
            const s = stepOf(list);
            if (s !== null) steps.set(r, { first: list[0], step: s });
          }
        }
        const mod = (a, n) => ((a % n) + n) % n;
        const src = { ...cells };
        const srcStyles = { ...styles };
        for (let r = to.r1; r <= to.r2; r++)
          for (let c = to.c1; c <= to.c2; c++) {
            if (r >= from.r1 && r <= from.r2 && c >= from.c1 && c <= from.c2) continue;
            const sr = from.r1 + mod(r - from.r1, h);
            const sc = from.c1 + mod(c - from.c1, w);
            const dst = addr(r, c);
            const sa = addr(sr, sc);
            const series = vertical && !horizontal ? steps.get(c) : horizontal && !vertical ? steps.get(r) : undefined;
            if (series) {
              const k = vertical ? r - from.r1 : c - from.c1;
              cells[dst] = Number((series.first + series.step * k).toPrecision(15));
            } else {
              const raw = src[sa];
              if (raw === undefined) delete cells[dst];
              else cells[dst] = typeof raw === "string" && raw[0] === "=" ? translate(raw, r - sr, c - sc) : raw;
            }
            if (srcStyles[sa] === undefined) delete styles[dst];
            else styles[dst] = srcStyles[sa];
          }
        note(t, to);
        phrases.push(`filled ${rangeText(to)} from ${rangeText(from)}`);
        break;
      }
      case "resize": {
        const i = indexOf(op.tab);
        const t = mut(i);
        const rows = op.rows === undefined || op.rows === null ? t.rows : int(op.rows, "rows");
        const cols = op.cols === undefined || op.cols === null ? t.cols : int(op.cols, "cols");
        if (rows < 1 || rows > LIMITS.rows) fail(`A tab has 1 to ${LIMITS.rows.toLocaleString("en-US")} rows.`);
        if (cols < 1 || cols > LIMITS.cols) fail(`A tab has 1 to ${LIMITS.cols} columns (A to ZZ).`);
        const used = usedRange(t);
        if (used && used.r2 >= rows) fail(`Row ${used.r2 + 1} still holds data; clear it first or keep at least ${used.r2 + 1} rows.`);
        if (used && used.c2 >= cols) fail(`Column ${colName(used.c2)} still holds data; clear it first or keep at least ${used.c2 + 1} columns.`);
        if (rows < t.rows || cols < t.cols) {
          const styles = field(t, "styles");
          for (const a of Object.keys(styles)) {
            const p = parseAddr(a);
            if (!p || p.row >= rows || p.col >= cols) delete styles[a];
          }
          const widths = field(t, "widths");
          for (const k of Object.keys(widths)) if (colIndex(k) >= cols) delete widths[k];
          const heights = field(t, "heights");
          for (const k of Object.keys(heights)) if (Number(k) > rows) delete heights[k];
        }
        t.rows = rows;
        t.cols = cols;
        t.freeze.rows = Math.min(t.freeze.rows, rows);
        t.freeze.cols = Math.min(t.freeze.cols, cols);
        phrases.push(`resized ${t.name} to ${plural(rows, "row")} × ${plural(cols, "column")}`);
        break;
      }
      case "widths": {
        if (!isObj(op.cols)) fail('widths needs cols: { A: 140, B: null }.');
        const i = indexOf(op.tab);
        const t = mut(i);
        const widths = field(t, "widths");
        for (const [k, px] of Object.entries(op.cols)) {
          const c = colIndex(k.trim());
          if (c < 0 || c >= t.cols) fail(`"${k}" is not a column of ${t.name} (A to ${colName(t.cols - 1)}).`);
          const name = colName(c);
          if (px === null || px === undefined) delete widths[name];
          else {
            if (typeof px !== "number" || !Number.isFinite(px) || px < 20 || px > 1000) fail("A column width is 20 to 1000 px; null resets it.");
            widths[name] = Math.round(px);
          }
        }
        phrases.push(`set the width of ${plural(Object.keys(op.cols).length, "column")}`);
        break;
      }
      case "heights": {
        if (!isObj(op.rows)) fail('heights needs rows: { "3": 40, "4": null }.');
        const i = indexOf(op.tab);
        const t = mut(i);
        const heights = field(t, "heights");
        for (const [k, px] of Object.entries(op.rows)) {
          const r = Number(k);
          if (!Number.isInteger(r) || r < 1 || r > t.rows) fail(`"${k}" is not a row of ${t.name} (1 to ${t.rows}).`);
          if (px === null || px === undefined) delete heights[String(r)];
          else {
            if (typeof px !== "number" || !Number.isFinite(px) || px < 16 || px > 400) fail("A row height is 16 to 400 px; null resets it.");
            heights[String(r)] = Math.round(px);
          }
        }
        phrases.push(`set the height of ${plural(Object.keys(op.rows).length, "row")}`);
        break;
      }
      case "freeze": {
        const i = indexOf(op.tab);
        const t = mut(i);
        const rows = op.rows === undefined || op.rows === null ? t.freeze.rows : int(op.rows, "rows");
        const cols = op.cols === undefined || op.cols === null ? t.freeze.cols : int(op.cols, "cols");
        if (rows < 0 || rows > t.rows || cols < 0 || cols > t.cols) fail(`Freeze 0 to ${t.rows} rows and 0 to ${t.cols} columns.`);
        t.freeze = { rows, cols };
        phrases.push(rows || cols ? `froze ${plural(rows, "row")} and ${plural(cols, "column")}` : "unfroze the panes");
        break;
      }
      case "addTab": {
        if (next.tabs.length >= LIMITS.tabs) fail(`A sheet holds at most ${LIMITS.tabs} tabs; delete one first.`);
        const name = String(op.name ?? "").trim();
        const why = validTabName(name, next);
        if (why) fail(why);
        let id = op.id;
        if (id !== undefined && id !== null) {
          if (!isTabId(id)) fail("A tab id looks like t7.");
          if (next.tabs.some((t) => t.id === id)) fail(`The tab id ${id} is taken; leave id out to get a new one.`);
        } else id = newTabId(next);
        const at = op.at === undefined || op.at === null ? next.tabs.length : int(op.at, "at");
        if (at < 0 || at > next.tabs.length) fail(`Put a tab at 0 to ${next.tabs.length}.`);
        const tab = blankTab(id, name);
        if (Number.isInteger(op.rows)) tab.rows = Math.max(1, Math.min(LIMITS.rows, op.rows));
        if (Number.isInteger(op.cols)) tab.cols = Math.max(1, Math.min(LIMITS.cols, op.cols));
        copied.add(tab);
        next.tabs.splice(at, 0, tab);
        ranges.push({ tab: id, range: "A1" });
        phrases.push(`added the tab ${name}`);
        break;
      }
      case "renameTab": {
        const i = indexOf(op.tab);
        const name = String(op.name ?? "").trim();
        const why = validTabName(name, next, next.tabs[i].id);
        if (why) fail(why);
        const old = next.tabs[i].name;
        if (old === name) {
          phrases.push(`kept the tab name ${name}`);
          break;
        }
        mut(i).name = name;
        rewriteAll((raw) => renameTabRefs(raw, old, name));
        phrases.push(`renamed the tab ${old} to ${name}`);
        break;
      }
      case "removeTab": {
        const i = indexOf(op.tab);
        if (next.tabs.length < 2) fail("A sheet keeps at least one tab; delete the whole sheet instead.");
        const [gone] = next.tabs.splice(i, 1);
        rewriteAll((raw) => dropTabRefs(raw, gone.name));
        phrases.push(`deleted the tab ${gone.name}`);
        break;
      }
      case "moveTab": {
        const i = indexOf(op.tab);
        const to = int(op.to, "to");
        if (to < 0 || to >= next.tabs.length) fail(`Move a tab to 0 to ${next.tabs.length - 1}.`);
        const [t] = next.tabs.splice(i, 1);
        next.tabs.splice(to, 0, t);
        phrases.push(`moved the tab ${t.name} to place ${to + 1}`);
        break;
      }
      case "title": {
        const title = String(op.title ?? "").trim();
        if (!title || title.length > LIMITS.titleChars) fail(`A sheet's title is 1 to ${LIMITS.titleChars} characters.`);
        next.title = title;
        phrases.push(`renamed the sheet to ${title}`);
        break;
      }
      default:
        fail(`Unknown op "${op.op}"; the ops are ${OPS.join(", ")}.`);
    }
  }

  const count = cellCount(next);
  if (count > LIMITS.cells) fail(`A sheet holds at most ${LIMITS.cells.toLocaleString("en-US")} non-empty cells; this change would make ${count.toLocaleString("en-US")}. Split the data across sheets.`);
  const live = new Set(next.tabs.map((t) => t.id));
  return { workbook: next, ranges: compactRanges(ranges.filter((r) => live.has(r.tab))), what: summarize(phrases) };
}

function summarize(phrases) {
  if (!phrases.length) return "changed nothing";
  if (phrases.length === 1) return phrases[0];
  const wrote = phrases.filter((p) => /^wrote \d+ cells?$/.test(p));
  if (wrote.length === phrases.length) return `wrote ${plural(wrote.reduce((n, p) => n + Number(p.split(" ")[1]), 0), "cell")}`;
  const uniq = [...new Set(phrases)];
  return uniq.length <= 3 ? uniq.join(", ") : `${uniq.slice(0, 2).join(", ")} and ${uniq.length - 2} more changes`;
}
