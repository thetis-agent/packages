// The nine tools, run in the person's fence. Each names its sheet by id or unique title and its tab by name
// (lib/resolve.js), changes the workbook only through `mutate` (lib/store.js) so a write lands on top of
// whatever the person saved a moment before, answers plain text whose first line says what happened and
// the revision it left, and refuses with a sentence. The spreadsheet rules themselves — parsing a typed
// value, formulas, formats, inserting rows — are the pure modules under `ui/core/`, shared with the page.
// Two answers carry the collaboration: sheet_read lists what the person edited lately, and sheet_write
// says which of the cells it replaced the person had changed in the last ten minutes.
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { resolveContained, writeRefusal } from "@thetis/tools-files/lib/paths.js";
import { addr, colIndex, colName, MAX_COLS, MAX_ROWS, parseAddr, rangeText } from "../ui/core/address.js";
import { compute } from "../ui/core/engine.js";
import { resolveFormat } from "../ui/core/format.js";
import { isError } from "../ui/core/values.js";
import { applyOps, emptyWorkbook, usedRange } from "../ui/core/workbook.js";
import { isProjectId, projectExists, projectOfSession, readProject } from "./projects.js";
import { ago, plural, qualified, rangeIn, renderRead, styleWords } from "./read.js";
import { resolveSheet, resolveTab } from "./resolve.js";
import { atomicWrite, cellsOf, createSheet, fail, listSheets, MAX_SHEETS, mutate, newId, removeSheet } from "./store.js";
import { addTableTab, blockCells, checkValue, delimiterOf, displayOf, MAX_FILE, parseTable, tabNameFrom, tabText } from "./transfer.js";
import { fromValue } from "../ui/core/input.js";

const PERSON_WINDOW_MS = 10 * 60 * 1000;
const FORMULAS_SHOWN = 30;
const LISTED = 12;

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
const agent = (env) => ({ by: "agent", session: env.session?.id });
const given = (v) => v !== undefined && v !== null && v !== "";

/** A list of addresses, the first twelve and a count of the rest. */
const listed = (list) => (list.length > LISTED ? `${list.slice(0, LISTED).join(", ")} and ${list.length - LISTED} more` : list.join(", "));

/** A project for a sheet: the id given (must exist), "none" for global, or the conversation's own when nothing was said. */
async function projectFor(env, value) {
  if (!given(value)) {
    const own = await projectOfSession(env, env.session?.id);
    return { project: own, defaulted: Boolean(own) };
  }
  if (value === "none" || value === "global") return { project: null, defaulted: false };
  if (!isProjectId(value)) fail(`${JSON.stringify(value)} is not a project id; one looks like p_1a2b3c4d. Say "none" for a global sheet.`);
  if (!(await projectExists(env, value))) fail(`No project ${value}.`);
  return { project: value, defaulted: false };
}

export async function projectPhrase(env, id) {
  if (!id) return "global";
  const record = await readProject(env, id);
  return `project ${record ? `${JSON.stringify(record.name)} (${id})` : `${id} (no longer there)`}`;
}

async function roomForOneMore(env) {
  if ((await listSheets(env)).length >= MAX_SHEETS) fail(`At most ${MAX_SHEETS} sheets; delete one first with sheet_delete.`);
}

/** Every error a computed workbook holds, keyed `tab!addr`. */
const errorKeys = (computed) => new Set((computed.errors ?? []).map((e) => `${e.tab}!${e.addr}`));

/** Errors that `after` has and `before` did not, outside the cells just written, as lines. */
function newErrors(workbook, before, after, skip = new Set()) {
  const had = errorKeys(before);
  const names = new Map(workbook.tabs.map((t) => [t.id, t.name]));
  return (after.errors ?? [])
    .filter((e) => !had.has(`${e.tab}!${e.addr}`) && !skip.has(`${e.tab}!${e.addr}`))
    .map((e) => `${qualified(names.get(e.tab) ?? e.tab, e.addr)} ${e.value?.err ?? "#ERROR!"}${e.value?.msg ? ` — ${e.value.msg}` : ""}`);
}

