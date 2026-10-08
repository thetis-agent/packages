// What `sheet_read` answers, as text a model reads well: one line for the sheet and its tabs, what the
// person changed lately (so the agent sees their edits before it writes over them), then a range as a
// Markdown table of the values the person sees, with row numbers and column letters, then every formula in
// it with its result, the errors with their messages, and on request the formatting. Bounded at about
// 40,000 characters; a cut answer names the range to read next.
import { addr, colName, parseQualified, parseRange, quoteTab, rangeText } from "../ui/core/address.js";
import { compute } from "../ui/core/engine.js";
import { isError } from "../ui/core/values.js";
import { usedRange } from "../ui/core/workbook.js";
import { fail } from "./store.js";
import { displayOf } from "./transfer.js";

export const BUDGET = 40_000;
const TABLE_BUDGET = 30_000;
const MAX_COLUMNS = 52;
const CELL_CHARS = 200;
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_MAX = 8;

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** `Sheet1!A1:C4`, with the tab quoted when its name needs it. */
export const qualified = (tabName, range) => `${quoteTab(tabName)}!${typeof range === "string" ? range : rangeText(range)}`;

/** A tab as the header line shows it: `Name (A1:F40, 212 cells)` or `Name (empty)`. */
export function tabLine(tab) {
  const used = usedRange(tab);
  const n = Object.keys(tab.cells).length;
  return used ? `${tab.name} (${rangeText(used)}, ${plural(n, "cell")})` : `${tab.name} (empty)`;
}

/** A Change's ranges as text, a deleted tab named by its id. */
export function changeRanges(workbook, change) {
  const names = new Map(workbook.tabs.map((t) => [t.id, t.name]));
  return (change.ranges ?? []).map((r) => qualified(names.get(r.tab) ?? r.tab, r.range)).join(", ") || "the sheet";
}

/** The person's own Changes from the last day, newest first, as lines. */
export function recentByPerson(workbook, now = Date.now()) {
  return (workbook.changes ?? [])
    .filter((c) => c.by === "person" && now - Date.parse(c.at) <= RECENT_MS)
    .reverse()
    .slice(0, RECENT_MAX)
    .map((c) => `- ${ago(c.at, now)}: ${changeRanges(workbook, c)} — ${c.what} (rev ${c.rev})`);
}

/** A value fit for one table cell: pipes escaped, newlines shown as ⏎, long text cut. */
const cellText = (text) => {
  const flat = String(text).replace(/\r\n|\r|\n/g, "⏎");
  const cut = flat.length > CELL_CHARS ? `${flat.slice(0, CELL_CHARS)}…` : flat;
  return cut.replace(/\|/g, "\\|");
};

/**
 * The tab and range a read or a format means: `range` may name its tab (`'Q3'!A1:B2`), else `tabRef` (or
 * the first tab). Whole rows and columns are clipped to the tab's size.
 */
export function rangeIn(workbook, tabRef, text, resolveTab) {
  const { tab: named, range } = typeof text === "string" && text.trim() ? parseQualified(text.trim()) : { tab: null, range: null };
  const tab = resolveTab(workbook, named ?? tabRef);
  if (range === null) return { tab, range: null };
  const parsed = parseRange(range, { rows: tab.rows, cols: tab.cols });
  if (!parsed) fail(`${JSON.stringify(text)} is not a range in A1 notation like A1:F40, B:B or 3:10.`);
  return { tab, range: parsed };
}

/** Style keys as words. */
export function styleWords(style) {
  const out = [];
  if (style.b) out.push("bold");
  if (style.i) out.push("italic");
  if (style.u) out.push("underline");
  if (style.s) out.push("strikethrough");
  if (style.color) out.push(`color ${style.color}`);
  if (style.fill) out.push(`fill ${style.fill}`);
  if (style.align) out.push(`align ${style.align}`);
  if (style.wrap) out.push("wrap");
  if (style.fmt) out.push(`format ${JSON.stringify(style.fmt)}`);
  return out.join(", ");
}

/** The styled cells of a block as runs: same style along a row, then the same run on consecutive rows. */
function styleRuns(tab, box) {
  const runs = [];
  let open = new Map();
  for (let r = box.r1; r <= box.r2; r++) {
    const here = [];
    let run = null;
    for (let c = box.c1; c <= box.c2; c++) {
      const style = tab.styles?.[addr(r, c)];
      const key = style && Object.keys(style).length ? JSON.stringify(style) : null;
      if (run && run.key === key && key) run.c2 = c;
      else {
        if (run?.key) here.push(run);
        run = key ? { key, style, c1: c, c2: c } : null;
      }
    }
    if (run?.key) here.push(run);
    const next = new Map();
    for (const h of here) {
      const id = `${h.c1}:${h.c2}:${h.key}`;
      const prev = open.get(id);
      if (prev) {
        prev.r2 = r;
        next.set(id, prev);
      } else {
        const fresh = { r1: r, r2: r, c1: h.c1, c2: h.c2, key: h.key, style: h.style };
        runs.push(fresh);
        next.set(id, fresh);
      }
    }
    open = next;
  }
  return runs;
}

