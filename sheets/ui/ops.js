/* The page's own bookkeeping over workbook ops, pure so the node tests reach it: how a range is written in
 * an op, the cells of a sparse map inside a range, the ops that clear a selection, and undo — the ops that
 * take a workbook back from `after` to `before`. Undo is ops, not a snapshot, because another writer may
 * have changed other cells in between: a structural op is undone by its opposite (an insert by a delete, a
 * removed tab by an added one with the same id), and then every cell, style, size and freeze the two still
 * disagree on is written back exactly. A plain edit compares only the ranges it touched; a structural one
 * compares the whole workbook, so a formula elsewhere that a delete turned into #REF! comes back too. */

import { addr, colName, parseAddr, parseRange, rangeText } from "./core/address.js";
import { applyOps, findTab } from "./core/workbook.js";

/** How an op names a range: A1 text, as the Change log and the tools write it. */
export const rangeArg = (r) => rangeText(r);

/** The keys of a sparse `{ A1: … }` map that fall in `range` ({ r1, c1, r2, c2 }). */
export function keysIn(map, range) {
  const out = [];
  if (!map) return out;
  for (const key of Object.keys(map)) {
    const p = parseAddr(key);
    if (p && p.row >= range.r1 && p.row <= range.r2 && p.col >= range.c1 && p.col <= range.c2) out.push(key);
  }
  return out;
}

/** The set op that empties the values of `range` on a tab, or null when nothing there has a value. */
export function clearValuesOp(tab, range) {
  const keys = keysIn(tab.cells, range);
  if (!keys.length) return null;
  return { op: "set", tab: tab.id, cells: Object.fromEntries(keys.map((k) => [k, null])) };
}

const STRUCTURAL = new Set(["insertRows", "deleteRows", "insertCols", "deleteCols", "addTab", "removeTab", "renameTab", "moveTab", "resize", "sort"]);
const sameStyle = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameRaw = (a, b) => a === b;

/**
 * Style writes grouped: cells that go back to the same style, in runs down a column, one op per run. A
 * column formatted whole is undone by one op, not twenty thousand.
 */
export function styleOps(tabId, targets) {
  const groups = new Map(); // json of style -> [{ row, col }]
  for (const [key, style] of targets) {
    const p = parseAddr(key);
    if (!p) continue;
    const json = JSON.stringify(style ?? {});
    if (!groups.has(json)) groups.set(json, []);
    groups.get(json).push(p);
  }
  const ops = [];
  for (const [json, cells] of groups) {
    const style = JSON.parse(json);
    cells.sort((a, b) => a.col - b.col || a.row - b.row);
    let run = null;
    const close = () => {
      if (run) ops.push({ op: "style", tab: tabId, range: rangeArg(run), style, clear: true });
      run = null;
    };
    for (const p of cells) {
      if (run && run.c1 === p.col && run.r2 === p.row - 1) run.r2 = p.row;
      else {
        close();
        run = { r1: p.row, c1: p.col, r2: p.row, c2: p.col };
      }
    }
    close();
  }
  return ops;
}

/** Keys of `a` or `b` (sparse maps) in `area` ({ ranges, keys }), or all of them when `area` is null. */
function scopedKeys(a, b, area) {
  const keys = new Set(area?.keys ?? []);
  if (!area) {
    for (const k of Object.keys(a ?? {})) keys.add(k);
    for (const k of Object.keys(b ?? {})) keys.add(k);
    return keys;
  }
  for (const r of area.ranges) {
    for (const k of keysIn(a, r)) keys.add(k);
    for (const k of keysIn(b, r)) keys.add(k);
  }
  return keys;
}

/**
 * The ops that make `from` agree with `to`, tab by tab (by id), over `scope`: null for everything, else a
 * Map of tab id -> { ranges, keys }. Sizes, widths, heights and freeze are compared only when `scope` is null.
 */
