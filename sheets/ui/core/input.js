/* What typed text becomes in a cell, and what the editor shows for a cell, so the two round-trip. A
 * person typing "12%" or "$1,234.50" or "2026-10-08" gets a number with the format that shows it the
 * same way; a tool's JSON values go through the same door. Text that would be read as something else is
 * kept as text with a leading apostrophe when asked for (`literal`), the way Sheets keeps '0042. */
import { fromSerial, toSerial, validDate } from "./dates.js";
import { formatKind, plainNumber } from "./format.js";

const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?(?:[eE][+-]?\d+)?`;
const PLAIN_RE = new RegExp(`^([+-])?(${NUM})$`);
const PCT_RE = new RegExp(`^([+-])?(${NUM})\\s?%$`);
const CUR_RE = new RegExp(`^([+-])?\\$\\s?([+-])?(${NUM})$`);
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])[Mm])?$/;

const numberOf = (body) => {
  if (!/\d/.test(body.replace(/[eE][+-]?\d+$/, ""))) return null;
  const n = Number(body.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** The number a piece of text reads as, with the format it brings: `{ value, fmt? }`, or null when it is
 * not a number, percentage, currency amount, date, date-time or time. */
export function readNumber(text) {
  const t = String(text).trim();
  if (!t || t.length > 64) return null;
  let m = PLAIN_RE.exec(t);
  if (m) {
    const n = numberOf(m[2]);
    return n === null ? null : { value: m[1] === "-" ? -n : n };
  }
  m = PCT_RE.exec(t);
  if (m) {
    const n = numberOf(m[2]);
    if (n === null) return null;
    const dec = /\.(\d+)/.exec(m[2])?.[1].length ?? 0;
    return { value: Number(((m[1] === "-" ? -n : n) / 100).toPrecision(15)), fmt: dec ? `0.${"0".repeat(dec)}%` : "0%" };
  }
  m = CUR_RE.exec(t);
  if (m) {
    const n = numberOf(m[3]);
    if (n === null || (m[1] && m[2])) return null;
    return { value: m[1] === "-" || m[2] === "-" ? -n : n, fmt: "$#,##0.00" };
  }
  m = DATE_RE.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return null;
    if (m[4] === undefined) return { value: toSerial(y, mo, d), fmt: "yyyy-mm-dd" };
    const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
    if (h > 23 || mi > 59 || s > 59) return null;
    return { value: toSerial(y, mo, d, h, mi, s), fmt: m[6] === undefined ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd hh:mm:ss" };
  }
  m = TIME_RE.exec(t);
  if (m) {
    let h = Number(m[1]);
    const [mi, s] = [Number(m[2]), Number(m[3] ?? 0)];
    if (mi > 59 || s > 59) return null;
    if (m[4]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[4].toLowerCase() === "p" ? 12 : 0);
    } else if (h > 23) return null;
    const fmt = m[4] ? (m[3] === undefined ? "h:mm AM/PM" : "h:mm:ss AM/PM") : m[3] === undefined ? "hh:mm" : "hh:mm:ss";
    return { value: (h * 3600 + mi * 60 + s) / 86400, fmt };
  }
  return null;
}

const boolOf = (t) => {
  const l = t.trim().toLowerCase();
  return l === "true" ? true : l === "false" ? false : null;
};

/** What a typed or tool-given string becomes: `{ raw, fmt? }`. "" clears; "=…" is a formula; "'…" is text
 * as typed; numbers, percentages, currency, dates, times and TRUE/FALSE are read; anything else is text.
 * With `literal`, a string that would be read as anything but text is kept as text with a leading '. */
export function parseInput(text, { literal = false } = {}) {
  const t = text === null || text === undefined ? "" : String(text);
  if (t === "") return { raw: null };
  const special = t[0] === "=" || t[0] === "'";
  if (literal) return { raw: special || readNumber(t) || boolOf(t) !== null ? `'${t}` : t };
  if (special) return { raw: t };
  const n = readNumber(t);
  if (n) return n.fmt ? { raw: n.value, fmt: n.fmt } : { raw: n.value };
  const b = boolOf(t);
  if (b !== null) return { raw: b };
  return { raw: t };
}

/** What a JSON value from a tool becomes: numbers and booleans as they are, null clears, strings as typed. */
export function fromValue(v, { literal = false } = {}) {
  if (v === null || v === undefined) return { raw: null };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("A cell's number must be finite; write the text in quotes if you meant it as text.");
    return { raw: v };
  }
  if (typeof v === "boolean") return { raw: v };
  if (typeof v === "string") return parseInput(v, { literal });
  throw new Error("A cell value is a number, a string, a boolean or null; write objects and lists as text.");
}

const pad = (n) => String(n).padStart(2, "0");

/** A number as the editor shows it: no thousands separators, 15 significant digits, no exponent between 1e-6 and 1e15. */
export function plainEdit(n) {
  if (n === 0) return "0";
  const r = Number(n.toPrecision(15));
  const a = Math.abs(r);
  if (a >= 1e-6 && a < 1e15) return plainNumber(r);
  return r.toExponential().replace("e+", "E+").replace("e-", "E-");
}

/** What the formula bar and the in-cell editor show for a stored raw value and its style, in a form that
 * parseInput reads back to the same value. */
export function editText(raw, style) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
  if (typeof raw !== "number") return String(raw);
  const kind = formatKind(style?.fmt);
  if (kind === "percent") return `${plainEdit(Number((raw * 100).toPrecision(15)))}%`;
  if (kind === "date" || kind === "time" || kind === "datetime") {
    const p = fromSerial(raw);
    const secs = p.s ? `:${pad(p.s)}` : "";
    const time = `${pad(p.h)}:${pad(p.mi)}${secs}`;
    const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    const hasTime = p.h || p.mi || p.s;
    if (kind === "time" && raw >= 0 && raw < 1) return time;
    if (kind === "date" && !hasTime) return date;
    return `${date} ${time}`;
  }
  return plainEdit(raw);
}