/** The cells of a tab the person changed in the last ten minutes, by the change log. */
function personTouched(workbook, tabId, now = Date.now()) {
  const boxes = [];
  for (const change of workbook.changes ?? []) {
    if (change.by !== "person" || now - Date.parse(change.at) > PERSON_WINDOW_MS) continue;
    for (const r of change.ranges ?? []) {
      if (r.tab !== tabId) continue;
      const [a, b = a] = String(r.range).split(":");
      const p = parseAddr(a);
      const q = parseAddr(b);
      if (p && q) boxes.push({ r1: Math.min(p.row, q.row), c1: Math.min(p.col, q.col), r2: Math.max(p.row, q.row), c2: Math.max(p.col, q.col) });
    }
  }
  return (row, col) => boxes.some((x) => row >= x.r1 && row <= x.r2 && col >= x.c1 && col <= x.c2);
}

/** The lines under a write's first line: formulas written with their values, errors, new errors elsewhere. */
function writeReport(workbook, tab, cells, before) {
  const computed = compute(workbook);
  const formulas = [];
  const errors = [];
  const written = new Set();
  for (const [at, raw] of Object.entries(cells)) {
    written.add(`${tab.id}!${at}`);
    const value = computed.value(tab.id, at);
    if (typeof raw === "string" && raw.startsWith("=")) formulas.push(`${at} ${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw} → ${displayOf(computed, tab, at) || "(blank)"}`);
    if (isError(value)) errors.push(`${at} ${value.err}${value.msg ? ` — ${value.msg}` : ""}`);
  }
  const out = [];
  if (formulas.length) out.push("Formulas:", ...formulas.slice(0, FORMULAS_SHOWN), ...(formulas.length > FORMULAS_SHOWN ? [`…and ${plural(formulas.length - FORMULAS_SHOWN, "more formula")}.`] : []));
  if (errors.length) out.push("Errors:", ...errors.slice(0, FORMULAS_SHOWN), ...(errors.length > FORMULAS_SHOWN ? [`…and ${plural(errors.length - FORMULAS_SHOWN, "more error")}.`] : []));
  if (before) {
    const elsewhere = newErrors(workbook, before, computed, written);
    if (elsewhere.length) out.push("Now erroring elsewhere:", ...elsewhere.slice(0, 10), ...(elsewhere.length > 10 ? [`…and ${elsewhere.length - 10} more.`] : []));
  }
  return out;
}

/** The ranges a set of written addresses covers: the block as one, loose cells one each (the store merges beyond twenty). */
function writtenRanges(tabId, block, loose) {
  const out = [];
  if (block) out.push({ tab: tabId, range: rangeText(block) });
  for (const at of loose) out.push({ tab: tabId, range: at });
  return out;
}

