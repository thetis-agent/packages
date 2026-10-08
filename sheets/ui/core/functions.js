/* The spreadsheet functions formulas call, by upper-case name: `{ fn, min, max, help, takes?, errors? }`.
 * How a function receives its arguments is its `takes`: "values" (the default) gives each one as a single
 * value, a reference read as its cell; "refs" gives references as Range objects so the function can walk
 * them; "lazy" gives thunks, for IF and the like that must not evaluate the branch not taken. An error
 * among the arguments is the answer unless the function says `errors: true` (ISERROR, COUNT...). The
 * behaviour follows Sheets and Excel: criteria like ">5" and "a*", approximate VLOOKUP on sorted data,
 * MATCH's three types, XLOOKUP's defaults, date serials from 1899-12-30, the PMT family's signs. */
import { daysInMonth, fromSerial, nowSerial, toSerial, todaySerial } from "./dates.js";
import { compileFormat, formatValue } from "./format.js";
import { readNumber } from "./input.js";
import { compareValues, error, isError, isRange, scalarOf, toBool, toNumber, toText } from "./values.js";

const NA = (msg) => error("#N/A", msg);
const VALUE = (msg) => error("#VALUE!", msg);
const NUM = (msg) => error("#NUM!", msg);
const DIV0 = () => error("#DIV/0!", "Division by zero.");

/* ---------- helpers ---------- */

/** Wraps fn so it receives numbers: each given argument through toNumber, a missing one undefined. */
const numeric = (fn) => (args, ctx) => {
  const ns = [];
  for (const a of args) {
    if (a === undefined) {
      ns.push(undefined);
      continue;
    }
    const n = toNumber(a);
    if (isError(n)) return n;
    ns.push(n);
  }
  return fn(ns, ctx);
};

const intOf = (n) => Math.trunc(n);
const opt = (v, d) => (v === undefined || v === null ? d : v);

/** The numbers among the arguments, in order: numbers in references (text, booleans and blanks there are
 * skipped, errors are the answer), and direct values coerced (text that is not a number is #VALUE!). */
