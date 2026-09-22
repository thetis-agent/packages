// edit_path: exact-match search-and-replace, written atomically so a crash mid-write
// never leaves a half-written file behind.
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { resolveContained, writeRefusal } from "./paths.js";
import { numberLine } from "./format.js";

function countOccurrences(hay, needle) {
  if (needle === "") return 0;
  let count = 0, idx = 0;
  for (;;) {
    idx = hay.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function lineOfOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === "\n") line++;
  return line;
}

async function atomicWrite(absolute, content) {
  const tmp = resolve(dirname(absolute), `.${basename(absolute)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, content);
  await rename(tmp, absolute).catch(async (e) => {
    await unlink(tmp).catch(() => {});
    throw e;
  });
}

export async function editPath(args, env) {
  const resolved = await resolveContained(env, args.path, { write: true });
  const { absolute, display } = resolved;
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  const replaceAll = Boolean(args.replace_all);

  if (oldText === "") throw new Error("old_text must not be empty.");
  if (oldText === newText) throw new Error("old_text and new_text are identical; nothing to edit.");

  let st;
  try {
    st = await stat(absolute);
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`${display} does not exist.`);
    throw e;
  }
  if (st.isDirectory()) throw new Error(`${display} is a directory, not a file.`);

  const text = await readFile(absolute, "utf8");
  const occurrences = countOccurrences(text, oldText);
  if (occurrences === 0) {
    throw new Error(`old_text was not found in ${display}. Read the file first — whitespace and indentation must match exactly.`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`old_text appears ${occurrences} times in ${display}. Include enough surrounding lines to make it unique, or pass replace_all to change every occurrence.`);
  }

  const firstAt = text.indexOf(oldText);
  const firstLine = lineOfOffset(text, firstAt);

  const updated = replaceAll ? text.split(oldText).join(newText) : text.slice(0, firstAt) + newText + text.slice(firstAt + oldText.length);
  // The containment check above says this path is writable. When the filesystem disagrees anyway, that
  // disagreement is the thing worth reporting, not the errno. See `writeRefusal`.
  try {
    await atomicWrite(absolute, updated);
  } catch (e) {
    throw writeRefusal(e, resolved) ?? e;
  }

  const snippet = buildSnippet(updated, firstLine, newText);
  const n = replaceAll ? occurrences : 1;
  return `edited ${display} — replaced ${n} occurrence(s) starting at line ${firstLine}\n\n${snippet}`;
}

// 4 lines of context before and after the first change, numbered like read_path.
function buildSnippet(updatedText, firstLine, newText) {
  const lines = updatedText.split("\n");
  const newTextLines = newText.split("\n").length;
  const start = Math.max(1, firstLine - 4);
  const end = Math.min(lines.length, firstLine + newTextLines - 1 + 4);
  const out = [];
  for (let i = start; i <= end; i++) out.push(numberLine(i, lines[i - 1]));
  return out.join("\n");
}