/** The whole answer of sheet_read. */
export function renderRead(workbook, { tab, range, formulas = true, styles = false, projectText, now = new Date() }) {
  const out = [];
  out.push(`Sheet ${workbook.id} ${JSON.stringify(workbook.title)} · ${projectText} · rev ${workbook.rev} · tabs: ${workbook.tabs.map(tabLine).join(", ")}`);
  const recent = recentByPerson(workbook, now.getTime());
  if (recent.length) out.push("", "Recent edits by the person:", ...recent);

  const used = usedRange(tab);
  if (!used) {
    out.push("", `${tab.name} is empty (${plural(tab.rows, "row")} × ${plural(tab.cols, "column")}).`);
    return out.join("\n");
  }
  // A range reaching past what the tab holds shows only up to its used extent: trailing blanks say nothing.
  const asked = range ?? { r1: 0, c1: 0, r2: used.r2, c2: used.c2 };
  const box = { r1: asked.r1, c1: asked.c1, r2: Math.max(asked.r1, Math.min(asked.r2, used.r2)), c2: Math.max(asked.c1, Math.min(asked.c2, used.c2)) };
  if (asked.r1 > used.r2 || asked.c1 > used.c2) {
    out.push("", `${qualified(tab.name, asked)} is empty; ${tab.name} holds ${rangeText(used)}.`);
    return out.join("\n");
  }
  const cTo = Math.min(box.c2, box.c1 + MAX_COLUMNS - 1);
  const computed = compute(workbook, { now });
  const frozen = tab.freeze?.rows || tab.freeze?.cols ? ` · frozen ${plural(tab.freeze.rows ?? 0, "row")}, ${plural(tab.freeze.cols ?? 0, "column")}` : "";

  const head = ["", ...Array.from({ length: cTo - box.c1 + 1 }, (_, i) => colName(box.c1 + i))];
  const table = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  let size = table.reduce((n, l) => n + l.length + 1, 0);
  let rTo = box.r1 - 1;
  for (let r = box.r1; r <= box.r2; r++) {
    const line = [String(r + 1)];
    for (let c = box.c1; c <= cTo; c++) line.push(cellText(displayOf(computed, tab, addr(r, c))));
    const text = `| ${line.join(" | ")} |`;
    if (r > box.r1 && size + text.length + 1 > TABLE_BUDGET) break;
    table.push(text);
    size += text.length + 1;
    rTo = r;
  }
  const shown = { r1: box.r1, c1: box.c1, r2: rTo, c2: cTo };
  out.push("", `${qualified(tab.name, shown)}${frozen}:`, ...table);

  const cut = [];
  if (rTo < box.r2) cut.push(`Rows ${box.r1 + 1}–${rTo + 1} of ${box.r1 + 1}–${box.r2 + 1} shown; read range ${rangeText({ r1: rTo + 1, c1: box.c1, r2: box.r2, c2: box.c2 })} next.`);
  if (cTo < box.c2) cut.push(`Columns ${colName(box.c1)}–${colName(cTo)} shown; read range ${rangeText({ r1: box.r1, c1: cTo + 1, r2: box.r2, c2: box.c2 })} for the rest.`);
  if (cut.length) out.push("", ...cut);

  const lines = [];
  const errors = [];
  for (let r = shown.r1; r <= shown.r2; r++) {
    for (let c = shown.c1; c <= shown.c2; c++) {
      const at = addr(r, c);
      const raw = tab.cells[at];
      const value = computed.value(tab.id, at);
      const isFormula = typeof raw === "string" && raw.startsWith("=");
      if (isFormula && formulas) lines.push(`${at} ${raw.length > 300 ? `${raw.slice(0, 300)}…` : raw} → ${displayOf(computed, tab, at) || "(blank)"}`);
      if (isError(value)) errors.push(`${at} ${value.err}${value.msg ? ` — ${value.msg}` : ""}`);
    }
  }
  let room = BUDGET - out.reduce((n, l) => n + l.length + 1, 0);
  const section = (title, list, more) => {
    if (!list.length) return;
    const kept = [];
    for (const line of list) {
      if (room - line.length - 1 < 200) break;
      kept.push(line);
      room -= line.length + 1;
    }
    out.push("", `${title}:`, ...kept);
    if (kept.length < list.length) out.push(`…and ${plural(list.length - kept.length, more)} more; read a smaller range to see them.`);
  };
  section("Formulas", lines, "formula");
  section("Errors", errors, "error");
  if (styles) {
    const runs = styleRuns(tab, shown).map((run) => `${rangeText(run)} ${styleWords(run.style)}`);
    const widths = Object.entries(tab.widths ?? {}).map(([col, px]) => `${col} ${px}`);
    const heights = Object.entries(tab.heights ?? {}).map(([row, px]) => `${row} ${px}`);
    if (widths.length) runs.push(`Column widths: ${widths.join(", ")} (others 100 px).`);
    if (heights.length) runs.push(`Row heights: ${heights.join(", ")} (others 24 px).`);
    if (!runs.length) runs.push("No formatting in this range.");
    section("Formatting", runs, "line");
  }
  return out.join("\n");
}