/** Cells by address from `cells` and a block from `at` + `rows`, parsed; the block's box and the loose addresses. */
function gatherWrite(args) {
  const literal = args.literal === true;
  const cells = {};
  const fmts = {};
  let block = null;
  const loose = [];
  if (given(args.at) || args.rows !== undefined) {
    if (!given(args.at) || !Array.isArray(args.rows)) fail("A block needs both at (the top-left cell, like A2) and rows (an array of rows).");
    const start = parseAddr(String(args.at));
    if (!start) fail(`at: ${JSON.stringify(args.at)} is not a cell address like A2 on the grid, which reaches ${addr(MAX_ROWS - 1, MAX_COLS - 1)} at most.`);
    const got = blockCells(args.rows, { row: start.row, col: start.col, literal });
    Object.assign(cells, got.cells);
    Object.assign(fmts, got.fmts);
    if (got.count) block = { r1: start.row, c1: start.col, r2: got.r2, c2: got.c2 };
  }
  if (args.cells !== undefined) {
    if (!args.cells || typeof args.cells !== "object" || Array.isArray(args.cells)) fail("cells must be an object of values by address, like {\"B4\": 12}.");
    for (const [key, value] of Object.entries(args.cells)) {
      const p = parseAddr(key);
      if (!p) fail(`${JSON.stringify(key)} is not a cell address like B4 on the grid, which reaches ${addr(MAX_ROWS - 1, MAX_COLS - 1)} at most.`);
      checkValue(key, value);
      const at = addr(p.row, p.col);
      const { raw, fmt } = fromValue(value, { literal });
      cells[at] = raw ?? null;
      if (fmt && raw !== null && raw !== undefined) fmts[at] = fmt;
      else delete fmts[at];
      loose.push(at);
    }
  }
  const all = Object.keys(cells);
  if (!all.length) fail("Nothing to write: give cells ({\"B4\": 12}) or at with rows.");
  const points = all.map(parseAddr);
  const box = { r1: Math.min(...points.map((p) => p.row)), c1: Math.min(...points.map((p) => p.col)), r2: Math.max(...points.map((p) => p.row)), c2: Math.max(...points.map((p) => p.col)) };
  return { cells, fmts, block, loose, box };
}

// ---- the tools ----

export async function sheetCreate(args, env) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) fail("title is required.");
  const { project, defaulted } = await projectFor(env, args.project);
  if (args.tabs !== undefined && (!Array.isArray(args.tabs) || !args.tabs.length || args.tabs.some((t) => typeof t !== "string"))) fail("tabs must be a list of tab names, like [\"Costs\", \"Income\"].");
  await roomForOneMore(env);
  const now = new Date();
  let workbook = emptyWorkbook({ id: newId(), title, project, createdBy: env.session?.id ?? null, now, ...(args.tabs ? { tabs: args.tabs.map((t) => t.trim()) } : {}) });
  let cells = {};
  let range = null;
  if (args.rows !== undefined) {
    const got = blockCells(args.rows, { literal: false });
    if (got.count) {
      const first = workbook.tabs[0];
      const ops = [];
      if (got.r2 >= first.rows || got.c2 >= first.cols) ops.push({ op: "resize", tab: first.id, rows: Math.max(first.rows, got.r2 + 1), cols: Math.max(first.cols, got.c2 + 1) });
      ops.push({ op: "set", tab: first.id, cells: got.cells, fmts: got.fmts });
      workbook = applyOps(workbook, ops).workbook;
      cells = got.cells;
      range = { r1: 0, c1: 0, r2: got.r2, c2: got.c2 };
    }
  }
  const tab = workbook.tabs[0];
  const written = await createSheet(env, workbook, { ...agent(env), ranges: range ? [{ tab: tab.id, range: rangeText(range) }] : [], what: range ? `created the sheet with ${plural(Object.keys(cells).length, "cell")}` : "created the sheet" });
  const where = await projectPhrase(env, written.project);
  const out = [`Created sheet ${written.id} ${JSON.stringify(written.title)}, ${where}${defaulted ? " (this conversation's project)" : ""}, tabs ${written.tabs.map((t) => t.name).join(", ")}. The person opens it from Sheets in the sidebar. rev ${written.rev}.`];
  if (range) out.push(`Wrote ${plural(Object.keys(cells).length, "cell")} in ${qualified(tab.name, range)}.`, ...writeReport(written, written.tabs[0], cells, null));
  return out.join("\n");
}

export async function sheetList(args, env) {
  let all = await listSheets(env);
  if (given(args.project)) {
    if (args.project === "none" || args.project === "global") all = all.filter((s) => !s.project);
    else if (isProjectId(args.project)) all = all.filter((s) => s.project === args.project);
    else fail(`${JSON.stringify(args.project)} is not a project id; say "none" for the global sheets.`);
  }
  if (!all.length) return "No sheets yet. sheet_create makes one.";
  const lines = [];
  for (const s of all) lines.push(`${s.id} ${JSON.stringify(s.title)} · ${plural(s.tabs.length, "tab")} · ${await projectPhrase(env, s.project)} · updated ${ago(s.updatedAt)} · rev ${s.rev}`);
  return lines.join("\n");
}

