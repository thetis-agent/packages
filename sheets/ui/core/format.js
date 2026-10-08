/* Number formats: what a cell's `fmt` turns its value into on screen, in the tool's table and in TEXT().
 * A pattern is read once into sections of tokens (cached by its text) and then applied; the subset is
 * the one people type in Sheets and Excel: placeholders 0 # ?, thousands commas and trailing scaling
 * commas, decimals, percent, scientific E+00, quoted and backslashed literals, @ for text, the date and
 * time tokens, AM/PM, [h] elapsed hours, and up to four sections (positive; negative; zero; text).
 * Colours and conditions in brackets are read and ignored. Anything else is refused, so a typo is caught
 * when the format is set, not shown as garbage later. */
import { fromSerial } from "./dates.js";

export const PRESETS = [
  { id: "general", label: "General", fmt: null },
  { id: "number", label: "Number", fmt: "#,##0.00" },
  { id: "integer", label: "Integer", fmt: "#,##0" },
  { id: "currency", label: "Currency", fmt: "$#,##0.00" },
  { id: "percent", label: "Percent", fmt: "0.00%" },
  { id: "date", label: "Date", fmt: "yyyy-mm-dd" },
  { id: "datetime", label: "Date time", fmt: "yyyy-mm-dd hh:mm" },
  { id: "time", label: "Time", fmt: "hh:mm" },
  { id: "text", label: "Plain text", fmt: "@" },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A number as plain decimal text, never in exponent form between 1e-20 and 1e21. */
export function plainNumber(n) {
  const s = String(n);
  if (!s.includes("e")) return s;
  const exp = Number(s.slice(s.indexOf("e") + 1));
  if (exp < 0 && exp > -21) {
    const digits = s.slice(0, s.indexOf("e")).replace(/[-.]/g, "").length;
    return n.toFixed(Math.min(100, digits - exp - 1));
  }
  return s.replace("e", "E");
}

const expText = (n, digits) => {
  const [m, e] = n.toExponential(digits).split("e");
  const mant = m.includes(".") ? m.replace(/\.?0+$/, "") : m;
  const ev = Number(e);
  return `${mant}E${ev < 0 ? "-" : "+"}${String(Math.abs(ev)).padStart(2, "0")}`;
};

/** The General format: up to 10 significant digits, no trailing zeros, exponent form from 1e11 up and below 1e-9. */
export function generalNumber(n) {
  if (!Number.isFinite(n)) return "#NUM!";
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e11 || a < 1e-9) return expText(n, 5);
  if (Number.isInteger(n)) return String(n);
  return plainNumber(Number(n.toPrecision(10)));
}

const fail = (pattern, why) => {
  throw new Error(
    `"${pattern}" is not a number format I can read${why ? ` (${why})` : ""}: use a preset (${PRESETS.map((p) => p.id).join(", ")}) or a pattern like #,##0.00, 0.0%, $#,##0 or yyyy-mm-dd.`,
  );
};

