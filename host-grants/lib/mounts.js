// Mounts: what a mount list looks like when it arrives, what the host holds at each path now, and the
// directory listing a picker needs. The store itself is the kernel's record (`env.records.mounts`).
import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assert } from "./error.js";

/**
 * A mount list as it arrives from a socket: at most 32 entries, absolute normalized paths (so no `..`),
 * mode `rw` or `ro`. Answers `{ path, mode }[]`.
 */
export function parseMountList(raw) {
  assert(Array.isArray(raw) && raw.length <= 32, "mounts must be a list of at most 32 entries", "invalid");
  return raw.map((m) => {
    const path = String(m?.path ?? "");
    assert(path !== "/" && path === resolve(path), `invalid mount path: ${path} (absolute and normalized, not /)`, "invalid");
    assert(m?.mode === "rw" || m?.mode === "ro", `invalid mount mode for ${path}: ${String(m?.mode)} (rw or ro)`, "invalid");
    return { path, mode: m.mode };
  });
}

/**
 * One person's mounts with what the host says about each path now: `present` is true only for a
 * directory, `kind` is `dir`, `file` or `none`. `present` is what the fence will actually bind (a mount
 * whose path is gone is skipped when the fence opens), so a caller can tell a mount that works from one
 * that is only written down.
 */
export function withPresence(mounts) {
  return mounts.map((m) => {
    const stat = statOf(m.path);
    return { ...m, present: stat === "dir", kind: stat };
  });
}

/** What one host path is: a directory, something else, or nothing. */
export function statOf(path) {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return "none";
  }
}

/**
 * The directories directly under `path`, for a picker: `{ path, parent, kind, readable, truncated, entries }`,
 * `parent` null at the root and each entry `{ name, path }`. Hidden names are left out unless `all`. The
 * listing is capped, sorted by name, and never throws for a path that is missing or unreadable: it answers
 * what is true about the path so the caller can say so.
 */
export function browseDirectories(path, { limit = 500, all = false } = {}) {
  assert(isAbsolute(path) && path === resolve(path), `a path to browse is absolute and normalized: ${path}`);
  const kind = statOf(path);
  const parent = path === "/" ? null : dirname(path);
  if (kind !== "dir") return { path, parent, kind, readable: false, truncated: false, entries: [] };
  let names;
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch {
    return { path, parent, kind, readable: false, truncated: false, entries: [] };
  }
  const dirs = names
    .filter((e) => (all || !e.name.startsWith(".")) && isDir(path, e))
    .map((e) => ({ name: e.name, path: join(path, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent, kind, readable: true, truncated: dirs.length > limit, entries: dirs.slice(0, limit) };
}

/** A symlink is followed once, so a link to a directory is one. An unreadable entry is not. */
function isDir(dir, entry) {
  if (entry.isDirectory()) return true;
  return entry.isSymbolicLink() && statOf(join(dir, entry.name)) === "dir";
}
