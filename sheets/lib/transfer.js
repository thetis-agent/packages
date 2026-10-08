// Values in and out of a sheet in bulk: a block of rows from a tool turned into cells (parsed the way a
// person's typing is, through `ui/core/input.js`), CSV or TSV text turned into a new tab, and a tab turned
// back into rows of text for a CSV or TSV file — the values the person sees, or the raw ones. Shared by the
// tools (sheet_create, sheet_write, sheet_import, sheet_export) and the page's import and export verbs, so a
// file reads the same whichever side brought it in.
import { addr, colName, MAX_COLS, MAX_ROWS } from "../ui/core/address.js";
import { parseDelimited, toDelimited } from "../ui/core/csv.js";
import { compute } from "../ui/core/engine.js";
import { formatValue } from "../ui/core/format.js";
import { fromValue } from "../ui/core/input.js";
import { isError } from "../ui/core/values.js";
import { applyOps, usedRange, validTabName } from "../ui/core/workbook.js";
import { fail } from "./store.js";

const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;

export const MAX_FILE = 16 * 1024 * 1024;

/** What a tool may give as a cell's value, refused by its address otherwise. */
export function checkValue(where, value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  fail(`${where}: a value is a number, a boolean, null or a string${typeof value === "number" ? " (a finite number)" : ""}.`);
}

/**
 * A block of rows from `{ row, col }` (0-based) as `{ cells, fmts, r2, c2, count }`: raws by address, the
 * formats a typed value brings (12% → 0%), the bottom-right corner reached, and how many values were
 * given. `skipEmpty` leaves out nulls and empty strings (an import) instead of clearing those cells (a write).
 */
export function blockCells(rows, { row = 0, col = 0, literal = false, skipEmpty = false } = {}) {
  if (!Array.isArray(rows)) fail("rows must be an array of rows, each an array of values.");
  const cells = {};
  const fmts = {};
  let r2 = row;
  let c2 = col;
  let count = 0;
  rows.forEach((line, i) => {
    if (!Array.isArray(line)) fail(`rows[${i}] must be an array of values.`);
    line.forEach((value, j) => {
      const r = row + i;
      const c = col + j;
      if (r >= MAX_ROWS || c >= MAX_COLS) fail(`The block reaches past ${addr(MAX_ROWS - 1, MAX_COLS - 1)}, the largest a tab can be (${MAX_ROWS.toLocaleString("en-US")} rows by ${MAX_COLS} columns, A..${colName(MAX_COLS - 1)}).`);
      const at = addr(r, c);
      checkValue(at, value);
      if (skipEmpty && (value === null || value === "")) return;
      const { raw, fmt } = fromValue(value, { literal });
      if (skipEmpty && (raw === null || raw === undefined)) return;
      cells[at] = raw ?? null;
      if (fmt && raw !== null && raw !== undefined) fmts[at] = fmt;
      r2 = Math.max(r2, r);
      c2 = Math.max(c2, c);
      count++;
    });
  });
  return { cells, fmts, r2, c2, count };
}

/** The extension's delimiter: tab for .tsv, comma for .csv, sniffed for .txt. */
export function delimiterOf(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  return ext === "tsv" ? "\t" : ext === "csv" ? "," : undefined;
}

/** A name a file gives a tab: the characters a tab name cannot hold replaced, at most 64, and not one the workbook has. */
export function tabNameFrom(workbook, wanted) {
  let base = String(wanted ?? "").replace(/\.(csv|tsv|txt)$/i, "").replace(/['![\]*?/\\:]/g, "_").trim().slice(0, 64).trim();
  if (!base || validTabName(base)) base = "Sheet1";
  const taken = new Set((workbook?.tabs ?? []).map((t) => t.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, 60)} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** CSV or TSV text as rows of values, refused when it would not fit in one tab. */
export function parseTable(text, { delimiter } = {}) {
  const rows = parseDelimited(String(text), delimiter ? { delimiter } : {});
  while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  if (!rows.length) fail("The file holds no rows.");
  const cols = Math.max(...rows.map((r) => r.length));
  if (rows.length > MAX_ROWS) fail(`The file has ${rows.length.toLocaleString("en-US")} rows; a tab holds at most ${MAX_ROWS.toLocaleString("en-US")}. Split it first.`);
  if (cols > MAX_COLS) fail(`The file has ${cols} columns; a tab holds at most ${MAX_COLS}. Split it first.`);
  return rows;
}

/**
 * The ops that make a new tab of `rows` in `workbook`: an addTab (unless `tab` is an existing empty tab to
 * fill, as a new sheet's first is), a resize when the data passes the default 1000 × 26, and one set.
 * Answers `{ workbook, tab, range, count }` with the ops applied.
 */
export function addTableTab(workbook, rows, { name, fill = null } = {}) {
  const block = blockCells(rows, { skipEmpty: true });
  const ops = [];
  let tabRef = fill;
  if (!fill) {
    if (workbook.tabs.some((t) => t.name.toLowerCase() === String(name).toLowerCase())) fail(`${JSON.stringify(workbook.title)} already has a tab named ${JSON.stringify(name)}; give another name.`);
    ops.push({ op: "addTab", name });
    tabRef = name;
  }
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  ops.push({ op: "resize", tab: tabRef, rows: Math.max(DEFAULT_ROWS, height), cols: Math.max(DEFAULT_COLS, width) });
  if (block.count) ops.push({ op: "set", tab: tabRef, cells: block.cells, fmts: block.fmts });
  const { workbook: next } = applyOps(workbook, ops);
  const tab = next.tabs.find((t) => t.name.toLowerCase() === String(fill ? workbook.tabs.find((x) => x.id === fill)?.name : name).toLowerCase());
  const range = `A1:${addr(height - 1, width - 1)}`;
  return { workbook: next, tab, range, count: block.count, rows: height, cols: width };
}

/** The text a cell shows: its computed value through its format, an error as its code. */
export function displayOf(computed, tab, at) {
  const value = computed.value(tab.id, at);
  if (value === null || value === undefined) return "";
  if (isError(value)) return value.err;
  return formatValue(value, tab.styles?.[at]?.fmt ?? null);
}

/** A raw as a CSV holds it: the formula or the text as stored, numbers plain, booleans TRUE/FALSE. */
const rawText = (raw) => (raw === undefined || raw === null ? "" : typeof raw === "boolean" ? (raw ? "TRUE" : "FALSE") : String(raw));

/** One tab as rows of text from A1 to the bottom-right of what it holds: `display` (what the person sees) or `raw`. */
export function tabRows(workbook, tab, { values = "display", computed = null } = {}) {
  const used = usedRange(tab);
  if (!used) return [];
  const engine = values === "raw" ? null : computed ?? compute(workbook);
  const rows = [];
  for (let r = 0; r <= used.r2; r++) {
    const line = [];
    for (let c = 0; c <= used.c2; c++) {
      const at = addr(r, c);
      line.push(engine ? displayOf(engine, tab, at) : rawText(tab.cells[at]));
    }
    rows.push(line);
  }
  return rows;
}

/** A tab as delimited text with `\r\n` line ends, and the range it covers. */
export function tabText(workbook, tab, { delimiter = ",", values = "display" } = {}) {
  const rows = tabRows(workbook, tab, { values });
  return { text: rows.length ? toDelimited(rows, delimiter) : "", range: rows.length ? `A1:${addr(rows.length - 1, rows[0].length - 1)}` : null, rows: rows.length };
}