const LITERAL_OK = /[$\-+/():!^&'~{}<>= ]/;

function splitSections(pattern) {
  const out = [];
  let cur = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') {
      const end = pattern.indexOf('"', i + 1);
      if (end < 0) fail(pattern, "a quote is not closed");
      cur += pattern.slice(i, end + 1);
      i = end;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      cur += pattern.slice(i, i + 2);
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  if (out.length > 4) fail(pattern, "more than four sections");
  return out;
}

function tokenizeSection(src, pattern) {
  const toks = [];
  const lit = (text) => {
    const last = toks[toks.length - 1];
    if (last && last.t === "lit") last.v += text;
    else toks.push({ t: "lit", v: text });
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const lower = ch.toLowerCase();
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      lit(src.slice(i + 1, end));
      i = end + 1;
    } else if (ch === "\\") {
      lit(src[i + 1] ?? "");
      i += 2;
    } else if (ch === "_") {
      lit(" ");
      i += 2;
    } else if (ch === "*") {
      i += 2;
    } else if (ch === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) fail(pattern, "a bracket is not closed");
      const inner = src.slice(i + 1, end);
      if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ t: "elapsed", u: inner[0].toLowerCase(), n: inner.length });
      i = end + 1;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      toks.push({ t: "ph", v: ch });
      i++;
    } else if (ch === ".") {
      toks.push({ t: "dot" });
      i++;
    } else if (ch === ",") {
      toks.push({ t: "comma" });
      i++;
    } else if (ch === "%") {
      toks.push({ t: "pct" });
      i++;
    } else if (ch === "@") {
      toks.push({ t: "text" });
      i++;
    } else if ((ch === "E" || ch === "e") && (src[i + 1] === "+" || src[i + 1] === "-") && /[0#?]/.test(src[i + 2] ?? "")) {
      toks.push({ t: "exp", plus: src[i + 1] === "+" });
      i += 2;
    } else if (/^general/i.test(src.slice(i))) {
      toks.push({ t: "general" });
      i += 7;
    } else if (/^am\/pm/i.test(src.slice(i))) {
      toks.push({ t: "ampm", lower: src[i] === "a", short: false });
      i += 5;
    } else if (/^a\/p/i.test(src.slice(i))) {
      toks.push({ t: "ampm", lower: src[i] === "a", short: true });
      i += 3;
    } else if ("ymdhs".includes(lower)) {
      let j = i;
      while (j < src.length && src[j].toLowerCase() === lower) j++;
      toks.push({ t: "date", u: lower, n: j - i });
      i = j;
    } else if (LITERAL_OK.test(ch) || ch.charCodeAt(0) > 127) {
      lit(ch);
      i++;
    } else fail(pattern, `"${ch}" means nothing in a format; quote literal text`);
  }
  return toks;
}

function compileSection(src, pattern) {
  const toks = tokenizeSection(src, pattern);
  const has = (t) => toks.some((x) => x.t === t);
  const dateLike = toks.some((x) => x.t === "date" || x.t === "ampm" || x.t === "elapsed");
  if (dateLike) {
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].t !== "dot" || !(toks[k - 1]?.t === "date" && toks[k - 1].u === "s")) continue;
      let n = 0;
      while (toks[k + 1 + n]?.t === "ph" && toks[k + 1 + n].v === "0") n++;
      if (n) toks.splice(k, n + 1, { t: "frac", n });
    }
  }
  const numLike = has("ph");
  if (dateLike && numLike) fail(pattern, "it mixes date and number placeholders");
  if (dateLike) {
    const dates = toks.filter((x) => x.t === "date" || x.t === "elapsed");
    for (let k = 0; k < dates.length; k++) {
      const x = dates[k];
      if (x.u !== "m" || x.t !== "date") continue;
      const prev = dates[k - 1];
      const next = dates[k + 1];
      x.minute = (prev && prev.u === "h") || (next && next.u === "s");
    }
    if (toks.some((x) => x.t === "ph" || x.t === "pct" || x.t === "exp")) fail(pattern, "it mixes date and number placeholders");
    const ampm = has("ampm");
    const hasDate = toks.some((x) => x.t === "date" && (x.u === "y" || x.u === "d" || (x.u === "m" && !x.minute)));
    const hasTime = toks.some((x) => (x.t === "date" && (x.u === "h" || x.u === "s" || x.minute)) || x.t === "elapsed" || x.t === "ampm");
    const frac = toks.find((x) => x.t === "frac")?.n ?? 0;
    return { kind: hasDate && hasTime ? "datetime" : hasDate ? "date" : "time", toks, ampm, frac };
  }
  if (has("text")) {
    if (numLike) fail(pattern, "@ and number placeholders do not mix");
    return { kind: "text", toks };
  }
  if (has("general")) return { kind: "general", toks };
  if (!numLike) {
    if (has("dot") || has("comma") || has("pct")) toks.forEach((x, k) => x.t !== "lit" && (toks[k] = { t: "lit", v: x.t === "dot" ? "." : x.t === "comma" ? "," : "%" }));
    return { kind: "literal", toks };
  }
  const expAt = toks.findIndex((x) => x.t === "exp");
  const numToks = expAt < 0 ? toks : toks.slice(0, expAt);
  const dotAt = numToks.findIndex((x) => x.t === "dot");
  const intEnd = dotAt < 0 ? numToks.length : dotAt;
  const intPh = [];
  const decPh = [];
  numToks.forEach((x, k) => {
    if (x.t !== "ph") return;
    (k < intEnd ? intPh : decPh).push(k);
  });
  const firstInt = intPh[0] ?? -1;
  const lastInt = intPh[intPh.length - 1] ?? -1;
  let grouping = false;
  let scale = 0;
  numToks.forEach((x, k) => {
    if (x.t !== "comma") return;
    if (k > firstInt && k < lastInt && firstInt >= 0) grouping = true;
  });
  numToks.forEach((x, k) => {
    if (x.t === "comma" && k > lastInt && !(k > firstInt && k < lastInt)) scale++;
  });
  for (let k = dotAt + 1; dotAt >= 0 && k < numToks.length; k++) if (numToks[k].t === "dot") numToks[k] = { t: "lit", v: "." };
  const expPh = expAt < 0 ? [] : toks.slice(expAt + 1).filter((x) => x.t === "ph");
  return {
    kind: expAt >= 0 ? "scientific" : has("pct") ? "percent" : "number",
    toks,
    intPh,
    decPh,
    dotAt,
    expAt,
    expDigits: expPh.filter((x) => x.v === "0").length || 1,
    pct: toks.filter((x) => x.t === "pct").length,
    grouping,
    scale,
  };
}

