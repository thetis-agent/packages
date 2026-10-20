/* A line diff, for a proposal's change against what was there before it. Pure, so a test needs no DOM.
 * The longest common subsequence of lines; past LIMIT lines on either side it gives up and answers the
 * whole of each, removed then added, which is still true, only less helpful. */

const LIMIT = 2000;
export const CONTEXT = 3;

/** `[{ op: " " | "-" | "+", text }]` turning `before` into `after`. */
export function lineDiff(before, after) {
  // An empty side has no lines, not one empty line that would show as context between the added ones.
  const lines = (t) => (String(t ?? "") === "" ? [] : String(t).split("\n"));
  const a = lines(before);
  const b = lines(after);
  if (a.length > LIMIT || b.length > LIMIT) return [...a.map((text) => ({ op: "-", text })), ...b.map((text) => ({ op: "+", text }))];
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the length of the common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

/** The diff with long unchanged runs folded to `{ op: "…", count }`, keeping CONTEXT lines around each change. */
export function folded(lines, context = CONTEXT) {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "…", count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: "…", count: skipped });
  return out;
}
