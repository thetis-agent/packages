// write_path: create or overwrite a file, atomically, refusing accidental overwrites so
// the model has to opt in explicitly once a file already exists.
import { readFile, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { resolveContained, writeRefusal } from "./paths.js";

async function atomicWrite(absolute, content) {
  await mkdir(dirname(absolute), { recursive: true });
  const tmp = resolve(dirname(absolute), `.${basename(absolute)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, content);
  await rename(tmp, absolute).catch(async (e) => {
    await unlink(tmp).catch(() => {});
    throw e;
  });
}

export async function writePath(args, env) {
  const resolved = await resolveContained(env, args.path, { write: true });
  const { absolute, display } = resolved;
  const contents = String(args.contents ?? "");
  const overwrite = Boolean(args.overwrite);

  let exists = true;
  let st;
  try {
    st = await stat(absolute);
  } catch (e) {
    if (e.code === "ENOENT") exists = false;
    else throw e;
  }

  if (exists) {
    if (st.isDirectory()) throw new Error(`${display} is a directory, not a file.`);
    if (!overwrite) {
      const prior = await readFile(absolute, "utf8").catch(() => "");
      const lines = prior === "" ? 0 : prior.split("\n").length;
      throw new Error(`${display} exists (${lines} lines). Use edit_path to change part of it, or pass overwrite to replace it.`);
    }
  }

  // The containment check above says this path is writable. When the filesystem disagrees anyway, that
  // disagreement is the thing worth reporting, not the errno. See `writeRefusal`.
  try {
    await atomicWrite(absolute, contents);
  } catch (e) {
    throw writeRefusal(e, resolved) ?? e;
  }
  const bytes = Buffer.byteLength(contents, "utf8");
  const lines = contents === "" ? 0 : contents.split("\n").length;
  return `wrote ${display} (${lines} lines, ${bytes} bytes)`;
}