const compiled = new Map();

/** The compiled sections of a pattern; throws a sentence when the pattern cannot be read. */
export function compileFormat(pattern) {
  const hit = compiled.get(pattern);
  if (hit) {
    if (hit.error) throw hit.error;
    return hit;
  }
  let out;
  try {
    if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 200) fail(String(pattern), "it is empty or too long");
    const sections = splitSections(pattern).map((s) => compileSection(s, pattern));
    out = { sections };
  } catch (e) {
    out = { error: e };
  }
  if (compiled.size > 2000) compiled.clear();
  compiled.set(pattern, out);
  if (out.error) throw out.error;
  return out;
}

/** The pattern a preset name or a pattern stands for (null for general); throws a sentence for one it cannot read. */
export function resolveFormat(nameOrPattern) {
  if (nameOrPattern === null || nameOrPattern === undefined) return null;
  if (typeof nameOrPattern !== "string") throw new Error("A number format is a preset name or a pattern like #,##0.00.");
  const t = nameOrPattern.trim();
  if (!t) return null;
  const preset = PRESETS.find((p) => p.id === t.toLowerCase() || p.label.toLowerCase() === t.toLowerCase());
  if (preset) return preset.fmt;
  const sections = compileFormat(t).sections;
  if (sections.length === 1 && sections[0].kind === "literal" && /^[a-z ]+$/i.test(t)) fail(t);
  return sections.length === 1 && sections[0].kind === "general" && /^general$/i.test(t) ? null : t;
}

const safeCompile = (fmt) => {
  try {
    return compileFormat(fmt);
  } catch {
    return null;
  }
};

/** What kind of format a pattern is: general, number, percent, scientific, date, time, datetime, text or literal. */
export function formatKind(fmt) {
  if (!fmt) return "general";
  return safeCompile(fmt)?.sections[0].kind ?? "general";
}

/** Whether the pattern shows a date or a time. */
export const isDateFormat = (fmt) => {
  const k = formatKind(fmt);
  return k === "date" || k === "time" || k === "datetime";
};

