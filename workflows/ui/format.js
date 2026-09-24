/* Numbers and times in words, and the validator's issues sorted for display. DOM-free. */

/** "$13.61"; "$0.004" for a fraction of a cent so a cheap step does not read as free. */
export function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.00";
  if (v > 0 && v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** 540000 -> "9 min", 45000 -> "45 s", 3900000 -> "1 h 5 min". */
export function duration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return "";
  const s = Math.round(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "just now", "5 min ago", "3 h ago", else a short date. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = now - t;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The runs an input text queues: one per non-empty line for `lines`, one for any non-blank `text`. */
export function inputRuns(kind, text) {
  const t = String(text ?? "");
  if (kind === "lines") return t.split("\n").filter((l) => l.trim()).length;
  return t.trim() ? 1 : 0;
}

/** "3 lines, 3 runs" / "1 run" / "Nothing to queue yet". */
export function inputCount(kind, text) {
  const n = inputRuns(kind, text);
  if (!n) return "Nothing to queue yet";
  if (kind === "lines") return `${n} ${n === 1 ? "line" : "lines"}, ${n} ${n === 1 ? "run" : "runs"}`;
  return "1 run";
}

/**
 * The validator's issues, sorted for display: errors first, and grouped by step for the canvas markers.
 * Returns `{ errors, warns, list, byStep: { [id]: "error"|"warn" } }`.
 */
export function sortIssues(issues) {
  const list = (Array.isArray(issues) ? issues : []).filter((i) => i && typeof i.message === "string");
  const rank = (i) => (i.level === "error" ? 0 : 1);
  const sorted = list.map((x, n) => [x, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((p) => p[0]);
  const byStep = {};
  for (const i of sorted) if (i.step && byStep[i.step] !== "error") byStep[i.step] = i.level === "error" ? "error" : "warn";
  return { errors: list.filter((i) => i.level === "error").length, warns: list.filter((i) => i.level !== "error").length, list: sorted, byStep };
}

/** A positive number from a form field, or undefined when the field is empty or not one. "250k" and "1.5M" are read too. */
export function positive(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/,/g, "");
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(t);
  if (!m) return undefined;
  const v = Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
  return v > 0 ? v : undefined;
}