export async function sheetRead(args, env) {
  const workbook = await resolveSheet(env, args.sheet);
  const { tab, range } = rangeIn(workbook, args.tab, args.range, resolveTab);
  return renderRead(workbook, { tab, range, formulas: args.formulas !== false, styles: args.styles === true, projectText: await projectPhrase(env, workbook.project) });
}

export async function sheetWrite(args, env) {
  const found = await resolveSheet(env, args.sheet);
  const tabId = resolveTab(found, args.tab).id;
  const { cells, fmts, block, loose, box } = gatherWrite(args);
  let replaced = [];
  let grew = null;
  let before = null;
  const written = await mutate(
    env,
    found.id,
    (workbook) => {
      const tab = workbook.tabs.find((t) => t.id === tabId);
      if (!tab) fail("That tab was deleted a moment ago; sheet_read the sheet again.");
      const touched = personTouched(workbook, tab.id);
      replaced = Object.keys(cells).filter((at) => {
        const p = parseAddr(at);
        return touched(p.row, p.col) && (tab.cells[at] ?? null) !== cells[at];
      });
      before = compute(workbook);
      const ops = [];
      if (box.r2 >= tab.rows || box.c2 >= tab.cols) {
        grew = { rows: Math.max(tab.rows, box.r2 + 1), cols: Math.max(tab.cols, box.c2 + 1) };
        ops.push({ op: "resize", tab: tab.id, ...grew });
      }
      ops.push({ op: "set", tab: tab.id, cells, fmts });
      const n = Object.keys(cells).length;
      const cleared = Object.values(cells).filter((v) => v === null).length;
      const what = cleared === n ? `cleared ${plural(n, "cell")}` : cleared ? `wrote ${plural(n - cleared, "cell")}, cleared ${cleared}` : `wrote ${plural(n, "cell")}`;
      return { workbook: applyOps(workbook, ops).workbook, ranges: writtenRanges(tab.id, block, loose), what };
    },
    agent(env),
  );
  const tab = written.tabs.find((t) => t.id === tabId);
  const n = Object.keys(cells).length;
  const out = [`Wrote ${plural(n, "cell")} in ${qualified(tab.name, box)} of ${written.id} ${JSON.stringify(written.title)}. rev ${written.rev}.`];
  if (grew) out.push(`${tab.name} grew to ${plural(tab.rows, "row")} × ${plural(tab.cols, "column")} to hold them.`);
  out.push(...writeReport(written, tab, cells, before));
  if (replaced.length) out.push(`The person changed ${listed(replaced)} in the last 10 minutes; you replaced ${replaced.length === 1 ? "it" : "them"}.`);
  return out.join("\n");
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const colour = (key, value) => {
  if (value === null) return null;
  if (typeof value !== "string" || !HEX.test(value.trim())) fail(`${key} is a colour like #1a73e8, or null to remove it.`);
  const v = value.trim().toLowerCase();
  return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
};
const flag = (key, value) => {
  if (value !== null && typeof value !== "boolean") fail(`${key} is true, false or null.`);
  return value === true ? true : null;
};

export async function sheetFormat(args, env) {
  const found = await resolveSheet(env, args.sheet);
  if (!given(args.range)) fail("range is required: like A1:D1, B:B or 2:2.");
  const { tab: target, range } = rangeIn(found, args.tab, args.range, resolveTab);
  if (range.r1 >= target.rows || range.c1 >= target.cols) fail(`${args.range} is outside ${target.name}, which is ${plural(target.rows, "row")} by ${plural(target.cols, "column")} (A..${colName(target.cols - 1)}); grow it with sheet_structure resize first.`);
  const box = { ...range, r2: Math.min(range.r2, target.rows - 1), c2: Math.min(range.c2, target.cols - 1) };
  const style = {};
  if (args.format !== undefined) style.fmt = args.format === null ? null : resolveFormat(String(args.format));
  for (const [key, short] of [["bold", "b"], ["italic", "i"], ["underline", "u"], ["strike", "s"], ["wrap", "wrap"]]) if (args[key] !== undefined) style[short] = flag(key, args[key]);
  if (args.color !== undefined) style.color = colour("color", args.color);
  if (args.fill !== undefined) style.fill = colour("fill", args.fill);
  if (args.align !== undefined) {
    if (args.align !== null && !["left", "center", "right"].includes(args.align)) fail("align is left, center, right, or null.");
    style.align = args.align;
  }
  const clear = args.clear === true;
  let widths = null;
  if (args.width !== undefined) {
    if (args.width !== null && (!Number.isInteger(args.width) || args.width < 20 || args.width > 1000)) fail("width is a whole number of pixels from 20 to 1000, or null to reset it.");
    widths = {};
    for (let c = box.c1; c <= box.c2; c++) widths[colName(c)] = args.width;
  }
  if (!Object.keys(style).length && !clear && !widths) fail("Nothing to format: give format, bold, italic, underline, strike, color, fill, align, wrap, width, or clear.");
  const written = await mutate(
    env,
    found.id,
    (workbook) => {
      const tab = workbook.tabs.find((t) => t.id === target.id);
      if (!tab) fail("That tab was deleted a moment ago; sheet_read the sheet again.");
      const ops = [];
      if (Object.keys(style).length || clear) ops.push({ op: "style", tab: tab.id, range: rangeText(box), style, ...(clear ? { clear: true } : {}) });
      if (widths) ops.push({ op: "widths", tab: tab.id, cols: widths });
      return { workbook: applyOps(workbook, ops).workbook, ranges: [{ tab: tab.id, range: rangeText(box) }], what: `formatted ${rangeText(box)}` };
    },
    agent(env),
  );
  const said = [];
  if (clear) said.push("cleared the formatting");
  const set = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== null && v !== undefined));
  if (Object.keys(set).length) said.push(styleWords(set));
  const removed = Object.entries(style).filter(([, v]) => v === null).map(([k]) => ({ b: "bold", i: "italic", u: "underline", s: "strikethrough", fmt: "format" })[k] ?? k);
  if (removed.length) said.push(`removed ${removed.join(", ")}`);
  if (widths) said.push(args.width === null ? "column width reset" : `width ${args.width} px`);
  return `Formatted ${qualified(target.name, box)}: ${said.join("; ")}. rev ${written.rev}.`;
}