/** Where a value sits in its cell: numbers right, booleans and errors centred, text left. */
export function alignOf(value) {
  if (typeof value === "number") return "right";
  if (typeof value === "boolean" || (value && typeof value === "object" && typeof value.err === "string")) return "center";
  return "left";
}

function roundTo(v, d) {
  if (d > 15) d = 15;
  const m = 10 ** d;
  return Math.round(Number((v * m).toPrecision(15))) / m;
}

function groupDigits(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function fillInt(digits, phs) {
  const out = new Array(phs.length).fill("");
  let d = digits.length - 1;
  for (let k = phs.length - 1; k >= 0; k--) {
    const kind = phs[k];
    if (d >= 0) out[k] = digits[d--];
    else out[k] = kind === "0" ? "0" : kind === "?" ? " " : "";
  }
  if (d >= 0 && phs.length) out[0] = digits.slice(0, d + 1) + out[0];
  return out;
}

function formatNumberSection(sec, a) {
  const { toks } = sec;
  let v = a * 100 ** sec.pct / 1000 ** sec.scale;
  let exponent = 0;
  if (sec.expAt >= 0) {
    const intN = Math.max(1, sec.intPh.length);
    if (v !== 0) {
      exponent = Math.floor(Math.log10(v)) - (intN - 1);
      v = v / 10 ** exponent;
      if (roundTo(v, sec.decPh.length) >= 10 ** intN) {
        exponent += 1;
        v /= 10;
      }
    }
  }
  const fixed = roundTo(v, sec.decPh.length).toFixed(sec.decPh.length);
  const [ip, fp = ""] = fixed.split(".");
  const intDigits = ip === "0" ? "" : ip;
  const intKinds = sec.intPh.map((k) => toks[k].v);
  let intOut = fillInt(intDigits, intKinds);
  if (sec.grouping && intOut.length) {
    const joined = intOut.join("");
    const lead = joined.match(/^ */)[0];
    intOut = [lead + groupDigits(joined.slice(lead.length)), ...intOut.slice(1).map(() => "")];
  }
  const decKinds = sec.decPh.map((k) => toks[k].v);
  const decOut = decKinds.map((_, k) => fp[k] ?? "0");
  for (let k = decOut.length - 1; k >= 0; k--) {
    if (decOut[k] !== "0") break;
    if (decKinds[k] === "#") decOut[k] = "";
    else if (decKinds[k] === "?") decOut[k] = " ";
    else break;
  }
  const byTok = new Map();
  sec.intPh.forEach((k, j) => byTok.set(k, intOut[j]));
  sec.decPh.forEach((k, j) => byTok.set(k, decOut[j]));
  let out = "";
  let inExp = false;
  let expPhSeen = false;
  for (let k = 0; k < toks.length; k++) {
    const x = toks[k];
    if (x.t === "lit") out += x.v;
    else if (x.t === "pct") out += "%";
    else if (x.t === "dot") {
      if (!sec.intPh.length && intDigits) out += intDigits;
      out += ".";
    } else if (x.t === "exp") {
      inExp = true;
      out += `E${exponent < 0 ? "-" : x.plus ? "+" : ""}`;
    } else if (x.t === "ph") {
      if (inExp) {
        if (!expPhSeen) out += String(Math.abs(exponent)).padStart(sec.expDigits, "0");
        expPhSeen = true;
      } else out += byTok.get(k) ?? "";
    }
  }
  return out;
}

function formatDateSection(sec, v) {
  const scale = 10 ** sec.frac;
  const total = Math.round(v * 86400 * scale) / scale;
  const days = Math.floor(total / 86400);
  const secsOfDay = total - days * 86400;
  const p = fromSerial(days);
  const h = Math.floor(secsOfDay / 3600);
  const mi = Math.floor((secsOfDay % 3600) / 60);
  const sFull = secsOfDay - h * 3600 - mi * 60;
  const s = Math.floor(sFull + 1e-9);
  const pad = (n, w) => String(n).padStart(w, "0");
  let out = "";
  for (const x of sec.toks) {
    if (x.t === "lit") out += x.v;
    else if (x.t === "dot") out += ".";
    else if (x.t === "comma") out += ",";
    else if (x.t === "frac") out += "." + pad(Math.round((sFull - s) * scale), x.n);
    else if (x.t === "ampm") {
      const pm = h >= 12;
      const word = x.short ? (pm ? "P" : "A") : pm ? "PM" : "AM";
      out += x.lower ? word.toLowerCase() : word;
    } else if (x.t === "elapsed") {
      const n = x.u === "h" ? Math.floor(total / 3600) : x.u === "m" ? Math.floor(total / 60) : Math.floor(total);
      out += pad(n, x.n);
    } else if (x.t === "date") {
      if (x.u === "y") out += x.n <= 2 ? pad(p.y % 100, 2) : String(p.y);
      else if (x.u === "m" && x.minute) out += x.n >= 2 ? pad(mi, 2) : String(mi);
      else if (x.u === "m") out += x.n >= 5 ? MONTHS[p.m - 1][0] : x.n === 4 ? MONTHS[p.m - 1] : x.n === 3 ? MONTHS[p.m - 1].slice(0, 3) : x.n === 2 ? pad(p.m, 2) : String(p.m);
      else if (x.u === "d") out += x.n >= 4 ? DAYS[p.weekday] : x.n === 3 ? DAYS[p.weekday].slice(0, 3) : x.n === 2 ? pad(p.d, 2) : String(p.d);
      else if (x.u === "h") {
        const hh = sec.ampm ? h % 12 || 12 : h;
        out += x.n >= 2 ? pad(hh, 2) : String(hh);
      } else if (x.u === "s") out += x.n >= 2 ? pad(s, 2) : String(s);
    }
  }
  return out;
}

const textOf = (sec, s) => sec.toks.map((x) => (x.t === "text" ? s : x.t === "lit" ? x.v : "")).join("");

function applySection(sec, v, negativeSign) {
  if (sec.kind === "general") {
    const g = generalNumber(v);
    return sec.toks.map((x) => (x.t === "general" ? g : x.t === "lit" ? x.v : "")).join("");
  }
  if (sec.kind === "text") return generalNumber(negativeSign ? -v : v);
  if (sec.kind === "literal") return sec.toks.map((x) => x.v ?? "").join("");
  if (sec.kind === "date" || sec.kind === "time" || sec.kind === "datetime") return formatDateSection(sec, negativeSign ? -v : v);
  const body = formatNumberSection(sec, v);
  return negativeSign && /[1-9]/.test(body) ? "-" + body : body;
}

/** A value as the cell shows it through `fmt`: numbers by the pattern (General when none), text through a text
 * section, booleans as TRUE/FALSE, errors as their code, blank as "". */
export function formatValue(value, fmt) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") return typeof value.err === "string" ? value.err : "";
  const c = fmt ? safeCompile(fmt) : null;
  if (typeof value === "string") {
    if (!c) return value;
    const sec = c.sections[3] ?? c.sections.find((s) => s.kind === "text");
    return sec ? textOf(sec, value) : value;
  }
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "#NUM!";
  if (!c) return generalNumber(value);
  const secs = c.sections;
  const s0 = secs[0];
  if (s0.kind === "date" || s0.kind === "time" || s0.kind === "datetime") return formatDateSection(s0, value);
  if (value < 0 && secs.length >= 2 && secs[1].kind !== "text") return applySection(secs[1], -value, false);
  if (value === 0 && secs.length >= 3 && secs[2].kind !== "text") return applySection(secs[2], 0, false);
  return applySection(s0, Math.abs(value), value < 0);
}
