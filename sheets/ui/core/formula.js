/* Formulas as text: the tokenizer, the parser that turns one into a tree for the engine, and the
 * rewriters that move its references when cells are filled, sorted, inserted, deleted or a tab is
 * renamed or removed. A reference is one token (`A1`, `$B$2`, `A1:C9`, `B:B`, `3:5`, `Data!A1`,
 * `'My tab'!A1:B2`), so a rewriter replaces those tokens' text and keeps every other character of the
 * formula byte for byte. Precedence is Excel's: range `:`, unary minus, `%`, `^` (left to right, so
 * -2^2 is 4), `*` `/`, `+` `-`, `&`, comparisons. Formulas are given with or without their `=`. */
import { colName, MAX_COLS, MAX_ROWS, quoteTab } from "./address.js";

const TAB = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_\u00C0-\uFFFF][A-Za-z0-9_.\u00C0-\uFFFF]*))!`;
const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)`;
const REF_RE = new RegExp(
  String.raw`(?:${TAB})?(?:${CELL}(?::${CELL})?|(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})|(\$?)([0-9]+):(\$?)([0-9]+))(?![A-Za-z0-9_.(!\u00C0-\uFFFF])`,
  "y",
);
const NUM_RE = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const ERR_RE = /#(?:DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!|ERROR!|CYCLE!)/iy;
const IDENT_RE = /[A-Za-z_\u00C0-\uFFFF][A-Za-z0-9_.\u00C0-\uFFFF]*/y;
const WS_RE = /[\s\u00A0]+/y;

const letters = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + ((s.charCodeAt(i) | 32) - 96);
  return n - 1;
};

function refToken(m, start, end, text) {
  const tab = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2] : null;
  const tabLen = m[1] !== undefined ? m[1].length + 3 : m[2] !== undefined ? m[2].length + 1 : 0;
  let kind;
  let a;
  let b = null;
  if (m[4] !== undefined) {
    a = { colAbs: m[3] === "$", col: letters(m[4]), rowAbs: m[5] === "$", row: Number(m[6]) - 1 };
    if (m[8] !== undefined) b = { colAbs: m[7] === "$", col: letters(m[8]), rowAbs: m[9] === "$", row: Number(m[10]) - 1 };
    kind = b ? "area" : "cell";
  } else if (m[12] !== undefined) {
    kind = "cols";
    a = { colAbs: m[11] === "$", col: letters(m[12]), rowAbs: false, row: null };
    b = { colAbs: m[13] === "$", col: letters(m[14]), rowAbs: false, row: null };
  } else {
    kind = "rows";
    a = { colAbs: false, col: null, rowAbs: m[15] === "$", row: Number(m[16]) - 1 };
    b = { colAbs: false, col: null, rowAbs: m[17] === "$", row: Number(m[18]) - 1 };
  }
  return { type: "ref", start, end, text, tab, prefixEnd: start + tabLen, kind, a, b };
}

const tokenCache = new Map();

/** The tokens of a formula (without its `=`): `{ type, start, end, … }` with type num, str, bool, err, ref,
 * func, name, op, (, ), or `,`. Throws a SyntaxError on a character it cannot read, unless `tolerant`, which
 * answers the tokens up to it. */
