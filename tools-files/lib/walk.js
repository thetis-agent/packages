// A bounded directory walker shared by search_files, find_files and get_directory, so the
// skip list and the file-count cap live in exactly one place.
import { readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "target", ".cache", "tool-output"]);
export const SCAN_BOUND = 20000;

// A NUL in the first 8 KiB marks a file as binary; used to skip binary files during scans
// and to refuse binary reads in read_path.
export async function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk `root` yielding { path, name, stat } for files, skipping SKIP_DIRS, never visiting
 * more than SCAN_BOUND entries. Returns { hitBound } via the `state` object passed in so
 * callers can report a partial scan.
 */
export async function* walkFiles(root, state) {
  state.visited = state.visited ?? 0;
  state.hitBound = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than fail the whole walk
    }
    for (const ent of entries) {
      if (state.visited >= SCAN_BOUND) {
        state.hitBound = true;
        return;
      }
      state.visited++;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        yield { path: full, name: ent.name, stat: st };
      }
    }
  }
}

// Compile a shell-style glob (`*` any run, `?` one char, no `/` unless the glob has one)
// into a RegExp. Kept tiny on purpose: this is the only glob syntax the file tools need.
export function globToRegExp(glob) {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re);
}
