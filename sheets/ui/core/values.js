/* The values formulas compute with, and the coercions between them. A value is a number, a string, a
 * boolean, null (a blank cell) or an error value `{ err, msg? }`. The coercions follow Sheets and Excel:
 * a blank is 0, "" or FALSE as the operation needs; text that reads as a number ("12", "12%", "2026-10-08")
 * is that number in arithmetic; other text in arithmetic is #VALUE!. Comparisons order numbers before text
 * before booleans and compare text without case. */
import { readNumber } from "./input.js";
import { plainNumber } from "./format.js";

export const ERROR_CODES = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#ERROR!", "#CYCLE!", "#NULL!"];

/** An error value with its code and, optionally, a sentence saying why. */
export const error = (code, msg) => (msg ? { err: code, msg } : { err: code });

/** Whether a value is an error value. */
export const isError = (v) => v !== null && typeof v === "object" && typeof v.err === "string";

/** The value of a stored raw that is not a formula: the leading ' of text dropped, absent as null. */
export function rawValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw[0] === "'") return raw.slice(1);
  return raw;
}

/** A number as text in a formula ("x" & 1/3): up to 15 significant digits, no exponent in the usual range. */
export function numberText(n) {
  if (n === 0) return "0";
  const r = Number(n.toPrecision(15));
  const a = Math.abs(r);
  if (a >= 1e-9 && a < 1e21) return plainNumber(r);
  return String(r).replace("e+", "E+").replace("e-", "E-");
}

/** The number a value stands for in arithmetic, or an error value. */
export function toNumber(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (v.trim() === "") return v === "" ? 0 : error("#VALUE!", `"${v}" is not a number.`);
    const n = readNumber(v);
    return n ? n.value : error("#VALUE!", `"${v.length > 40 ? v.slice(0, 40) + "…" : v}" is not a number.`);
  }
  if (isError(v)) return v;
  return error("#VALUE!", "This value is not a number.");
}

/** The text a value stands for in a formula, or an error value. */
export function toText(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return numberText(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v)) return v;
  return "";
}

/** The truth a value stands for, or an error value: numbers are true when not 0, "TRUE"/"FALSE" text reads as such. */
export function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const l = v.trim().toLowerCase();
    if (l === "true") return true;
    if (l === "false" || v === "") return false;
    return error("#VALUE!", `"${v.length > 40 ? v.slice(0, 40) + "…" : v}" is not TRUE or FALSE.`);
  }
  if (isError(v)) return v;
  return error("#VALUE!", "This value is not TRUE or FALSE.");
}

const rank = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3);

/** Compares two non-error values as a spreadsheet's < and = do: −1, 0 or 1. A blank compares as the other
 * side's empty value; numbers come before text, text before booleans; text ignores case. */
export function compareValues(a, b) {
  if (a === null || a === undefined) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null || b === undefined) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 0) {
    if (a === b) return 0;
    if (Math.abs(a - b) > 1e-13 * Math.max(Math.abs(a), Math.abs(b))) return a < b ? -1 : 1;
    const x = Number(a.toPrecision(15));
    const y = Number(b.toPrecision(15));
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ra === 1) {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ra === 0 || ra === 2) return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

/** A reference to a block of cells, as formulas pass it to functions: its size, positional reads relative
 * to its top-left, and a walk over its non-empty cells row by row. `src` is the engine that knows the cells. */
export class Range {
  constructor(src, td, r1, c1, r2, c2) {
    this.src = src;
    this.td = td;
    this.r1 = r1;
    this.c1 = c1;
    this.r2 = r2;
    this.c2 = c2;
  }
  get rows() {
    return this.r2 - this.r1 + 1;
  }
  get cols() {
    return this.c2 - this.c1 + 1;
  }
  get tabId() {
    return this.td.id;
  }
  /** The value at row i, column j of the block (0-based, relative). */
  get(i, j) {
    return this.src.cellValue(this.td, this.r1 + i, this.c1 + j);
  }
  /** Calls fn(value, i, j) for every non-empty cell, row by row; fn returning false stops the walk. */
  each(fn) {
    this.src.eachIn(this.td, this.r1, this.c1, this.r2, this.c2, (v, r, c) => fn(v, r - this.r1, c - this.c1));
  }
  /** The sum and count of the numbers in the block and its first error: `{ sum, count, err }`. */
  sums() {
    return this.src.sumIn(this.td, this.r1, this.c1, this.r2, this.c2);
  }
  /** How many rows and columns from the top-left can hold anything: the block cut at the tab's last used cell. */
  get scanRows() {
    return Math.max(0, Math.min(this.rows, this.td.maxRow - this.r1 + 1));
  }
  get scanCols() {
    return Math.max(0, Math.min(this.cols, this.td.maxCol - this.c1 + 1));
  }
  /** The block from (i1, j1) to (i2, j2), relative to this one's top-left. */
  sub(i1, j1, i2, j2) {
    return new Range(this.src, this.td, this.r1 + i1, this.c1 + j1, this.r1 + i2, this.c1 + j2);
  }
  /** A block with the same top-left and the given size. */
  resize(rows, cols) {
    return new Range(this.src, this.td, this.r1, this.c1, this.r1 + rows - 1, this.c1 + cols - 1);
  }
}

/** Whether a value is a reference to cells rather than a value. */
export const isRange = (v) => v instanceof Range;

/** One value from what an expression gave: a one-cell reference's value; for a taller or wider reference,
 * the cell in the formula's own row or column (implicit intersection), else #VALUE!. */
export function scalarOf(v, at) {
  if (!(v instanceof Range)) return v === undefined ? null : v;
  if (v.r1 === v.r2 && v.c1 === v.c2) return v.get(0, 0);
  if (at && v.td.id === at.tabId) {
    if (v.c1 === v.c2 && at.row >= v.r1 && at.row <= v.r2) return v.get(at.row - v.r1, 0);
    if (v.r1 === v.r2 && at.col >= v.c1 && at.col <= v.c2) return v.get(0, at.col - v.c1);
  }
  return error("#VALUE!", "A range was given where one value goes; wrap it in a function like SUM or INDEX.");
}
