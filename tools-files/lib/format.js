// Shared line-numbering used by read_path and edit_path's confirmation snippet, so both
// tools present text the same way and the model can pattern-match on it.
const MAX_LINE_CHARS = 500;

export function numberLine(n, text) {
  const t = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + "… [line truncated]" : text;
  return `${String(n).padStart(6, " ")}\t${t}`;
}

export function numberedBlock(lines, startAt) {
  return lines.map((l, i) => numberLine(startAt + i, l)).join("\n");
}

// Split text into lines without losing a trailing empty line's absence/presence info;
// we only need line contents for display, so a plain split on \n is sufficient here.
export function toLines(text) {
  return text.split("\n");
}
