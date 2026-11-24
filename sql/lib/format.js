// Rendering rows and cutting long answers, the same way @thetis/bigquery does
// so the two read alike.

export const FORMATS = new Set(["table", "csv", "json"]);

export function formatArg(v) {
  const f = String(v ?? "table").toLowerCase();
  if (!FORMATS.has(f)) throw new Error("`format` is table, csv or json");
  return f;
}

export function clip(s, n = 20_000, hint = "ask for fewer rows or columns") {
  s = String(s ?? "");
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.85), tail = n - head;
  return `${s.slice(0, head)}\n… [${s.length - n} characters cut; ${hint}] …\n${s.slice(-tail)}`;
}

function cell(v, width) {
  let s = v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
  s = s.replace(/\r?\n/g, "⏎").replace(/\|/g, "¦");
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as `table` (pipes, one line per row), `csv` or `json` (an array of objects). */
export function renderRows(rows, columns, format = "table", cellChars = 300) {
  const cols = columns?.length ? columns : rows[0] ? Object.keys(rows[0]) : [];
  if (format === "json") return JSON.stringify(rows);
  if (format === "csv") return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  return [cols.join(" | "), ...rows.map((r) => cols.map((c) => cell(r[c], cellChars)).join(" | "))].join("\n");
}

export function bytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, x = v;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${i ? x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0) : x} ${units[i]}`;
}

export function ms(n) {
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
}
