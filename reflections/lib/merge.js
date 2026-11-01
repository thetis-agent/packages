// A three-way line merge, for a proposal whose file moved since it was written: the proposal's change
// (before → change) is laid over what is there now (before → current). Deterministic and free, so an
// out-of-date proposal is updated without a model; anything it cannot place cleanly is the person's, in Edit.
//
// The line diff is the place's own (`ui/diff.js`, the longest common subsequence of lines): the browser can
// read only `ui/`, so the one copy lives there and this file imports it.
import { lineDiff } from "../ui/diff.js";

/** Past this, on any side, the merge does not try. */
export const MERGE_BYTES = 256 * 1024;

const lines = (t) => (t === "" ? [] : t.split("\n"));

/** The hunks of `before → after`: `{ s, e, lines }`, lines `s..e` of `before` replaced by `lines`. */
export function hunks(before, after) {
  const out = [];
  let i = 0;
  let open = null;
  for (const l of lineDiff(before, after)) {
    if (l.op === " ") {
      if (open) out.push(open);
      open = null;
      i++;
      continue;
    }
    open ??= { s: i, e: i, lines: [] };
    if (l.op === "-") open.e = ++i;
    else open.lines.push(l.text);
  }
  if (open) out.push(open);
  return out;
}

const same = (a, b) => a.s === b.s && a.e === b.e && a.lines.length === b.lines.length && a.lines.every((x, k) => x === b.lines[k]);

/**
 * Whether two hunks touch the same lines of `before` (`base`, its lines). Two insertions at one point do,
 * except at the end of a file that has text: both sides added a section, and both are kept, today's first.
 */
function overlaps(a, b, base) {
  const ins = (h) => h.s === h.e;
  if (ins(a) && ins(b)) return a.s === b.s && !(base.slice(a.s).every((l) => l === "") && base.slice(0, a.s).some((l) => l.trim() !== ""));
  if (ins(a)) return b.s < a.s && a.s < b.e;
  if (ins(b)) return a.s < b.s && b.s < a.e;
  return a.s < b.e && b.s < a.e;
}

/**
 * `merge3(before, change, current)` → `{ ok: true, text }` | `{ ok: false }`. The change's hunks apply only
 * when none overlaps a hunk of the current file; a hunk both sides made alike is taken once. A new file
 * (nothing before) that exists now conflicts unless both sides wrote the same. Over
 * MERGE_BYTES on any side, or a side that is not text, answers `{ ok: false }`.
 */
export function merge3(before, change, current) {
  const sides = [before ?? "", change ?? "", current ?? ""];
  if (sides.some((t) => typeof t !== "string" || Buffer.byteLength(t, "utf8") > MERGE_BYTES)) return { ok: false };
  const [b, c, n] = sides;
  if (c === b || c === n) return { ok: true, text: n };
  if (n === b) return { ok: true, text: c };
  const base = lines(b);
  const ours = hunks(b, n);
  const theirs = hunks(b, c).filter((h) => !ours.some((o) => same(o, h)));
  for (const h of theirs) if (ours.some((o) => overlaps(o, h, base))) return { ok: false };
  // In order of where they start; at one point an insertion goes first, and the current file's before the change's.
  const all = [...ours.map((h) => ({ ...h, side: 0 })), ...theirs.map((h) => ({ ...h, side: 1 }))].sort(
    (x, y) => x.s - y.s || (x.e - x.s) - (y.e - y.s) || x.side - y.side,
  );
  const out = [];
  let pos = 0;
  for (const h of all) {
    out.push(...base.slice(pos, h.s), ...h.lines);
    pos = h.e;
  }
  out.push(...base.slice(pos));
  return { ok: true, text: out.join("\n") };
}
