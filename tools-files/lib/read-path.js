// read_path: a bounded, line-numbered file reader. The two-bound (lines and bytes) logic
// lives here because both the line window and the byte budget can be the thing that stops
// the read, and the footer text has to say which one it was.
import { readFile, stat } from "node:fs/promises";
import { resolveContained } from "./paths.js";
import { looksBinary } from "./walk.js";
import { numberLine } from "./format.js";

const BYTE_BUDGET = 24000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 2000;

export async function readPath(args, env) {
  const { absolute, display } = await resolveContained(env, args.path, { write: false });

  let st;
  try {
    st = await stat(absolute);
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`${display} does not exist.`);
    throw e;
  }
  if (st.isDirectory()) throw new Error(`${display} is a directory; use get_directory.`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`${display} is ${st.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit.`);
  }

  const buf = await readFile(absolute);
  if (await looksBinary(buf)) throw new Error(`${display} looks like a binary file (a NUL byte in the first 8 KiB); refusing to read it as text.`);

  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const total = lines.length;

  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || DEFAULT_LIMIT));

  const out = [];
  let bytes = 0;
  let stoppedOnBytes = false;
  let lastLine = offset - 1;
  for (let i = offset; i <= total && out.length < limit; i++) {
    const rendered = numberLine(i, lines[i - 1]);
    const size = Buffer.byteLength(rendered, "utf8") + 1;
    if (bytes + size > BYTE_BUDGET && out.length > 0) {
      stoppedOnBytes = true;
      break;
    }
    out.push(rendered);
    bytes += size;
    lastLine = i;
  }

  const footer = lastLine >= total
    ? `[lines ${offset}-${total} of ${total}]`
    : `[lines ${offset}-${lastLine} of ${total}; read on with offset ${lastLine + 1}]${stoppedOnBytes ? " (stopped at the output size limit)" : ""}`;

  return [out.join("\n"), footer].join("\n\n");
}
