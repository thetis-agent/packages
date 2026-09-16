import { readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Mount } from "@thetis/contracts";
import { assert } from "./error.js";
import { JsonFile } from "./json.js";

/** A mount and what the host holds at its path now. `present` is true only for a directory. */
export interface MountState extends Mount {
  present: boolean;
  kind: "dir" | "file" | "none";
}

/** What `browseDirectories` answers: the path itself, and the directories directly under it. */
export interface DirectoryListing {
  path: string;
  /** The parent directory, or null at the root. */
  parent: string | null;
  kind: "dir" | "file" | "none";
  /** False when the path is not a directory, or the process may not read it. */
  readable: boolean;
  truncated: boolean;
  entries: { name: string; path: string }[];
}

/** The per-user mount lists in `<home>/mounts.json`: `{ "<user>": [ { path, mode } ] }`. Who may set one is the caller's decision. */
export class MountStore {
  private readonly file: JsonFile<Record<string, Mount[]>>;

  constructor(home: string) {
    this.file = new JsonFile(resolve(home, "mounts.json"), {});
  }

  /** A copy of one person's list; empty when none. */
  get(user: string): Mount[] {
    return (this.file.value[user] ?? []).map((m) => ({ ...m }));
  }

  all(): Record<string, Mount[]> {
    return Object.fromEntries(Object.keys(this.file.value).map((u) => [u, this.get(u)]));
  }

  /** Replaces one person's list; an empty list removes the entry. */
  set(user: string, mounts: Mount[]): void {
    if (mounts.length) this.file.value[user] = mounts.map((m) => ({ path: m.path, mode: m.mode }));
    else delete this.file.value[user];
    this.file.save();
  }
}

/**
 * One person's mounts with what the host says about each path now. `present` is what the fence will
 * actually bind (a mount whose path is gone is skipped when the fence opens), so a caller can tell a
 * mount that works from one that is only written down.
 */
export function withPresence(mounts: Mount[]): MountState[] {
  return mounts.map((m) => {
    const stat = statOf(m.path);
    return { ...m, present: stat === "dir", kind: stat };
  });
}

/** What one host path is: a directory, something else, or nothing. */
export function statOf(path: string): "dir" | "file" | "none" {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return "none";
  }
}

/**
 * The directories directly under `path`, for a picker. Hidden names are left out unless `all`. The
 * listing is capped, sorted by name, and never throws for a path that is missing or unreadable: it
 * answers what is true about the path so the caller can say so.
 */
export function browseDirectories(path: string, { limit = 500, all = false }: { limit?: number; all?: boolean } = {}): DirectoryListing {
  assert(isAbsolute(path) && path === resolve(path), `a path to browse is absolute and normalized: ${path}`);
  const kind = statOf(path);
  const parent = path === "/" ? null : dirname(path);
  if (kind !== "dir") return { path, parent, kind, readable: false, truncated: false, entries: [] };
  let names: Dirent[];
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
function isDir(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  return entry.isSymbolicLink() && statOf(join(dir, entry.name)) === "dir";
}