/** A 1-based row number, as a number or a string. */
function rowAt(value, action) {
  const n = typeof value === "number" ? value : /^\s*\d+\s*$/.test(String(value ?? "")) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) fail(`${action} needs at: the row number, like "5".`);
  return n - 1;
}
function colAt(value, action) {
  const i = typeof value === "string" ? colIndex(value.trim().toUpperCase()) : -1;
  if (i < 0) fail(`${action} needs at: the column letter, like "C".`);
  return i;
}
function countOf(value) {
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value) || value < 1) fail("count is a whole number of rows or columns, 1 or more.");
  return value;
}

export async function sheetStructure(args, env) {
  const found = await resolveSheet(env, args.sheet);
  const action = args.action;
  const target = action === "rename_sheet" ? null : resolveTab(found, args.tab);
  let said = "";
  let before = null;
  const written = await mutate(
    env,
    found.id,
    (workbook) => {
      const tab = target ? workbook.tabs.find((t) => t.id === target.id) : null;
      if (target && !tab) fail("That tab was deleted a moment ago; sheet_read the sheet again.");
      before = compute(workbook);
      let op;
      let ranges = [];
      switch (action) {
        case "insert_rows":
        case "delete_rows": {
          const at = rowAt(args.at, action);
          const count = countOf(args.count);
          op = { op: action === "insert_rows" ? "insertRows" : "deleteRows", tab: tab.id, at, count };
          said = action === "insert_rows" ? `Inserted ${plural(count, "row")} before row ${at + 1} in ${tab.name}` : `Deleted ${count === 1 ? `row ${at + 1}` : `rows ${at + 1}–${at + count}`} of ${tab.name}`;
          break;
        }
        case "insert_columns":
        case "delete_columns": {
          const at = colAt(args.at, action);
          const count = countOf(args.count);
          op = { op: action === "insert_columns" ? "insertCols" : "deleteCols", tab: tab.id, at, count };
          said = action === "insert_columns" ? `Inserted ${plural(count, "column")} before ${colName(at)} in ${tab.name}` : `Deleted ${count === 1 ? `column ${colName(at)}` : `columns ${colName(at)}–${colName(at + count - 1)}`} of ${tab.name}`;
          break;
        }
        case "sort": {
          const { tab: named, range } = rangeIn(workbook, tab.id, args.range, resolveTab);
          if (named.id !== tab.id) fail(`range names tab ${JSON.stringify(named.name)}; give it as tab instead.`);
          const box = range ?? usedRange(tab);
          if (!box) fail(`${tab.name} is empty; there is nothing to sort.`);
          if (!given(args.by)) fail("sort needs by: the column letter to sort by, like \"C\".");
          const by = colIndex(String(args.by).trim().toUpperCase());
          if (by < box.c1 || by > box.c2) fail(`by: ${JSON.stringify(args.by)} is not a column of ${rangeText(box)}.`);
          op = { op: "sort", tab: tab.id, range: rangeText(box), by, desc: args.descending === true, header: args.header === true };
          said = `Sorted ${qualified(tab.name, box)} by column ${colName(by)}, ${args.descending ? "descending" : "ascending"}${args.header ? " (the header row kept in place)" : ""}`;
          break;
        }
        case "fill": {
          if (!given(args.from) || !given(args.to)) fail("fill needs from (the source range, like D2) and to (where the fill ends, like D50, or the whole range, like D2:D50).");
          const from = rangeIn(workbook, tab.id, args.from, resolveTab).range;
          // "from D2 to D50" and "from D2 to D2:D50" both mean the fill handle dragged to D50.
          const end = rangeIn(workbook, tab.id, args.to, resolveTab).range;
          const to = { r1: Math.min(from.r1, end.r1), c1: Math.min(from.c1, end.c1), r2: Math.max(from.r2, end.r2), c2: Math.max(from.c2, end.c2) };
          op = { op: "fill", tab: tab.id, from: rangeText(from), to: rangeText(to) };
          said = `Filled ${qualified(tab.name, to)} from ${rangeText(from)}`;
          break;
        }
        case "freeze": {
          const rows = args.rows ?? 0;
          const cols = args.columns ?? 0;
          if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(cols) || cols < 0) fail("freeze takes rows and columns: whole numbers, 0 to unfreeze.");
          op = { op: "freeze", tab: tab.id, rows, cols };
          said = rows || cols ? `Froze ${plural(rows, "row")} and ${plural(cols, "column")} of ${tab.name}` : `Unfroze ${tab.name}`;
          break;
        }
        case "resize": {
          if (args.rows === undefined && args.columns === undefined) fail("resize takes rows and/or columns: the tab's new size.");
          const rows = args.rows ?? tab.rows;
          const cols = args.columns ?? tab.cols;
          if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) fail(`rows is a whole number from 1 to ${MAX_ROWS}.`);
          if (!Number.isInteger(cols) || cols < 1 || cols > MAX_COLS) fail(`columns is a whole number from 1 to ${MAX_COLS}.`);
          op = { op: "resize", tab: tab.id, rows, cols };
          said = `${tab.name} is now ${plural(rows, "row")} × ${plural(cols, "column")} (A..${colName(cols - 1)})`;
          break;
        }
        case "add_tab": {
          if (!given(args.name)) fail("add_tab needs name: the new tab's name.");
          const name = String(args.name).trim();
          const at = args.position === undefined ? undefined : positionOf(args.position, workbook.tabs.length + 1);
          op = { op: "addTab", name, ...(at === undefined ? {} : { at }) };
          said = `Added tab ${JSON.stringify(name)} at position ${at === undefined ? workbook.tabs.length + 1 : at + 1}`;
          break;
        }
        case "rename_tab": {
          if (!given(args.name)) fail("rename_tab needs name: the tab's new name.");
          const name = String(args.name).trim();
          op = { op: "renameTab", tab: tab.id, name };
          said = `Renamed tab ${JSON.stringify(tab.name)} to ${JSON.stringify(name)}; formulas follow`;
          break;
        }
        case "delete_tab": {
          op = { op: "removeTab", tab: tab.id };
          said = `Deleted tab ${JSON.stringify(tab.name)} (${plural(Object.keys(tab.cells).length, "cell")})`;
          break;
        }
        case "move_tab": {
          const to = positionOf(args.position, workbook.tabs.length);
          op = { op: "moveTab", tab: tab.id, to };
          said = `Moved tab ${JSON.stringify(tab.name)} to position ${to + 1}`;
          break;
        }
        case "rename_sheet": {
          const title = typeof args.title === "string" ? args.title.trim() : "";
          if (!title) fail("rename_sheet needs title: the new title.");
          op = { op: "title", title };
          said = `Renamed the sheet to ${JSON.stringify(title)}`;
          break;
        }
        default:
          fail(`action is one of insert_rows, delete_rows, insert_columns, delete_columns, sort, fill, freeze, resize, add_tab, rename_tab, delete_tab, move_tab, rename_sheet.`);
      }
      const result = applyOps(workbook, [op]);
      ranges = result.ranges ?? [];
      return { workbook: result.workbook, ranges, what: result.what || action.replace("_", " ") };
    },
    agent(env),
  );
  const out = [`${said}. rev ${written.rev}.`];
  const errors = newErrors(written, before, compute(written));
  if (errors.length) out.push("Now erroring:", ...errors.slice(0, 10), ...(errors.length > 10 ? [`…and ${errors.length - 10} more.`] : []));
  return out.join("\n");
}

