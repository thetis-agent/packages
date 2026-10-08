/* Copy and paste as text: what goes out is the selection's display values as tab-separated rows, which any
 * spreadsheet or text field takes; what comes in is split into rows and cells (tabs, or commas when every
 * line has the same number of them, else one cell per line) and each piece read the way typing reads it.
 * Alongside the text the page keeps a private copy of the same block — raw values and styles — and when the
 * text pasted is exactly the text copied, the private copy is pasted instead, with formulas moved by the
 * distance between where they were and where they land (a cut moves them unchanged). Pure apart from the
 * module's one private copy. */

import { addr, parseAddr } from "./core/address.js";
import { parseDelimited } from "./core/csv.js";
import { translate } from "./core/formula.js";

let privateCopy = null; // { text, sheet, tab, range, cells: { "dr:dc": raw }, styles: { "dr:dc": style }, cut }

const normal = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "");

/** A cell's display text made safe for a TSV line. */
function cellText(text) {
  const s = String(text ?? "");
  return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Remembers the block and answers its TSV. `tab` is the tab ({ id, cells, styles }), `display(r, c)` the text
 * a cell shows.
 */
export function copyBlock({ sheet, tab, range, display, cut = false }) {
  const lines = [];
  const cells = {};
  const styles = {};
  for (let r = range.r1; r <= range.r2; r++) {
    const row = [];
    for (let c = range.c1; c <= range.c2; c++) row.push(cellText(display(r, c)));
    lines.push(row.join("\t"));
  }
  const inRange = (key) => {
    const p = parseAddr(key);
    return p && p.row >= range.r1 && p.row <= range.r2 && p.col >= range.c1 && p.col <= range.c2 ? p : null;
  };
  for (const [key, raw] of Object.entries(tab.cells ?? {})) {
    const p = inRange(key);
    if (p) cells[`${p.row - range.r1}:${p.col - range.c1}`] = raw;
  }
  for (const [key, style] of Object.entries(tab.styles ?? {})) {
    const p = inRange(key);
    if (p) styles[`${p.row - range.r1}:${p.col - range.c1}`] = style;
  }
  const text = lines.join("\n");
  privateCopy = { text, sheet, tab: tab.id, range: { ...range }, cells, styles, cut };
  return text;
}

export const lastCopy = () => privateCopy;
export function forgetCopy() {
  privateCopy = null;
}

/** Rows of strings from pasted text. */
export function splitPasted(text) {
  const t = normal(text);
  if (!t) return [[""]];
  if (t.includes("\t")) return parseDelimited(t, { delimiter: "\t" });
  const lines = t.split("\n");
  const commas = lines.map((l) => (l.match(/,/g) ?? []).length);
  if (lines.length > 1 && commas[0] > 0 && commas.every((n) => n === commas[0])) return parseDelimited(t, { delimiter: "," });
  return lines.map((l) => [l]);
}

/**
 * What a paste writes: `{ cells: { A1: raw|null }, fmts, styles: [[addr, style]], range, from? }` for the
 * pasted text at the selection `sel`. The private copy is used when its text is the text pasted; a block
 * pasted over a selection that is a whole multiple of it is repeated to fill it.
 */
export function pastePlan(text, sel, parseInput) {
  const copy = privateCopy && normal(privateCopy.text) === normal(text) ? privateCopy : null;
  const rows = copy ? copy.range.r2 - copy.range.r1 + 1 : null;
  const grid = copy ? null : splitPasted(text);
  const h = copy ? rows : grid.length;
  const w = copy ? copy.range.c2 - copy.range.c1 + 1 : Math.max(...grid.map((r) => r.length));
  const sh = sel.r2 - sel.r1 + 1;
  const sw = sel.c2 - sel.c1 + 1;
  const reps = { r: sh % h === 0 ? sh / h : 1, c: sw % w === 0 ? sw / w : 1 };
  const cells = {};
  const fmts = {};
  const styles = [];
  for (let ry = 0; ry < reps.r; ry++) {
    for (let rx = 0; rx < reps.c; rx++) {
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) {
          const r = sel.r1 + ry * h + dr;
          const c = sel.c1 + rx * w + dc;
          const key = addr(r, c);
          if (copy) {
            let raw = copy.cells[`${dr}:${dc}`];
            if (typeof raw === "string" && raw.startsWith("=") && !copy.cut) raw = translate(raw, r - (copy.range.r1 + dr), c - (copy.range.c1 + dc));
            cells[key] = raw === undefined ? null : raw;
            styles.push([key, copy.styles[`${dr}:${dc}`] ?? null]);
          } else {
            const parsed = parseInput(String(grid[dr]?.[dc] ?? ""));
            cells[key] = parsed.raw ?? null;
            if (parsed.fmt) fmts[key] = parsed.fmt;
          }
        }
      }
    }
  }
  return { cells, fmts, styles: copy ? styles : [], range: { r1: sel.r1, c1: sel.c1, r2: sel.r1 + h * reps.r - 1, c2: sel.c1 + w * reps.c - 1 }, from: copy };
}