function numbersOf(args, ctx, { direct = true } = {}) {
  const out = [];
  for (const a of args) {
    if (isRange(a)) {
      let err = null;
      a.each((v) => {
        if (typeof v === "number") out.push(v);
        else if (isError(v)) {
          err = v;
          return false;
        }
      });
      if (err) return err;
    } else if (isError(a)) return a;
    else if (a === undefined) continue;
    else if (!direct) {
      if (typeof a === "number") out.push(a);
    } else {
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

const sum = (xs) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

function roundHalfAway(x, d) {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (d >= 0) {
    const m = 10 ** d;
    return (sign * Math.round(Number((a * m).toPrecision(15)))) / m;
  }
  const m = 10 ** -d;
  return sign * Math.round(Number((a / m).toPrecision(15))) * m;
}

function roundWith(x, d, how) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const f = how === "up" ? Math.ceil : Math.floor;
  if (d >= 0) {
    const m = 10 ** d;
    return (sign * f(Number((a * m).toPrecision(15)))) / m;
  }
  const m = 10 ** -d;
  return sign * f(Number((a / m).toPrecision(15))) * m;
}

const wildcardCache = new Map();

/** A case-insensitive matcher for a pattern with * and ? wildcards (~ escapes), anchored unless `find`. */
function wildcard(pattern, find = false) {
  const key = (find ? "f" : "a") + pattern;
  let re = wildcardCache.get(key);
  if (re) return re;
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length && "*?~".includes(pattern[i + 1])) {
      src += "\\" + pattern[++i];
    } else if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  re = new RegExp(find ? src : `^${src}$`, "i");
  if (wildcardCache.size > 2000) wildcardCache.clear();
  wildcardCache.set(key, re);
  return re;
}

const hasWild = (s) => /[*?]/.test(s);

const isBlank = (v) => v === null || v === undefined || v === "";

/** A predicate for a criterion as COUNTIF reads it: a value, or text with an operator (">5", "<>x", "=",
 * "a*"). */
export function criterion(c) {
  if (c === null || c === undefined) return isBlank;
  if (typeof c === "number") return (v) => (typeof v === "number" ? compareValues(v, c) === 0 : typeof v === "string" && v.trim() !== "" && readNumber(v)?.value === c);
  if (typeof c === "boolean") return (v) => v === c;
  if (isError(c)) return (v) => isError(v) && v.err === c.err;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(String(c));
  const op = m[1] || "=";
  const operand = m[2];
  if (operand === "") {
    if (op === "=") return isBlank;
    if (op === "<>") return (v) => !isBlank(v);
  }
  const n = readNumber(operand);
  if (n) {
    const x = n.value;
    const eq = (v) => (typeof v === "number" ? compareValues(v, x) === 0 : op === "=" && typeof v === "string" && v.trim() !== "" && readNumber(v)?.value === x);
    switch (op) {
      case "=":
        return eq;
      case "<>":
        return (v) => !eq(v);
      default:
        return (v) => {
          if (typeof v !== "number") return false;
          const k = compareValues(v, x);
          return op === "<" ? k < 0 : op === ">" ? k > 0 : op === "<=" ? k <= 0 : k >= 0;
        };
    }
  }
  const up = operand.toUpperCase();
  if (up === "TRUE" || up === "FALSE") {
    const b = up === "TRUE";
    if (op === "=") return (v) => v === b;
    if (op === "<>") return (v) => v !== b;
  }
  if (/^#(DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!|ERROR!|CYCLE!)$/.test(up)) {
    if (op === "=") return (v) => isError(v) && v.err === up;
    if (op === "<>") return (v) => !(isError(v) && v.err === up);
  }
  if (op === "=" || op === "<>") {
    let test;
    if (hasWild(operand)) {
      const re = wildcard(operand);
      test = (v) => typeof v === "string" && re.test(v);
    } else {
      const low = operand.replace(/~([*?~])/g, "$1").toLowerCase();
      test = (v) => typeof v === "string" && v.toLowerCase() === low;
    }
    return op === "=" ? test : (v) => !test(v);
  }
  const low = operand.toLowerCase();
  return (v) => {
    if (typeof v !== "string") return false;
    const x = v.toLowerCase();
    return op === "<" ? x < low : op === ">" ? x > low : op === "<=" ? x <= low : x >= low;
  };
}

/** Walks the positions where every [range, predicate] pair matches, calling hit(i, j); answers the number of
 * matches, counting blank positions beyond the used cells when every predicate takes a blank. */
function matching(pairs, hit) {
  const [first] = pairs;
  const R = first.range.rows;
  const C = first.range.cols;
  for (const p of pairs) if (p.range.rows !== R || p.range.cols !== C) return VALUE("The ranges must be the same size.");
  let count = 0;
  const rest = pairs.slice(1);
  const restOk = (i, j) => {
    for (const p of rest) if (!p.pred(p.range.get(i, j))) return false;
    return true;
  };
  if (!first.pred(null)) {
    first.range.each((v, i, j) => {
      if (first.pred(v) && restOk(i, j)) {
        count++;
        if (hit) hit(i, j);
      }
    });
    return count;
  }
  let sr = 0;
  let sc = 0;
  for (const p of pairs) {
    sr = Math.max(sr, p.range.scanRows);
    sc = Math.max(sc, p.range.scanCols);
  }
  for (let i = 0; i < sr; i++)
    for (let j = 0; j < sc; j++) {
      if (first.pred(first.range.get(i, j)) && restOk(i, j)) {
        count++;
        if (hit) hit(i, j);
      }
    }
  if (pairs.every((p) => p.pred(null))) count += R * C - sr * sc;
  return count;
}

const needRange = (v, name) => (isRange(v) ? null : VALUE(`${name} needs a range of cells here.`));

function pairsOf(args, from, ctx) {
  const pairs = [];
  for (let k = from; k + 1 < args.length; k += 2) {
    const r = args[k];
    if (!isRange(r)) return VALUE("A criteria range must be a range of cells.");
    const c = scalarOf(args[k + 1], ctx);
    if (isError(c)) return c;
    pairs.push({ range: r, pred: criterion(c) });
  }
  return pairs;
}

function sumAt(range, positions) {
  let s = 0;
  for (const [i, j] of positions) {
    const v = range.get(i, j);
    if (typeof v === "number") s += v;
    else if (isError(v)) return v;
  }
  return s;
}

function countAvg(range, positions, avg) {
  let s = 0;
  let n = 0;
  for (const [i, j] of positions) {
    const v = range.get(i, j);
    if (typeof v === "number") {
      s += v;
      n++;
    } else if (isError(v)) return v;
  }
  if (!avg) return s;
  return n ? s / n : DIV0();
}

function ifsFamily(args, ctx, { valueRange, from, avg, count }) {
  const pairs = pairsOf(args, from, ctx);
  if (isError(pairs)) return pairs;
  const positions = [];
  const n = matching(pairs, count ? null : (i, j) => positions.push([i, j]));
  if (isError(n)) return n;
  if (count) return n;
  let vr = valueRange;
  if (!isRange(vr)) return VALUE("The range to add up must be a range of cells.");
  if (vr.rows !== pairs[0].range.rows || vr.cols !== pairs[0].range.cols) {
    if (from === 1) return VALUE("The ranges must be the same size.");
    vr = vr.resize(pairs[0].range.rows, pairs[0].range.cols);
  }
  return countAvg(vr, positions, avg);
}

/** Whether a lookup value equals the key: text without case (wildcards when the key has them), numbers, booleans. */
function lookupEq(v, key, wild) {
  if (typeof key === "string") {
    if (typeof v !== "string") return false;
    return wild ? wild.test(v) : v.toLowerCase() === key.toLowerCase();
  }
  if (typeof key === "number") return typeof v === "number" && compareValues(v, key) === 0;
  if (typeof key === "boolean") return v === key;
  return false;
}

const sameKind = (v, key) => typeof v === typeof key && v !== null;

/** The index along a one-dimensional list (get(i) for i < n) per MATCH's types: 0 exact, 1 largest ≤ key
 * on ascending data, −1 smallest ≥ key on descending data. −1 when nothing matches. */
function findIn(get, n, key, type) {
  if (type === 0) {
    const wild = typeof key === "string" && hasWild(key) ? wildcard(key) : null;
    for (let i = 0; i < n; i++) if (lookupEq(get(i), key, wild)) return i;
    return -1;
  }
  let last = -1;
  for (let i = 0; i < n; i++) {
    const v = get(i);
    if (v === null || v === undefined || !sameKind(v, key)) continue;
    const c = compareValues(v, key);
    if (type > 0) {
      if (c <= 0) last = i;
      else break;
    } else if (c >= 0) last = i;
    else break;
  }
  return last;
}

const lineOf = (r) => {
  if (r.cols === 1) return { n: r.scanRows, get: (i) => r.get(i, 0), vertical: true };
  if (r.rows === 1) return { n: r.scanCols, get: (j) => r.get(0, j), vertical: false };
  return null;
};

function datePart(v) {
  const n = toNumber(v);
  if (isError(n)) return n;
  if (n < 0) return NUM("A date cannot be negative.");
  return fromSerial(n);
}

function weekdayOf(serial, type) {
  const wd = fromSerial(Math.floor(serial)).weekday;
  switch (type) {
    case 1:
    case 17:
      return wd + 1;
    case 2:
    case 11:
      return ((wd + 6) % 7) + 1;
    case 3:
      return (wd + 6) % 7;
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
      return ((wd + 7 - (type - 10)) % 7) + 1;
    default:
      return NUM("WEEKDAY's type is 1, 2, 3 or 11 to 17.");
  }
}

function addMonths(serial, months, endOfMonth) {
  const p = fromSerial(Math.floor(serial));
  const total = p.y * 12 + (p.m - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const d = endOfMonth ? daysInMonth(y, m) : Math.min(p.d, daysInMonth(y, m));
  const out = toSerial(y, m, d);
  return out < 0 ? NUM("The date falls before 1899-12-30.") : out;
}

function variance(xs, sample) {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return DIV0();
  const mean = sum(xs) / n;
  let s = 0;
  for (const x of xs) s += (x - mean) ** 2;
  return s / (sample ? n - 1 : n);
}

/* ---------- the table ---------- */

export const FUNCTIONS = {};

function def(help, fn, opts = {}) {
  const name = help.slice(0, help.indexOf("("));
  const inner = help.slice(help.indexOf("(") + 1, help.lastIndexOf(")"));
  const parts = inner ? inner.split(",").map((s) => s.trim()) : [];
  const variadic = parts.some((s) => s.includes("…"));
  let depth = 0;
  let required = 0;
  for (const s of parts) {
    if (s.startsWith("[")) depth++;
    else if (depth === 0) required++;
    if (s.endsWith("]")) depth--;
  }
  const min = opts.min ?? required;
  const max = opts.max ?? (variadic ? 255 : parts.length);
  FUNCTIONS[name] = { fn, min, max, help, takes: opts.takes ?? "values", errors: Boolean(opts.errors) };
}

/** The sum and count of the numbers among the arguments, references through their kept block totals. */
function total(args, ctx) {
  let s = 0;
  let n = 0;
  const rest = [];
  for (const a of args) {
    if (isRange(a)) {
      const t = a.sums();
      if (t.err) return t.err;
      s += t.sum;
      n += t.count;
    } else rest.push(a);
  }
  const xs = numbersOf(rest, ctx);
  if (isError(xs)) return xs;
  return { sum: s + sum(xs), count: n + xs.length };
}

// Math
def("SUM(value1, [value2, …])", (args, ctx) => {
  const t = total(args, ctx);
  return isError(t) ? t : t.sum;
}, { takes: "refs" });
def("PRODUCT(value1, [value2, …])", (args, ctx) => {
  const xs = numbersOf(args, ctx);
  if (isError(xs)) return xs;
  return xs.length ? xs.reduce((a, b) => a * b, 1) : 0;
}, { takes: "refs" });
def("ROUND(value, [places])", numeric(([x, d]) => roundHalfAway(x, intOf(opt(d, 0)))));
def("ROUNDUP(value, [places])", numeric(([x, d]) => roundWith(x, intOf(opt(d, 0)), "up")));
def("ROUNDDOWN(value, [places])", numeric(([x, d]) => roundWith(x, intOf(opt(d, 0)), "down")));
def("TRUNC(value, [places])", numeric(([x, d]) => roundWith(x, intOf(opt(d, 0)), "down")));
def("INT(value)", numeric(([x]) => Math.floor(x)));
def("ABS(value)", numeric(([x]) => Math.abs(x)));
def("SIGN(value)", numeric(([x]) => Math.sign(x)));
def("MOD(dividend, divisor)", numeric(([a, b]) => (b === 0 ? DIV0() : a - b * Math.floor(Number((a / b).toPrecision(15))))));
def("POWER(base, exponent)", numeric(([a, b]) => (a === 0 && b < 0 ? DIV0() : Math.pow(a, b))));
def("SQRT(value)", numeric(([x]) => (x < 0 ? NUM("SQRT of a negative number.") : Math.sqrt(x))));
def("EXP(exponent)", numeric(([x]) => Math.exp(x)));
def("LN(value)", numeric(([x]) => (x <= 0 ? NUM("LN needs a number above 0.") : Math.log(x))));
def("LOG10(value)", numeric(([x]) => (x <= 0 ? NUM("LOG10 needs a number above 0.") : Math.log10(x))));
def("LOG(value, [base])", numeric(([x, b]) => {
  const base = opt(b, 10);
  if (x <= 0 || base <= 0) return NUM("LOG needs numbers above 0.");
  if (base === 1) return DIV0();
  return base === 10 ? Math.log10(x) : Math.log(x) / Math.log(base);
}));
def("CEILING(value, [factor])", numeric(([x, f]) => {
  const s = opt(f, 1);
  if (s === 0) return 0;
  if (x > 0 && s < 0) return NUM("CEILING's factor must have the value's sign.");
  const q = Number((Math.abs(x) / Math.abs(s)).toPrecision(15));
  if (s < 0) return -Math.ceil(q) * Math.abs(s);
  return x < 0 ? -Math.floor(q) * s : Math.ceil(q) * s;
}));
def("FLOOR(value, [factor])", numeric(([x, f]) => {
  const s = opt(f, 1);
  if (s === 0) return x === 0 ? 0 : DIV0();
  if (x > 0 && s < 0) return NUM("FLOOR's factor must have the value's sign.");
  const q = Number((Math.abs(x) / Math.abs(s)).toPrecision(15));
  if (s < 0) return -Math.floor(q) * Math.abs(s);
  return x < 0 ? -Math.ceil(q) * s : Math.floor(q) * s;
}));
def("PI()", () => Math.PI);
def("RAND()", () => Math.random());
def("RANDBETWEEN(low, high)", numeric(([lo, hi]) => {
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  if (a > b) return NUM("RANDBETWEEN's low is above its high.");
  return a + Math.floor(Math.random() * (b - a + 1));
}));

// Statistics
def("AVERAGE(value1, [value2, …])", (args, ctx) => {
  const t = total(args, ctx);
  if (isError(t)) return t;
  return t.count ? t.sum / t.count : error("#DIV/0!", "AVERAGE has no numbers to average.");
}, { takes: "refs" });
def("MIN(value1, [value2, …])", (args, ctx) => {
  const xs = numbersOf(args, ctx);
  if (isError(xs)) return xs;
  let m = Infinity;
  for (const x of xs) if (x < m) m = x;
  return xs.length ? m : 0;
}, { takes: "refs" });
def("MAX(value1, [value2, …])", (args, ctx) => {
  const xs = numbersOf(args, ctx);
  if (isError(xs)) return xs;
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return xs.length ? m : 0;
}, { takes: "refs" });
def("COUNT(value1, [value2, …])", (args) => {
  let n = 0;
  for (const a of args) {
    if (isRange(a)) n += a.sums().count;
    else if (typeof a === "number" || typeof a === "boolean") n++;
    else if (typeof a === "string" && readNumber(a)) n++;
  }
  return n;
}, { takes: "refs", errors: true });
def("COUNTA(value1, [value2, …])", (args) => {
  let n = 0;
  for (const a of args) {
    if (isRange(a)) a.each((v) => void (v !== null && v !== undefined && n++));
    else if (a !== null && a !== undefined) n++;
  }
  return n;
}, { takes: "refs", errors: true });
def("COUNTBLANK(range)", (args) => {
  const r = args[0];
  if (!isRange(r)) return r === null || r === "" ? 1 : 0;
  let filled = 0;
  r.each((v) => void (v !== "" && filled++));
  return r.rows * r.cols - filled;
}, { takes: "refs", errors: true });
def("MEDIAN(value1, [value2, …])", (args, ctx) => {
  const xs = numbersOf(args, ctx);
  if (isError(xs)) return xs;
  if (!xs.length) return NUM("MEDIAN has no numbers.");
  xs.sort((a, b) => a - b);
  const h = xs.length >> 1;
  return xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2;
}, { takes: "refs" });
def("MODE(value1, [value2, …])", (args, ctx) => {
  const xs = numbersOf(args, ctx);
  if (isError(xs)) return xs;
  const counts = new Map();
  let best = null;
  let bestN = 1;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
  }
  for (const x of xs) {
    const n = counts.get(x);
    if (n > bestN) {
      best = x;
      bestN = n;
    }
  }
  return best === null ? NA("No value repeats.") : best;
}, { takes: "refs" });
for (const [name, sample, root] of [["STDEV", true, true], ["STDEVP", false, true], ["VAR", true, false], ["VARP", false, false]]) {
  def(`${name}(value1, [value2, …])`, (args, ctx) => {
    const xs = numbersOf(args, ctx);
    if (isError(xs)) return xs;
    const v = variance(xs, sample);
    return isError(v) ? v : root ? Math.sqrt(v) : v;
  }, { takes: "refs" });
}
for (const [name, large] of [["LARGE", true], ["SMALL", false]]) {
  def(`${name}(data, n)`, (args, ctx) => {
    const xs = numbersOf([args[0]], ctx, { direct: false });
    if (isError(xs)) return xs;
    const k = toNumber(scalarOf(args[1], ctx));
    if (isError(k)) return k;
    const i = Math.ceil(k);
    if (i < 1 || i > xs.length) return NUM(`${name} needs n between 1 and the count of numbers.`);
    xs.sort((a, b) => (large ? b - a : a - b));
    return xs[i - 1];
  }, { takes: "refs" });
}
def("RANK(value, data, [ascending])", (args, ctx) => {
  const x = toNumber(scalarOf(args[0], ctx));
  if (isError(x)) return x;
  const xs = numbersOf([args[1]], ctx, { direct: false });
  if (isError(xs)) return xs;
  const asc = toBool(opt(scalarOf(args[2], ctx), false));
  if (isError(asc)) return asc;
  if (!xs.some((v) => compareValues(v, x) === 0)) return NA("The value is not in the data.");
  let n = 1;
  for (const v of xs) if (asc ? compareValues(v, x) < 0 : compareValues(v, x) > 0) n++;
  return n;
}, { takes: "refs" });

// Conditional aggregates
def("COUNTIF(range, criterion)", (args, ctx) => {
  const e = needRange(args[0], "COUNTIF");
  return e ?? ifsFamily(args, ctx, { from: 0, count: true });
}, { takes: "refs" });
def("COUNTIFS(range1, criterion1, [range2, criterion2, …])", (args, ctx) => (args.length % 2 ? NA("COUNTIFS takes ranges and criteria in pairs.") : ifsFamily(args, ctx, { from: 0, count: true })), { takes: "refs" });
def("SUMIF(range, criterion, [sum_range])", (args, ctx) => {
  const e = needRange(args[0], "SUMIF");
  return e ?? ifsFamily(args.slice(0, 2), ctx, { from: 0, valueRange: args[2] ?? args[0] });
}, { takes: "refs" });
def("SUMIFS(sum_range, range1, criterion1, [range2, criterion2, …])", (args, ctx) => (args.length % 2 === 0 ? NA("SUMIFS takes ranges and criteria in pairs.") : ifsFamily(args, ctx, { from: 1, valueRange: args[0] })), { takes: "refs" });
def("AVERAGEIF(range, criterion, [average_range])", (args, ctx) => {
  const e = needRange(args[0], "AVERAGEIF");
  return e ?? ifsFamily(args.slice(0, 2), ctx, { from: 0, valueRange: args[2] ?? args[0], avg: true });
}, { takes: "refs" });
def("AVERAGEIFS(average_range, range1, criterion1, [range2, criterion2, …])", (args, ctx) => (args.length % 2 === 0 ? NA("AVERAGEIFS takes ranges and criteria in pairs.") : ifsFamily(args, ctx, { from: 1, valueRange: args[0], avg: true })), { takes: "refs" });

/** MAXIFS and MINIFS: the largest or smallest number of the first range where every criterion holds; 0 when none. */
function extremeIfs(args, ctx, name, pick) {
  if (args.length % 2 === 0) return NA(`${name} takes ranges and criteria in pairs.`);
  if (!isRange(args[0])) return VALUE(`${name}'s first argument must be a range of cells.`);
  const pairs = pairsOf(args, 1, ctx);
  if (isError(pairs)) return pairs;
  if (args[0].rows !== pairs[0].range.rows || args[0].cols !== pairs[0].range.cols) return VALUE("The ranges must be the same size.");
  let best = null;
  let bad = null;
  const n = matching(pairs, (i, j) => {
    const v = args[0].get(i, j);
    if (isError(v)) bad ??= v;
    else if (typeof v === "number") best = best === null ? v : pick(best, v);
  });
  if (isError(n)) return n;
  return bad ?? best ?? 0;
}
def("MAXIFS(max_range, range1, criterion1, [range2, criterion2, …])", (args, ctx) => extremeIfs(args, ctx, "MAXIFS", Math.max), { takes: "refs" });
def("MINIFS(min_range, range1, criterion1, [range2, criterion2, …])", (args, ctx) => extremeIfs(args, ctx, "MINIFS", Math.min), { takes: "refs" });
def("SUMPRODUCT(array1, [array2, …])", (args) => {
  const blocks = args.map((a) => (isRange(a) ? a : null));
  if (blocks.some((b) => !b)) return VALUE("SUMPRODUCT takes ranges of cells of the same size.");
  const { rows, cols } = blocks[0];
  if (blocks.some((b) => b.rows !== rows || b.cols !== cols)) return VALUE("SUMPRODUCT's ranges must be the same size.");
  // A blank anywhere makes the product 0, so only the block every range can hold anything in is walked.
  const scanR = Math.min(...blocks.map((b) => b.scanRows));
  const scanC = Math.min(...blocks.map((b) => b.scanCols));
  let s = 0;
  for (let i = 0; i < scanR; i++) {
    for (let j = 0; j < scanC; j++) {
      let p = 1;
      for (const b of blocks) {
        const v = b.get(i, j);
        if (isError(v)) return v;
        p *= typeof v === "number" ? v : 0;
      }
      s += p;
    }
  }
  return s;
}, { takes: "refs" });

// Logic
const thunkVal = (t, ctx) => (t === undefined ? undefined : scalarOf(t(), ctx));
def("IF(condition, [value_if_true], [value_if_false])", (ts, ctx) => {
  const c = toBool(thunkVal(ts[0], ctx));
  if (isError(c)) return c;
  if (c) return ts.length > 1 ? ts[1]() : true;
  return ts.length > 2 ? ts[2]() : false;
}, { takes: "lazy", min: 1 });
def("IFS(condition1, value1, [condition2, value2, …])", (ts, ctx) => {
  if (ts.length % 2) return NA("IFS takes conditions and values in pairs.");
  for (let k = 0; k < ts.length; k += 2) {
    const c = toBool(thunkVal(ts[k], ctx));
    if (isError(c)) return c;
    if (c) return ts[k + 1]();
  }
  return NA("No condition in IFS is true.");
}, { takes: "lazy" });
def("IFERROR(value, [value_if_error])", (ts, ctx) => {
  const v = thunkVal(ts[0], ctx);
  if (isError(v)) return ts.length > 1 ? ts[1]() : "";
  return v;
}, { takes: "lazy" });
def("IFNA(value, value_if_na)", (ts, ctx) => {
  const v = thunkVal(ts[0], ctx);
  return isError(v) && v.err === "#N/A" ? ts[1]() : v;
}, { takes: "lazy" });
function truths(args, name) {
  const out = [];
  for (const a of args) {
    if (isRange(a)) {
      let err = null;
      a.each((v) => {
        if (typeof v === "boolean") out.push(v);
        else if (typeof v === "number") out.push(v !== 0);
        else if (isError(v)) {
          err = v;
          return false;
        }
      });
      if (err) return err;
    } else if (a !== undefined && a !== null) {
      const b = toBool(a);
      if (isError(b)) return b;
      out.push(b);
    }
  }
  return out.length ? out : VALUE(`${name} has no TRUE or FALSE values.`);
}
def("AND(logical1, [logical2, …])", (args) => {
  const ts = truths(args, "AND");
  return isError(ts) ? ts : ts.every(Boolean);
}, { takes: "refs" });
def("OR(logical1, [logical2, …])", (args) => {
  const ts = truths(args, "OR");
  return isError(ts) ? ts : ts.some(Boolean);
}, { takes: "refs" });
def("XOR(logical1, [logical2, …])", (args) => {
  const ts = truths(args, "XOR");
  return isError(ts) ? ts : ts.filter(Boolean).length % 2 === 1;
}, { takes: "refs" });
def("NOT(logical)", ([v]) => {
  const b = toBool(v);
  return isError(b) ? b : !b;
});
def("SWITCH(expression, case1, value1, [case2, value2, …], [default])", (ts, ctx) => {
  const x = thunkVal(ts[0], ctx);
  if (isError(x)) return x;
  let k = 1;
  for (; k + 1 < ts.length; k += 2) {
    const c = thunkVal(ts[k], ctx);
    if (isError(c)) return c;
    if (typeof c === typeof x && compareValues(c, x) === 0) return ts[k + 1]();
    if (x === null && (c === null || c === "")) return ts[k + 1]();
  }
  return k < ts.length ? ts[k]() : NA("No case in SWITCH matches.");
}, { takes: "lazy", min: 3 });
def("CHOOSE(index, choice1, [choice2, …])", (ts, ctx) => {
  const i = toNumber(thunkVal(ts[0], ctx));
  if (isError(i)) return i;
  const k = Math.trunc(i);
  if (k < 1 || k >= ts.length) return VALUE("CHOOSE's index is out of range.");
  return ts[k]();
}, { takes: "lazy" });
def("TRUE()", () => true);
def("FALSE()", () => false);
def("NA()", () => NA("NA() was called."));

// Lookup
def("VLOOKUP(search_key, range, index, [is_sorted])", (args, ctx) => lookup(args, ctx, true), { takes: "refs" });
def("HLOOKUP(search_key, range, index, [is_sorted])", (args, ctx) => lookup(args, ctx, false), { takes: "refs" });
function lookup(args, ctx, vertical) {
  const name = vertical ? "VLOOKUP" : "HLOOKUP";
  const key = scalarOf(args[0], ctx);
  if (isError(key)) return key;
  const r = args[1];
  if (!isRange(r)) return VALUE(`${name} needs a range to search.`);
  const idx = toNumber(scalarOf(args[2], ctx));
  if (isError(idx)) return idx;
  const k = Math.trunc(idx);
  const width = vertical ? r.cols : r.rows;
  if (k < 1) return VALUE(`${name}'s index must be 1 or more.`);
  if (k > width) return error("#REF!", `${name}'s index ${k} is past the range's ${width} ${vertical ? "columns" : "rows"}.`);
  const sorted = toBool(opt(scalarOf(args[3], ctx), true));
  if (isError(sorted)) return sorted;
  if (key === null) return NA(`${name} has nothing to look for.`);
  const n = vertical ? r.scanRows : r.scanCols;
  const get = vertical ? (i) => r.get(i, 0) : (i) => r.get(0, i);
  const at = findIn(get, n, key, sorted ? 1 : 0);
  if (at < 0) return NA(`No match for ${toText(key)} in ${name}.`);
  return vertical ? r.get(at, k - 1) : r.get(k - 1, at);
}
def("MATCH(search_key, range, [search_type])", (args, ctx) => {
  const key = scalarOf(args[0], ctx);
  if (isError(key)) return key;
  const r = args[1];
  if (!isRange(r)) return NA("MATCH needs a range to search.");
  const line = lineOf(r);
  if (!line) return NA("MATCH searches one row or one column.");
  const t = toNumber(opt(scalarOf(args[2], ctx), 1));
  if (isError(t)) return t;
  if (key === null) return NA("MATCH has nothing to look for.");
  const at = findIn(line.get, line.n, key, Math.sign(t));
  return at < 0 ? NA(`No match for ${toText(key)}.`) : at + 1;
}, { takes: "refs" });
def("XLOOKUP(search_key, lookup_range, result_range, [missing_value], [match_mode], [search_mode])", (args, ctx) => {
  const key = scalarOf(args[0], ctx);
  if (isError(key)) return key;
  const lr = args[1];
  const rr = args[2];
  if (!isRange(lr) || !isRange(rr)) return VALUE("XLOOKUP needs ranges to search and to answer from.");
  const line = lineOf(lr);
  if (!line) return VALUE("XLOOKUP searches one row or one column.");
  if (line.vertical ? rr.rows !== lr.rows : rr.cols !== lr.cols) return VALUE("XLOOKUP's result range must be as long as its lookup range.");
  const mode = toNumber(opt(scalarOf(args[4], ctx), 0));
  const search = toNumber(opt(scalarOf(args[5], ctx), 1));
  if (isError(mode)) return mode;
  if (isError(search)) return search;
  const wild = mode === 2 && typeof key === "string" ? wildcard(key) : null;
  const order = [];
  if (search < 0) for (let i = line.n - 1; i >= 0; i--) order.push(i);
  else for (let i = 0; i < line.n; i++) order.push(i);
  let found = -1;
  let best = -1;
  let bestV;
  for (const i of order) {
    const v = line.get(i);
    if (lookupEq(v, key, wild)) {
      found = i;
      break;
    }
    if ((mode === 1 || mode === -1) && v !== null && sameKind(v, key)) {
      const c = compareValues(v, key);
      if ((mode === -1 && c < 0 && (best < 0 || compareValues(v, bestV) > 0)) || (mode === 1 && c > 0 && (best < 0 || compareValues(v, bestV) < 0))) {
        best = i;
        bestV = v;
      }
    }
  }
  if (found < 0) found = best;
  if (found < 0) return args[3] !== undefined && args[3] !== null ? args[3] : NA(`No match for ${toText(key)} in XLOOKUP.`);
  return line.vertical ? rr.sub(found, 0, found, rr.cols - 1) : rr.sub(0, found, rr.rows - 1, found);
}, { takes: "refs" });
def("INDEX(reference, [row], [column])", (args, ctx) => {
  const r = args[0];
  let row = toNumber(opt(scalarOf(args[1], ctx), 0));
  let col = toNumber(opt(scalarOf(args[2], ctx), 0));
  if (isError(row)) return row;
  if (isError(col)) return col;
  row = Math.trunc(row);
  col = Math.trunc(col);
  if (!isRange(r)) return row <= 1 && col <= 1 ? r : error("#REF!", "INDEX is past the value.");
  if (args.length < 3 && r.rows === 1 && r.cols > 1) {
    col = row;
    row = 0;
  }
  if (row < 0 || col < 0 || row > r.rows || col > r.cols) return error("#REF!", "INDEX is past the range.");
  const i1 = row ? row - 1 : 0;
  const i2 = row ? row - 1 : r.rows - 1;
  const j1 = col ? col - 1 : 0;
  const j2 = col ? col - 1 : r.cols - 1;
  return r.sub(i1, j1, i2, j2);
}, { takes: "refs" });
def("ROW([reference])", (args, ctx) => (args.length && isRange(args[0]) ? args[0].r1 + 1 : args.length && args[0] !== null ? VALUE("ROW needs a reference.") : ctx.row + 1), { takes: "refs" });
def("COLUMN([reference])", (args, ctx) => (args.length && isRange(args[0]) ? args[0].c1 + 1 : args.length && args[0] !== null ? VALUE("COLUMN needs a reference.") : ctx.col + 1), { takes: "refs" });
def("ROWS(range)", ([r]) => (isRange(r) ? r.rows : 1), { takes: "refs" });
def("COLUMNS(range)", ([r]) => (isRange(r) ? r.cols : 1), { takes: "refs" });

// Text
const strOf = (args, i, d = "") => (args[i] === undefined ? d : toText(args[i]));
const countArg = (v, d, name) => {
  if (v === undefined) return d;
  const n = toNumber(v);
  if (isError(n)) return n;
  if (n < 0) return VALUE(`${name} cannot take a negative count.`);
  return Math.trunc(n);
};
def("LEN(text)", (a) => strOf(a, 0).length);
def("LEFT(text, [count])", (a) => {
  const n = countArg(a[1], 1, "LEFT");
  return isError(n) ? n : strOf(a, 0).slice(0, n);
});
def("RIGHT(text, [count])", (a) => {
  const n = countArg(a[1], 1, "RIGHT");
  const s = strOf(a, 0);
  return isError(n) ? n : n === 0 ? "" : s.slice(Math.max(0, s.length - n));
});
def("MID(text, start, count)", (a) => {
  const st = toNumber(a[1]);
  if (isError(st)) return st;
  if (st < 1) return VALUE("MID starts at 1 or later.");
  const n = countArg(a[2], 0, "MID");
  return isError(n) ? n : strOf(a, 0).substr(Math.trunc(st) - 1, n);
});
def("UPPER(text)", (a) => strOf(a, 0).toUpperCase());
def("LOWER(text)", (a) => strOf(a, 0).toLowerCase());
def("PROPER(text)", (a) => strOf(a, 0).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()));
def("TRIM(text)", (a) => strOf(a, 0).replace(/ {2,}/g, " ").replace(/^ +| +$/g, ""));
function joinText(args, ctx, delim, skipEmpty) {
  const parts = [];
  for (const a of args) {
    if (isRange(a)) {
      let err = null;
      if (skipEmpty) {
        a.each((v) => {
          if (isError(v)) {
            err = v;
            return false;
          }
          if (v !== "") parts.push(toText(v));
        });
      } else {
        for (let i = 0; i < a.scanRows && !err; i++)
          for (let j = 0; j < a.scanCols; j++) {
            const v = a.get(i, j);
            if (isError(v)) {
              err = v;
              break;
            }
            parts.push(toText(v));
          }
      }
      if (err) return err;
    } else if (isError(a)) return a;
    else if (a !== undefined) {
      const t = toText(a);
      if (!skipEmpty || t !== "") parts.push(t);
    }
  }
  const out = parts.join(delim);
  return out.length > 32767 ? VALUE("The text is longer than 32,767 characters.") : out;
}
def("CONCAT(value1, [value2, …])", (args, ctx) => joinText(args, ctx, "", true), { takes: "refs" });
def("CONCATENATE(text1, [text2, …])", (args, ctx) => joinText(args, ctx, "", true), { takes: "refs" });
def("TEXTJOIN(delimiter, ignore_empty, text1, [text2, …])", (args, ctx) => {
  const d = scalarOf(args[0], ctx);
  if (isError(d)) return d;
  const skip = toBool(scalarOf(args[1], ctx));
  if (isError(skip)) return skip;
  return joinText(args.slice(2), ctx, toText(d), skip);
}, { takes: "refs" });
def("SUBSTITUTE(text, search_for, replace_with, [occurrence])", (a) => {
  const s = strOf(a, 0);
  const find = strOf(a, 1);
  const rep = strOf(a, 2);
  if (!find) return s;
  if (a[3] === undefined) return s.split(find).join(rep);
  const k = toNumber(a[3]);
  if (isError(k)) return k;
  if (k < 1) return VALUE("SUBSTITUTE's occurrence is 1 or more.");
  let at = -1;
  for (let n = 0; n < Math.trunc(k); n++) {
    at = s.indexOf(find, at + 1);
    if (at < 0) return s;
  }
  return s.slice(0, at) + rep + s.slice(at + find.length);
});
def("REPLACE(text, position, length, new_text)", (a) => {
  const s = strOf(a, 0);
  const p = toNumber(a[1]);
  const n = toNumber(a[2]);
  if (isError(p)) return p;
  if (isError(n)) return n;
  if (p < 1 || n < 0) return VALUE("REPLACE's position is 1 or more and its length 0 or more.");
  return s.slice(0, Math.trunc(p) - 1) + strOf(a, 3) + s.slice(Math.trunc(p) - 1 + Math.trunc(n));
});
function finder(a, name, insensitive) {
  const find = strOf(a, 0);
  const s = strOf(a, 1);
  const st = a[2] === undefined ? 1 : toNumber(a[2]);
  if (isError(st)) return st;
  if (st < 1 || st > s.length + 1) return VALUE(`${name}'s start is past the text.`);
  const from = Math.trunc(st) - 1;
  if (!insensitive) {
    const i = s.indexOf(find, from);
    return i < 0 ? VALUE(`"${find}" is not in the text.`) : i + 1;
  }
  const re = wildcard(find, true);
  const m = re.exec(s.slice(from));
  return m ? m.index + from + 1 : VALUE(`"${find}" is not in the text.`);
}
def("FIND(search_for, text_to_search, [starting_at])", (a) => finder(a, "FIND", false));
def("SEARCH(search_for, text_to_search, [starting_at])", (a) => finder(a, "SEARCH", true));
def("TEXT(number, format)", (a) => {
  const fmt = strOf(a, 1);
  try {
    compileFormat(fmt);
  } catch {
    return VALUE(`TEXT cannot read the format "${fmt}".`);
  }
  let v = a[0];
  if (v === null || v === undefined) v = 0;
  if (typeof v === "string") {
    const n = readNumber(v);
    if (n) v = n.value;
  }
  return formatValue(v, fmt);
});
def("VALUE(text)", ([v]) => {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") {
    const n = readNumber(v);
    return n ? n.value : VALUE(`"${v}" is not a number.`);
  }
  return VALUE("VALUE needs text that reads as a number.");
});
def("REPT(text, number)", (a) => {
  const n = countArg(a[1], 0, "REPT");
  if (isError(n)) return n;
  const s = strOf(a, 0);
  if (s.length * n > 32767) return VALUE("The text would be longer than 32,767 characters.");
  return s.repeat(n);
});
def("EXACT(text1, text2)", (a) => strOf(a, 0) === strOf(a, 1));