function positionOf(value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail(`position is a whole number from 1 to ${max}.`);
  return value - 1;
}

export async function sheetImport(args, env) {
  const resolved = await resolveContained(env, args.path);
  const name = basename(resolved.absolute);
  if (!/\.(csv|tsv|txt)$/i.test(name)) fail(`${resolved.display} is not a .csv, .tsv or .txt file.`);
  let st;
  try {
    st = await stat(resolved.absolute);
  } catch (e) {
    fail(e?.code === "ENOENT" ? `${resolved.display} does not exist.` : `${resolved.display} could not be read: ${e?.message ?? e}`);
  }
  if (!st.isFile()) fail(`${resolved.display} is not a file.`);
  if (st.size > MAX_FILE) fail(`${resolved.display} is ${Math.round(st.size / 1024 / 1024)} MB; at most 16 MB.`);
  const rows = parseTable(await readFile(resolved.absolute, "utf8"), { delimiter: delimiterOf(name) });
  const { project, defaulted } = given(args.sheet) ? { project: null, defaulted: false } : await projectFor(env, args.project);
  const done = await importRows(env, rows, { file: resolved.display, base: name, sheet: args.sheet, name: args.name, title: args.title, project, ...agent(env) });
  const where = done.created ? `new sheet ${done.workbook.id} ${JSON.stringify(done.workbook.title)}, ${await projectPhrase(env, done.workbook.project)}${defaulted ? " (this conversation's project)" : ""}` : `sheet ${done.workbook.id} ${JSON.stringify(done.workbook.title)} as a new tab`;
  return `Imported ${resolved.display} into ${where}: ${qualified(done.tab.name, done.range)}, ${plural(done.count, "cell")}. rev ${done.workbook.rev}.`;
}

