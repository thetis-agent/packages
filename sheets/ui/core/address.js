/* A1 addresses and ranges, the one notation the tools, the page and the formulas share. Rows and columns
 * are 0-based inside the code and 1-based and lettered on screen: `addr(2, 1)` is "B3". A range is
 * `{ r1, c1, r2, c2 }`, inclusive and normalized so r1 <= r2 and c1 <= c2. A tab name that is not a plain
 * word is quoted in references, with a quote inside doubled, as Sheets and Excel write it. */

export const MAX_ROWS = 20000;
export const MAX_COLS = 702;

const COL_RE = /^[A-Za-z]{1,3}$/;
const CELL_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;
const ROW_RE = /^\$?([0-9]{1,7})$/;
const COLONLY_RE = /^\$?([A-Za-z]{1,3})$/;

/** The letters of a 0-based column index: 0 → "A", 25 → "Z", 26 → "AA". */
export function colName(i) {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1 - r) / 26;
  }
  return s;
}

/** The 0-based index of column letters ("AA" → 26), or −1 when the text is not one to three letters. */
export function colIndex(text) {
  if (typeof text !== "string" || !COL_RE.test(text)) return -1;
  let n = 0;
  for (let i = 0; i < text.length; i++) n = n * 26 + ((text.charCodeAt(i) | 32) - 96);
  return n - 1;
}

const NAMES = [];
for (let i = 0; i < MAX_COLS; i++) NAMES.push(colName(i));

/** "B3" for row 2, column 1 (0-based in). */
export const addr = (row, col) => (col < MAX_COLS ? NAMES[col] : colName(col)) + (row + 1);

const parsed = new Map();

/** `{ row, col }` (0-based) of an address like "B3", "b3" or "$B$3", or null when it is not one on the grid. */
export function parseAddr(text) {
  if (typeof text !== "string") return null;
  const hit = parsed.get(text);
  if (hit !== undefined) return hit;
  const m = CELL_RE.exec(text);
  let out = null;
  if (m) {
    const col = colIndex(m[1]);
    const row = Number(m[2]) - 1;
    if (col >= 0 && col < MAX_COLS && row >= 0 && row < MAX_ROWS) out = Object.freeze({ row, col });
  }
  if (parsed.size > 300000) parsed.clear();
  parsed.set(text, out);
  return out;
}

const norm = (r1, c1, r2, c2) => ({ r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) });

/** A range from "A1", "A1:C3", "C3:A1", "B:B", "B:D", "3:3" or "3:10" (0-based, inclusive, normalized), or
 * null. Whole columns and rows reach to `rows`/`cols` when given, else to the grid's limits. */
export function parseRange(text, { rows = MAX_ROWS, cols = MAX_COLS } = {}) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length === 1) {
    const a = parseAddr(parts[0]);
    return a ? { r1: a.row, c1: a.col, r2: a.row, c2: a.col } : null;
  }
  if (parts.length !== 2) return null;
  const [x, y] = parts;
  const a = parseAddr(x);
  const b = parseAddr(y);
  if (a && b) return norm(a.row, a.col, b.row, b.col);
  const ca = COLONLY_RE.exec(x);
  const cb = COLONLY_RE.exec(y);
  if (ca && cb) {
    const i = colIndex(ca[1]);
    const j = colIndex(cb[1]);
    if (i < 0 || j < 0 || i >= MAX_COLS || j >= MAX_COLS) return null;
    return norm(0, i, Math.max(0, Math.min(rows, MAX_ROWS) - 1), j);
  }
  const ra = ROW_RE.exec(x);
  const rb = ROW_RE.exec(y);
  if (ra && rb) {
    const i = Number(ra[1]) - 1;
    const j = Number(rb[1]) - 1;
    if (i < 0 || j < 0 || i >= MAX_ROWS || j >= MAX_ROWS) return null;
    return norm(i, 0, j, Math.max(0, Math.min(cols, MAX_COLS) - 1));
  }
  return null;
}

/** "A1:C3" for a range, "A1" for one cell. */
export const rangeText = ({ r1, c1, r2, c2 }) => (r1 === r2 && c1 === c2 ? addr(r1, c1) : `${addr(r1, c1)}:${addr(r2, c2)}`);

/** Splits "'My tab'!A1:B2" or "Data!B:B" into `{ tab, range }`; `tab` is null when the text names none. */
export function parseQualified(text) {
  const t = String(text ?? "").trim();
  if (t.startsWith("'")) {
    let i = 1;
    let name = "";
    while (i < t.length) {
      if (t[i] === "'") {
        if (t[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += t[i++];
    }
    if (t[i] === "'" && t[i + 1] === "!") return { tab: name, range: t.slice(i + 2) };
    return { tab: null, range: t };
  }
  const bang = t.lastIndexOf("!");
  if (bang > 0) return { tab: t.slice(0, bang), range: t.slice(bang + 1) };
  return { tab: null, range: t };
}

const BARE = /^[A-Za-z_\u00C0-\uFFFF][A-Za-z0-9_.\u00C0-\uFFFF]*$/;
const LOOKS_LIKE_REF = /^(\$?[A-Za-z]{1,3}\$?[0-9]+|[Rr][0-9]*[Cc][0-9]*|true|false)$/i;

/** The tab name as a reference writes it: bare when it is a plain word, else in quotes with ' doubled. */
export function quoteTab(name) {
  const s = String(name);
  if (BARE.test(s) && !LOOKS_LIKE_REF.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** Calls fn(row, col) for every cell of the range, row by row. */
export function eachCell(range, fn) {
  for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) fn(r, c);
}

/** How many cells the range covers. */
export const area = (range) => (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);

/** The smallest range holding every range given, or null for none. */
export function boundingBox(ranges) {
  let out = null;
  for (const g of ranges) {
    if (!g) continue;
    if (!out) out = { r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c2 };
    else {
      if (g.r1 < out.r1) out.r1 = g.r1;
      if (g.c1 < out.c1) out.c1 = g.c1;
      if (g.r2 > out.r2) out.r2 = g.r2;
      if (g.c2 > out.c2) out.c2 = g.c2;
    }
  }
  return out;
}
