// Output bounding: applied to every tool result and every error text before it leaves the
// process, so one runaway read or search can't blow the token budget of the conversation.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const BUDGET = 32768;
const HEAD_FRACTION = 3 / 4;
const TAIL_FRACTION = 1 / 8;

// Cut `s` at or before `maxLen`, backing up to the previous newline so we never hand back
// a sliced-in-half line.
function cutOnLineBoundary(s, maxLen, fromEnd) {
  if (s.length <= maxLen) return s;
  if (!fromEnd) {
    const slice = s.slice(0, maxLen);
    const nl = slice.lastIndexOf("\n");
    return nl > 0 ? slice.slice(0, nl) : slice;
  }
  const slice = s.slice(s.length - maxLen);
  const nl = slice.indexOf("\n");
  return nl >= 0 && nl < slice.length - 1 ? slice.slice(nl + 1) : slice;
}

/**
 * Bound `text` to BUDGET characters. Under budget: returned unchanged. Over budget: the
 * whole text is spilled to tool-output/<tool>-<unix-ms>.txt under home, and a head+tail
 * excerpt plus a resumption footer is returned instead. `env` needs `.cwd` (home) and
 * `.writeFile`/`.exec` are not required; we write directly via node fs to keep this
 * dependency-free and testable without the full ToolEnv shape.
 */
export async function spill(text, toolName, env) {
  const s = String(text);
  if (s.length <= BUDGET) return s;

  const m = s.length;
  const fileName = `${toolName}-${Date.now()}.txt`;
  const relPath = `tool-output/${fileName}`;
  let writeFailed = false;
  try {
    const dir = resolve(env.cwd, "tool-output");
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, fileName), s);
  } catch {
    writeFailed = true;
  }

  const headLen = Math.floor(BUDGET * HEAD_FRACTION);
  const tailLen = Math.floor(BUDGET * TAIL_FRACTION);
  const head = cutOnLineBoundary(s, headLen, false);
  const tail = cutOnLineBoundary(s, tailLen, true);

  const marker = `[... ${m - head.length - tail.length} of ${m} characters not shown here ...]`;
  const footer = writeFailed
    ? `[This output was ${m} characters, over the ${BUDGET} limit, and writing it to ${relPath} failed, so the middle is lost.]`
    : `[This output was ${m} characters, over the ${BUDGET} limit, so all of it was written to ${relPath}. Do not repeat the call: read_path with offset and limit windows that file, and search_files with path set to it finds a line.]`;

  return [head, marker, "--- the end of the output ---", tail, footer].join("\n");
}