/**
 * A table of rows as a new tab of `sheet` (a workbook already found), or as a new sheet in `project` (already
 * checked): the tool's and the upload's shared path. Answers the written workbook, the tab, the range, the cells.
 */
export async function importRows(env, rows, { file, base, sheet, name, title, project = null, by = "agent", session }) {
  if (sheet) {
    const found = typeof sheet === "string" ? await resolveSheet(env, sheet) : sheet;
    let landed;
    const written = await mutate(
      env,
      found.id,
      (workbook) => {
        const tabName = given(name) ? String(name).trim() : tabNameFrom(workbook, base);
        landed = addTableTab(workbook, rows, { name: tabName });
        return { workbook: landed.workbook, ranges: [{ tab: landed.tab.id, range: landed.range }], what: `imported ${file} as tab ${tabName}` };
      },
      { by, session },
    );
    return { workbook: written, tab: written.tabs.find((t) => t.id === landed.tab.id), range: landed.range, count: landed.count, created: false };
  }
  await roomForOneMore(env);
  const stem = String(base).replace(/\.(csv|tsv|txt)$/i, "");
  const sheetTitle = (given(title) ? String(title).trim() : stem).slice(0, 120) || "Imported sheet";
  const tabName = given(name) ? String(name).trim() : tabNameFrom(null, base);
  const empty = emptyWorkbook({ id: newId(), title: sheetTitle, project, createdBy: session ?? null, now: new Date(), tabs: [tabName] });
  const landed = addTableTab(empty, rows, { fill: empty.tabs[0].id });
  const written = await createSheet(env, landed.workbook, { by, session, ranges: [{ tab: landed.tab.id, range: landed.range }], what: `imported ${file}` });
  return { workbook: written, tab: written.tabs[0], range: landed.range, count: landed.count, created: true };
}

