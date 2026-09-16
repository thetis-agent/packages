// What the fence has mounted, from THETIS_MOUNTS: a JSON list of { path, mode } the kernel sets when it
// opens the fence (03-fence.md section 3.5). This package reads it the way tools-files does, so the two
// agree on which project directory the file tools can reach. A directory is "mounted" when it is a mount
// or lies under one; the mode is the mount's. A directory under the home is reachable without a mount,
// but this package does not know the home's real path inside every sandbox mode, so it reports only what
// the variable says; the file tools are the authority on reach.
//
// A mount is not enough on its own: the bind can be in place while the directory named by the project is
// not there, and the kernel drops a mount whose host path is gone when it opens the fence. So the state of
// one project directory has four parts — does it lie under the home, which needs no mount, is a mount over
// it, does the path exist inside the fence, and (for an admin, who can read `mounts.list`) is a mount
// written down for it that the fence did not take. `stateOf` folds those into one word, and every surface
// says that word: the page, the prompt, the CLI. The home is `env.cwd`, the same path the file tools treat
// as read-write, so the two agree on what needs a mount and what does not.
import { isAbsolute, relative } from "node:path";
import { statSync } from "node:fs";

/** Parses the variable's value. Absent or malformed means no mounts. */
export function mountsFromEnv(value) {
  try {
    const list = JSON.parse(value ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m && typeof m.path === "string" && isAbsolute(m.path) && (m.mode === "rw" || m.mode === "ro"))
      .map((m) => ({ path: m.path, mode: m.mode }));
  } catch {
    return [];
  }
}

/** The mounts of this fence, read when asked so a test can set the variable. */
export const currentMounts = () => mountsFromEnv(process.env.THETIS_MOUNTS);

export function isWithin(p, root) {
  if (!root) return false;
  if (p === root) return true;
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** "rw", "ro", or null when no mount covers the directory. The first covering mount wins. */
export function mountModeOf(directory, mounts) {
  for (const m of mounts) if (isWithin(directory, m.path)) return m.mode;
  return null;
}

/** What the fence itself finds at the path: "dir", "file", or "none". Only a mounted path can be seen. */
export function kindOf(directory) {
  try {
    return statSync(directory).isDirectory() ? "dir" : "file";
  } catch {
    return "none";
  }
}

/**
 * The state of one project directory, as one word plus the parts it was made from. `bound` is the mount
 * the operator has written down for the path, when the caller could read the mount list; without it the
 * skipped case cannot be told apart from the missing one, and the state says `unmounted`.
 *
 *  - `ready`     it is reachable and the directory is there: the file tools can use it.
 *  - `empty-path` it is reachable, but nothing is at the path: the reach is fine, the directory is not.
 *  - `not-a-directory` it is reachable and a file is at the path.
 *  - `skipped`   a mount is written down for it, and the fence did not take it: the host path is gone.
 *  - `unmounted` nothing reaches it: the file tools cannot read or write there at all.
 *
 * `home` tells `ready` from `unmounted` for a path inside the person's own space, which needs no mount.
 * Such a state carries `home: true`, so a page offers no bind for it and the prompt names no command.
 */
export function stateOf(directory, mounts, bound = null, home = null) {
  const inHome = isWithin(directory, home);
  const mode = inHome ? "rw" : mountModeOf(directory, mounts);
  if (mode) {
    const kind = kindOf(directory);
    const state = kind === "dir" ? "ready" : kind === "file" ? "not-a-directory" : "empty-path";
    return { state, mode, kind, ...(inHome ? { home: true } : {}) };
  }
  const written = bound?.find((m) => isWithin(directory, m.path)) ?? null;
  if (written) return { state: "skipped", mode: written.mode, kind: "none", mount: written.path };
  return { state: "unmounted", mode: null, kind: "none" };
}

/** One line for the system prompt: the path, and what the agent can do with it right now. */
export function describeDirectory(directory, mounts, user, bound = null, home = null) {
  const s = stateOf(directory, mounts, bound, home);
  const how = s.home ? "in your space" : `mounted ${s.mode}`;
  switch (s.state) {
    case "ready":
      return `${directory} (${how}${s.mode === "ro" ? ", read-only" : ""})`;
    case "empty-path":
      return `${directory} (${how}, but nothing is at this path: make the directory before you work in it)`;
    case "not-a-directory":
      return `${directory} (${how}, but a file is at this path, not a directory)`;
    case "skipped":
      return `${directory} (NOT USABLE: ${s.mount} is written down as a mount, and the host has no directory there, so the fence opened without it; the path is wrong or the directory is gone)`;
    default:
      return `${directory} (NOT USABLE: no mount covers it, so the file tools cannot read or write there; an admin binds it with "thetis mounts add ${user} ${directory}", or from the project page)`;
  }
}