export function diffOps(from, to, scope = null) {
  const first = [];
  const cells = [];
  const last = [];
  for (const target of to.tabs) {
    const tab = from.tabs.find((t) => t.id === target.id);
    if (!tab) continue;
    if (scope && !scope.has(tab.id)) continue;
    const area = scope ? scope.get(tab.id) : null;
    if (!scope) {
      const grow = { rows: Math.max(tab.rows, target.rows), cols: Math.max(tab.cols, target.cols) };
      if (grow.rows !== tab.rows || grow.cols !== tab.cols) first.push({ op: "resize", tab: tab.id, ...grow });
      if (grow.rows !== target.rows || grow.cols !== target.cols) last.push({ op: "resize", tab: tab.id, rows: target.rows, cols: target.cols });
      const widths = {};
      for (const k of new Set([...Object.keys(tab.widths ?? {}), ...Object.keys(target.widths ?? {})])) if ((tab.widths ?? {})[k] !== (target.widths ?? {})[k]) widths[k] = (target.widths ?? {})[k] ?? null;
      if (Object.keys(widths).length) cells.push({ op: "widths", tab: tab.id, cols: widths });
      const heights = {};
      for (const k of new Set([...Object.keys(tab.heights ?? {}), ...Object.keys(target.heights ?? {})])) if ((tab.heights ?? {})[k] !== (target.heights ?? {})[k]) heights[k] = (target.heights ?? {})[k] ?? null;
      if (Object.keys(heights).length) cells.push({ op: "heights", tab: tab.id, rows: heights });
      const fa = tab.freeze ?? { rows: 0, cols: 0 };
      const fb = target.freeze ?? { rows: 0, cols: 0 };
      if (fa.rows !== fb.rows || fa.cols !== fb.cols) cells.push({ op: "freeze", tab: tab.id, rows: fb.rows, cols: fb.cols });
    }
    const set = {};
    for (const k of scopedKeys(tab.cells, target.cells, area)) {
      const want = target.cells?.[k];
      if (!sameRaw(tab.cells?.[k], want)) set[k] = want === undefined ? null : want;
    }
    if (Object.keys(set).length) cells.push({ op: "set", tab: tab.id, cells: set });
    const styles = [];
    for (const k of scopedKeys(tab.styles, target.styles, area)) {
      const want = target.styles?.[k];
      if (!sameStyle(tab.styles?.[k], want)) styles.push([k, want ?? {}]);
    }
    cells.push(...styleOps(tab.id, styles));
  }
  return [...first, ...cells, ...last];
}

/** The opposite of each structural op, newest first, as far as an op can say it by itself. */
function opposites(before, ops) {
  const out = [];
  let wb = before;
  for (const op of ops) {
    const tab = op.tab !== undefined ? findTab(wb, op.tab) : null;
    switch (op.op) {
      case "insertRows": out.unshift({ op: "deleteRows", tab: tab.id, at: op.at, count: op.count ?? 1 }); break;
      case "deleteRows": out.unshift({ op: "insertRows", tab: tab.id, at: op.at, count: op.count ?? 1 }); break;
      case "insertCols": out.unshift({ op: "deleteCols", tab: tab.id, at: op.at, count: op.count ?? 1 }); break;
      case "deleteCols": out.unshift({ op: "insertCols", tab: tab.id, at: op.at, count: op.count ?? 1 }); break;
      case "renameTab": out.unshift({ op: "renameTab", tab: tab.id, name: tab.name }); break;
      case "moveTab": out.unshift({ op: "moveTab", tab: tab.id, to: wb.tabs.indexOf(tab) }); break;
      case "removeTab": out.unshift({ op: "addTab", id: tab.id, name: tab.name, at: wb.tabs.indexOf(tab) }); break;
      case "title": out.unshift({ op: "title", title: wb.title }); break;
      default: break;
    }
    if (op.op === "addTab") {
      const next = applyOps(wb, [op]).workbook;
      const added = next.tabs.find((t) => !wb.tabs.some((x) => x.id === t.id));
      if (added) out.unshift({ op: "removeTab", tab: added.id });
      wb = next;
    } else wb = applyOps(wb, [op]).workbook;
  }
  return out;
}

/**
 * The ops that undo `ops`, which took `before` to `after` and reported `ranges` ([{ tab, range }]).
 * Answers [] when there is nothing to undo.
 */
export function inverseOf(before, after, ops, ranges) {
  const structural = ops.some((op) => STRUCTURAL.has(op.op));
  const sizes = ops.some((op) => op.op === "widths" || op.op === "heights" || op.op === "freeze");
  const back = opposites(before, ops);
  const mid = back.length ? applyOps(after, back).workbook : after;
  let scope = null;
  if (!structural && !sizes) {
    scope = new Map();
    const areaOf = (id) => {
      if (!scope.has(id)) scope.set(id, { ranges: [], keys: new Set() });
      return scope.get(id);
    };
    for (const { tab, range } of ranges ?? []) {
      const t = findTab(after, tab) ?? findTab(before, tab);
      const r = typeof range === "string" ? parseRange(range, t ? { rows: Math.max(t.rows, findTab(before, t.id)?.rows ?? 0), cols: Math.max(t.cols, findTab(before, t.id)?.cols ?? 0) } : undefined) : range;
      if (t && r) areaOf(t.id).ranges.push(r);
    }
    for (const op of ops) {
      // Belt and braces: a set names its cells exactly, whatever the change log merged them into.
      if (op.op !== "set") continue;
      const t = findTab(after, op.tab);
      if (!t) continue;
      const keys = areaOf(t.id).keys;
      for (const key of Object.keys(op.cells ?? {})) keys.add(key.toUpperCase());
    }
  }
  const title = before.title !== mid.title ? [{ op: "title", title: before.title }] : [];
  return [...back, ...title, ...diffOps(mid, before, scope)];
}

export { addr, colName };
