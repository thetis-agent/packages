// One directory listing, the way the explorer draws it: directories first, then files, each sorted with
// `localeCompare`; dotfiles only when asked; at most 500 rows and a flag that says there were more. A
// symlink is reported as one, with what it points at, so the tree can draw the link and still know
// whether it opens as a folder; the size and time are the target's when it exists.
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { contained, etagOf, statOrFail } from "./files.js";

export const MAX_LISTED = 500;

const isDirLike = (ent) => ent.isDirectory();

/** `{ path, root, mode, entries, more }` for a directory. */
export async function list(args, env) {
  const resolved = await contained(env, args.path);
  const { absolute, display, root } = resolved;
  const st = await statOrFail(absolute, display);
  if (!st.isDirectory()) throw new Error(`${display} is not a directory.`);
  const showHidden = args.hidden === true;
  let names = await readdir(absolute, { withFileTypes: true });
  if (!showHidden) names = names.filter((e) => !e.name.startsWith("."));
  names.sort((a, b) => (isDirLike(a) === isDirLike(b) ? a.name.localeCompare(b.name) : isDirLike(a) ? -1 : 1));
  const more = names.length > MAX_LISTED;
  const shown = more ? names.slice(0, MAX_LISTED) : names;
  const entries = [];
  for (const ent of shown) {
    const row = await entryOf(absolute, ent);
    if (row) entries.push(row);
  }
  return { path: absolute, root, mode: resolved.writable ? "rw" : "ro", entries, more };
}

/** One row: kind by lstat, and for a symlink the target's kind too. Null when the entry vanished meanwhile. */
async function entryOf(dir, ent) {
  const full = join(dir, ent.name);
  const ls = await lstat(full).catch(() => null);
  if (!ls) return null;
  const hidden = ent.name.startsWith(".");
  if (ls.isSymbolicLink()) {
    const target = await stat(full).catch(() => null);
    const kind = !target ? "none" : target.isDirectory() ? "dir" : target.isFile() ? "file" : "other";
    const facts = target ?? ls;
    return { name: ent.name, kind: "symlink", target: kind, size: facts.size, mtime: new Date(facts.mtimeMs).toISOString(), etag: etagOf(facts), hidden };
  }
  const kind = ls.isDirectory() ? "dir" : ls.isFile() ? "file" : "other";
  return { name: ent.name, kind, size: ls.size, mtime: new Date(ls.mtimeMs).toISOString(), etag: etagOf(ls), hidden };
}