// Dates
def("TODAY()", (a, ctx) => todaySerial(ctx.now));
def("NOW()", (a, ctx) => nowSerial(ctx.now));
def("DATE(year, month, day)", numeric(([y, m, d]) => {
  let yy = Math.trunc(y);
  if (yy < 0 || yy > 9999) return NUM("DATE's year is 0 to 9999.");
  if (yy < 1900) yy += 1900;
  const s = toSerial(yy, Math.trunc(m), Math.trunc(d));
  return s < 0 ? NUM("The date falls before 1899-12-30.") : s;
}));
def("TIME(hour, minute, second)", numeric(([h, m, s]) => {
  const total = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
  if (total < 0) return NUM("TIME cannot be negative.");
  return (total % 86400) / 86400;
}));
for (const [name, key] of [["YEAR", "y"], ["MONTH", "m"], ["DAY", "d"], ["HOUR", "h"], ["MINUTE", "mi"], ["SECOND", "s"]]) {
  def(`${name}(${key.length === 1 && "ymd".includes(key) ? "date" : "time"})`, ([v]) => {
    const p = datePart(v);
    return isError(p) ? p : p[key];
  });
}
def("WEEKDAY(date, [type])", numeric(([d, t]) => (d < 0 ? NUM("A date cannot be negative.") : weekdayOf(d, Math.trunc(opt(t, 1))))));
def("WEEKNUM(date, [type])", numeric(([d, t]) => {
  if (d < 0) return NUM("A date cannot be negative.");
  const type = Math.trunc(opt(t, 1));
  const serial = Math.floor(d);
  const p = fromSerial(serial);
  if (type === 21) {
    const wd = (p.weekday + 6) % 7;
    const thursday = serial - wd + 3;
    const ty = fromSerial(thursday).y;
    return Math.floor((thursday - toSerial(ty, 1, 1)) / 7) + 1;
  }
  const starts = { 1: 0, 17: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6 };
  if (!(type in starts)) return NUM("WEEKNUM's type is 1, 2, 11 to 17 or 21.");
  const jan1 = toSerial(p.y, 1, 1);
  const offset = (fromSerial(jan1).weekday - starts[type] + 7) % 7;
  return Math.floor((serial - jan1 + offset) / 7) + 1;
}));
def("EDATE(start_date, months)", numeric(([d, m]) => (d < 0 ? NUM("A date cannot be negative.") : addMonths(d, m, false))));
def("EOMONTH(start_date, months)", numeric(([d, m]) => (d < 0 ? NUM("A date cannot be negative.") : addMonths(d, m, true))));
def("DAYS(end_date, start_date)", numeric(([e, s]) => Math.floor(e) - Math.floor(s)));
def("DATEDIF(start_date, end_date, unit)", (a) => {
  const s = toNumber(a[0]);
  const e = toNumber(a[1]);
  if (isError(s)) return s;
  if (isError(e)) return e;
  const unit = toText(a[2]).toUpperCase();
  const s0 = Math.floor(s);
  const e0 = Math.floor(e);
  if (s0 > e0) return NUM("DATEDIF's start is after its end.");
  const p = fromSerial(s0);
  const q = fromSerial(e0);
  const months = (q.y - p.y) * 12 + (q.m - p.m) - (q.d < p.d ? 1 : 0);
  switch (unit) {
    case "D":
      return e0 - s0;
    case "M":
      return months;
    case "Y":
      return Math.floor(months / 12);
    case "YM":
      return months % 12;
    case "MD": {
      if (q.d >= p.d) return q.d - p.d;
      const pm = q.m === 1 ? 12 : q.m - 1;
      const py = q.m === 1 ? q.y - 1 : q.y;
      return Math.max(0, daysInMonth(py, pm) - p.d + q.d);
    }
    case "YD": {
      let y = q.y;
      let start = toSerial(y, p.m, Math.min(p.d, daysInMonth(y, p.m)));
      if (start > e0) {
        y -= 1;
        start = toSerial(y, p.m, Math.min(p.d, daysInMonth(y, p.m)));
      }
      return e0 - start;
    }
    default:
      return NUM('DATEDIF\'s unit is "Y", "M", "D", "MD", "YM" or "YD".');
  }
});
def("NETWORKDAYS(start_date, end_date, [holidays])", (args, ctx) => {
  const s = toNumber(scalarOf(args[0], ctx));
  const e = toNumber(scalarOf(args[1], ctx));
  if (isError(s)) return s;
  if (isError(e)) return e;
  const holidays = new Set();
  if (args[2] !== undefined && args[2] !== null) {
    const hs = numbersOf([args[2]], ctx);
    if (isError(hs)) return hs;
    for (const h of hs) holidays.add(Math.floor(h));
  }
  const sign = s <= e ? 1 : -1;
  const lo = Math.floor(Math.min(s, e));
  const hi = Math.floor(Math.max(s, e));
  const total = hi - lo + 1;
  let n = Math.floor(total / 7) * 5;
  const wd0 = fromSerial(lo).weekday;
  for (let k = 0; k < total % 7; k++) {
    const wd = (wd0 + Math.floor(total / 7) * 7 + k) % 7;
    if (wd !== 0 && wd !== 6) n++;
  }
  for (const h of holidays) {
    if (h < lo || h > hi) continue;
    const wd = fromSerial(h).weekday;
    if (wd !== 0 && wd !== 6) n--;
  }
  return sign * n;
}, { takes: "refs" });