export function tokenize(src, { tolerant = false } = {}) {
  const key = (tolerant ? "t" : "s") + src;
  const hit = tokenCache.get(key);
  if (hit) {
    if (hit.error) throw hit.error;
    return hit;
  }
  const out = [];
  let i = 0;
  let failure = null;
  const n = src.length;
  while (i < n) {
    WS_RE.lastIndex = i;
    if (WS_RE.test(src)) {
      i = WS_RE.lastIndex;
      continue;
    }
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= n) {
          failure = new SyntaxError("A text in quotes is not closed.");
          break;
        }
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      if (failure) break;
      out.push({ type: "str", value: s, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    REF_RE.lastIndex = i;
    let m = REF_RE.exec(src);
    if (m) {
      out.push(refToken(m, i, REF_RE.lastIndex, m[0]));
      i = REF_RE.lastIndex;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      NUM_RE.lastIndex = i;
      m = NUM_RE.exec(src);
      if (m) {
        out.push({ type: "num", value: Number(m[0]), start: i, end: NUM_RE.lastIndex });
        i = NUM_RE.lastIndex;
        continue;
      }
    }
    if (ch === "#") {
      ERR_RE.lastIndex = i;
      m = ERR_RE.exec(src);
      if (m) {
        out.push({ type: "err", value: m[0].toUpperCase(), start: i, end: ERR_RE.lastIndex });
        i = ERR_RE.lastIndex;
        continue;
      }
    }
    IDENT_RE.lastIndex = i;
    m = IDENT_RE.exec(src);
    if (m) {
      const end = IDENT_RE.lastIndex;
      const word = m[0];
      const upper = word.toUpperCase();
      if (src[end] === "(") out.push({ type: "func", name: upper, start: i, end });
      else if (upper === "TRUE" || upper === "FALSE") out.push({ type: "bool", value: upper === "TRUE", start: i, end });
      else out.push({ type: "name", name: word, start: i, end });
      i = end;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      out.push({ type: "op", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%:".includes(ch)) {
      out.push({ type: "op", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      out.push({ type: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    failure = new SyntaxError(`Unexpected "${ch}" in the formula.`);
    break;
  }
  const result = failure && !tolerant ? { error: failure } : out;
  if (tokenCache.size > 50000) tokenCache.clear();
  tokenCache.set(key, result);
  if (result.error) throw result.error;
  return out;
}

const PREC = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

function refNode(tok) {
  const { a, b, kind } = tok;
  const bad = (p) => (p.col !== null && (p.col < 0 || p.col >= MAX_COLS)) || (p.row !== null && (p.row < 0 || p.row >= MAX_ROWS));
  const node = { t: "ref", tab: tok.tab, kind, bad: bad(a) || (b !== null && bad(b)) };
  if (kind === "cell") Object.assign(node, { r1: a.row, c1: a.col, r2: a.row, c2: a.col });
  else if (kind === "area") Object.assign(node, { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) });
  else if (kind === "cols") Object.assign(node, { r1: 0, c1: Math.min(a.col, b.col), r2: MAX_ROWS - 1, c2: Math.max(a.col, b.col) });
  else Object.assign(node, { r1: Math.min(a.row, b.row), c1: 0, r2: Math.max(a.row, b.row), c2: MAX_COLS - 1 });
  return node;
}

/** The tree of a formula (without its `=`). Throws a SyntaxError with a short sentence when it does not parse. */
export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (tok, ...ops) => tok && tok.type === "op" && ops.includes(tok.value);
  const fail = (msg) => {
    throw new SyntaxError(msg);
  };
  const where = (tok) => (tok ? `"${src.slice(tok.start, tok.end)}"` : "the end");

  function binary(minPrec) {
    let left = postfix();
    for (;;) {
      const tok = peek();
      if (!tok || tok.type !== "op") break;
      const prec = PREC[tok.value];
      if (prec === undefined || prec < minPrec) break;
      p++;
      const right = binary(prec + 1);
      left = { t: "bin", op: tok.value, a: left, b: right };
    }
    return left;
  }

  function postfix() {
    let node = unary();
    while (isOp(peek(), "%")) {
      p++;
      node = { t: "pct", a: node };
    }
    return node;
  }

  function unary() {
    const tok = peek();
    if (isOp(tok, "-", "+")) {
      p++;
      if (++depth > 200) fail("The formula is nested too deeply.");
      const a = unary();
      depth--;
      return { t: tok.value === "-" ? "neg" : "pos", a };
    }
    return range();
  }

  function range() {
    let node = primary();
    while (isOp(peek(), ":")) {
      p++;
      node = { t: "range", a: node, b: primary() };
    }
    return node;
  }

  function primary() {
    const tok = peek();
    if (!tok) fail("The formula ends too early.");
    p++;
    switch (tok.type) {
      case "num":
        return { t: "num", v: tok.value };
      case "str":
        return { t: "str", v: tok.value };
      case "bool":
        return { t: "bool", v: tok.value };
      case "err":
        return { t: "err", v: tok.value };
      case "ref":
        return refNode(tok);
      case "name":
        return { t: "name", name: tok.name };
      case "(": {
        if (++depth > 200) fail("The formula is nested too deeply.");
        const inner = binary(1);
        depth--;
        if (peek()?.type !== ")") fail(`Expected ")" before ${where(peek())}.`);
        p++;
        return inner;
      }
      case "func": {
        if (++depth > 200) fail("The formula is nested too deeply.");
        p++;
        const args = [];
        if (peek()?.type === ")") p++;
        else {
          for (;;) {
            const t = peek();
            if (!t) fail(`${tok.name}( is not closed.`);
            if (t.type === "," || t.type === ")") args.push({ t: "empty" });
            else args.push(binary(1));
            const sep = peek();
            if (sep?.type === ",") {
              p++;
              continue;
            }
            if (sep?.type === ")") {
              p++;
              break;
            }
            fail(sep ? `Expected "," or ")" before ${where(sep)}.` : `${tok.name}( is not closed.`);
          }
        }
        depth--;
        return { t: "fn", name: tok.name, args };
      }
      default:
        p--;
        return fail(`Unexpected ${where(tok)}.`);
    }
  }

  if (!toks.length) fail("The formula is empty.");
  const ast = binary(1);
  if (p < toks.length) fail(`Unexpected ${where(toks[p])}.`);
  return ast;
}

const astCache = new Map();

/** The parsed tree of a formula text (with or without `=`), cached by the text: `{ ast }` or `{ error }`. */
export function parseCached(formula) {
  let hit = astCache.get(formula);
  if (hit) return hit;
  try {
    hit = { ast: parse(formula[0] === "=" ? formula.slice(1) : formula) };
  } catch (e) {
    hit = { error: e.message || "The formula does not parse." };
  }
  if (astCache.size > 100000) astCache.clear();
  astCache.set(formula, hit);
  return hit;
}

function bodyOf(formula) {
  const s = String(formula);
  return s[0] === "=" ? { lead: "=", src: s.slice(1) } : { lead: "", src: s };
}

const rangeOfToken = (t) => {
  const n = refNode(t);
  return { r1: n.r1, c1: n.c1, r2: n.r2, c2: n.c2 };
};

/** The references in a formula, for highlighting while editing: `[{ tab, range, text, start, end }]`, with
 * offsets into the formula string as given (counting its `=`). A formula still being typed is read as far
 * as it goes. */
export function refsOf(formula) {
  const { lead, src } = bodyOf(formula);
  const out = [];
  for (const t of tokenize(src, { tolerant: true })) {
    if (t.type !== "ref") continue;
    out.push({ tab: t.tab, range: rangeOfToken(t), text: t.text, start: t.start + lead.length, end: t.end + lead.length });
  }
  return out;
}

const part = (p) => (p.col !== null ? (p.colAbs ? "$" : "") + colName(p.col) : "") + (p.row !== null ? (p.rowAbs ? "$" : "") + (p.row + 1) : "");

/** The text of a reference token after its parts changed, keeping its tab prefix as written. */
function refText(src, tok, a, b) {
  return src.slice(tok.start, tok.prefixEnd) + part(a) + (b ? ":" + part(b) : "");
}

/** Rewrites each reference token through fn(token, src) → new text, or null to keep it. */
function rewrite(formula, fn) {
  const { lead, src } = bodyOf(formula);
  if (!src.length) return formula;
  const toks = tokenize(src, { tolerant: true });
  let out = "";
  let at = 0;
  let changed = false;
  for (const t of toks) {
    if (t.type !== "ref") continue;
    const next = fn(t, src);
    if (next === null || next === undefined || next === t.text) continue;
    out += src.slice(at, t.start) + next;
    at = t.end;
    changed = true;
  }
  return changed ? lead + out + src.slice(at) : formula;
}

const offGrid = (p) => (p.col !== null && (p.col < 0 || p.col >= MAX_COLS)) || (p.row !== null && (p.row < 0 || p.row >= MAX_ROWS));

/** The formula with the relative parts of its references moved by dRow rows and dCol columns, as a fill or
 * a paste moves them; a reference pushed off the grid becomes #REF!. */
export function translate(formula, dRow, dCol) {
  if (!dRow && !dCol) return formula;
  return rewrite(formula, (t, src) => {
    const move = (p) =>
      p && {
        ...p,
        col: p.col !== null && !p.colAbs ? p.col + dCol : p.col,
        row: p.row !== null && !p.rowAbs ? p.row + dRow : p.row,
      };
    const a = move(t.a);
    const b = move(t.b);
    if (offGrid(a) || (b && offGrid(b))) return "#REF!";
    if (a.col === t.a.col && a.row === t.a.row && (!b || (b.col === t.b.col && b.row === t.b.row))) return null;
    return refText(src, t, a, b);
  });
}

const sameTab = (a, b) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** The formula after `count` rows or columns were inserted (count > 0) or deleted (count < 0) at index `at`
 * (0-based) of the tab named `tab`; unqualified references belong to `ownTab`. References past the change
 * move, a range spanning it grows or shrinks, a reference wholly inside deleted lines becomes #REF!. */
export function shiftRefs(formula, { ownTab, tab, axis, at, count }) {
  if (!count) return formula;
  const key = axis === "col" ? "col" : "row";
  const max = key === "col" ? MAX_COLS : MAX_ROWS;
  const n = -count;
  return rewrite(formula, (t, src) => {
    if (!sameTab(t.tab ?? ownTab, tab)) return null;
    if (t.a[key] === null) return null;
    const a = { ...t.a };
    const b = t.b && { ...t.b };
    if (!b || t.kind === "cell") {
      const v = a[key];
      if (count > 0) {
        if (v < at) return null;
        a[key] = v + count;
      } else {
        if (v < at) return null;
        if (v < at + n) return "#REF!";
        a[key] = v - n;
      }
    } else {
      const loIsA = a[key] <= b[key];
      const lo = loIsA ? a : b;
      const hi = loIsA ? b : a;
      const l = lo[key];
      const h = hi[key];
      if (count > 0) {
        if (l >= at) lo[key] = l + count;
        if (h >= at) hi[key] = h + count;
      } else {
        if (l >= at && h < at + n) return "#REF!";
        lo[key] = l < at ? l : l >= at + n ? l - n : at;
        hi[key] = h < at ? h : h >= at + n ? h - n : at - 1;
      }
    }
    if (a[key] >= max || (b && b[key] >= max)) return "#REF!";
    if (a[key] === t.a[key] && (!b || b[key] === t.b[key])) return null;
    return refText(src, t, a, b);
  });
}

/** The formula with references into the tab `oldName` pointing at `newName` instead. */
export function renameTabRefs(formula, oldName, newName) {
  return rewrite(formula, (t, src) => (t.tab !== null && sameTab(t.tab, oldName) ? quoteTab(newName) + "!" + src.slice(t.prefixEnd, t.end) : null));
}

/** The formula with every reference into the tab `name` (being deleted) turned into #REF!. */
export function dropTabRefs(formula, name) {
  return rewrite(formula, (t) => (t.tab !== null && sameTab(t.tab, name) ? "#REF!" : null));
}

/** Whether a raw cell value is a formula. */
export const isFormula = (raw) => typeof raw === "string" && raw[0] === "=";