export async function sheetExport(args, env) {
  const workbook = await resolveSheet(env, args.sheet);
  const tab = resolveTab(workbook, args.tab);
  const resolved = await resolveContained(env, args.path, { write: true });
  const delimiter = /\.tsv$/i.test(resolved.absolute) ? "\t" : /\.csv$/i.test(resolved.absolute) ? "," : null;
  if (!delimiter) fail(`${args.path} must end in .csv or .tsv.`);
  if (args.values !== undefined && args.values !== "display" && args.values !== "raw") fail("values is \"display\" (what the person sees) or \"raw\" (formulas and unformatted numbers).");
  const values = args.values === "raw" ? "raw" : "display";
  const { text, range } = tabText(workbook, tab, { delimiter, values });
  try {
    await mkdir(dirname(resolved.absolute), { recursive: true });
    await atomicWrite(resolved.absolute, text);
  } catch (e) {
    throw writeRefusal(e, resolved) ?? e;
  }
  const bytes = Buffer.byteLength(text);
  return `Exported ${tab.name} of ${workbook.id} ${JSON.stringify(workbook.title)}${range ? ` (${range}, ${values === "raw" ? "raw values and formulas" : "the values the person sees"})` : " (empty)"} to ${resolved.display}, ${bytes < 1024 ? `${bytes} bytes` : kb(bytes)}. The sheet is unchanged at rev ${workbook.rev}.`;
}

export async function sheetDelete(args, env) {
  const workbook = await resolveSheet(env, args.sheet);
  await removeSheet(env, workbook.id);
  return `Deleted sheet ${workbook.id} ${JSON.stringify(workbook.title)} (${plural(workbook.tabs.length, "tab")}, ${plural(cellsOf(workbook), "cell")}).`;
}