// Information
def("ISBLANK(value)", ([v]) => v === null || v === undefined, { errors: true });
def("ISNUMBER(value)", ([v]) => typeof v === "number", { errors: true });
def("ISTEXT(value)", ([v]) => typeof v === "string", { errors: true });
def("ISEVEN(value)", numeric(([x]) => Math.trunc(x) % 2 === 0));
def("ISODD(value)", numeric(([x]) => Math.abs(Math.trunc(x) % 2) === 1));
def("ISLOGICAL(value)", ([v]) => typeof v === "boolean", { errors: true });
def("ISERROR(value)", ([v]) => isError(v), { errors: true });
def("ISNA(value)", ([v]) => isError(v) && v.err === "#N/A", { errors: true });

// Finance
const fin = (r, n, type) => ({ g: (1 + r) ** n, t: type ? 1 : 0 });
def("PMT(rate, number_of_periods, present_value, [future_value], [end_or_beginning])", numeric(([r, n, pv, fv, type]) => {
  fv = opt(fv, 0);
  if (n === 0) return NUM("PMT needs at least one period.");
  if (r === 0) return -(pv + fv) / n;
  const { g, t } = fin(r, n, opt(type, 0));
  return (-r * (fv + pv * g)) / ((1 + r * t) * (g - 1));
}));
def("FV(rate, number_of_periods, payment_amount, [present_value], [end_or_beginning])", numeric(([r, n, pmt, pv, type]) => {
  pv = opt(pv, 0);
  if (r === 0) return -(pv + pmt * n);
  const { g, t } = fin(r, n, opt(type, 0));
  return -(pv * g + (pmt * (1 + r * t) * (g - 1)) / r);
}));
def("PV(rate, number_of_periods, payment_amount, [future_value], [end_or_beginning])", numeric(([r, n, pmt, fv, type]) => {
  fv = opt(fv, 0);
  if (r === 0) return -(fv + pmt * n);
  const { g, t } = fin(r, n, opt(type, 0));
  return -(fv + (pmt * (1 + r * t) * (g - 1)) / r) / g;
}));
def("NPV(discount, cashflow1, [cashflow2, …])", (args, ctx) => {
  const r = toNumber(scalarOf(args[0], ctx));
  if (isError(r)) return r;
  const xs = numbersOf(args.slice(1), ctx);
  if (isError(xs)) return xs;
  let s = 0;
  xs.forEach((x, i) => (s += x / (1 + r) ** (i + 1)));
  return s;
}, { takes: "refs" });

