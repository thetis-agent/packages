// Path containment: every tool must resolve paths through here before touching disk.
// Roots: env.cwd (home) is read-write, env.shared is read-only. We resolve symlinks with
// realpath so a link that points outside the roots cannot be used to escape them, and we
// walk up to the nearest existing ancestor so a path that names a file yet to be created
// (e.g. a new file under an existing directory) can still be checked and located.
import { realpath, lstat } from "node:fs/promises";
import { dirname, basename, resolve, isAbsolute, sep, relative } from "node:path";

const OUTSIDE = (raw) => `${raw} is outside the spaces you can reach (home rw, shared ro).`;

// True when `p` is root itself or a path underneath it.
function isWithin(p, root) {
  if (p === root) return true;
  const rel = relative(root, p);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// Walk from `start` upward until realpath succeeds, collecting the components that
// don't exist yet. Returns { real, missing } where `missing` is deepest-first.
async function nearestExisting(start) {
  let cur = start;
  const missing = [];
  for (;;) {
    try {
      const real = await realpath(cur);
      return { real, missing };
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e; // hit the filesystem root without success; shouldn't happen
      missing.push(basename(cur));
      cur = parent;
    }
  }
}

// Reject any path with a `.git` component, used to protect the directory from writes/deletes.
export function hasGitComponent(p) {
  return p.split(sep).includes(".git");
}

/**
 * Resolve `rawPath` against home, contain it to home (rw) or shared (ro), and detect
 * dangling symlinks. Throws Error with model-facing text on any violation.
 * Returns { absolute, display, root: "home"|"shared", writable }.
 */
export async function resolveContained(env, rawPath, { write = false } = {}) {
  if (rawPath === undefined || rawPath === null || rawPath === "") {
    throw new Error("path is required and must not be empty.");
  }
  const raw = String(rawPath);
  if (raw.includes("\u0000")) throw new Error(`${raw} contains a NUL byte and is refused.`);

  const home = env.cwd;
  const shared = env.shared;
  const target = isAbsolute(raw) ? raw : resolve(home, raw);

  // A symlink that names the target itself but points nowhere is refused outright,
  // distinct from a target that simply doesn't exist yet (which is fine to create).
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) {
      try {
        await realpath(target);
      } catch {
        throw new Error(`${raw} is a dangling symlink.`);
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      if (e.message && e.message.includes("dangling")) throw e;
      // otherwise fall through: some other lstat failure, let the walk-up below decide
    }
  }

  const { real, missing } = await nearestExisting(target);
  const full = missing.length ? resolve(real, ...missing.slice().reverse()) : real;

  const realHome = await realpath(home);
  const realShared = shared ? await realpath(shared).catch(() => null) : null;

  let root = null;
  let writable = false;
  if (isWithin(full, realHome)) {
    root = "home";
    writable = true;
  } else if (realShared && isWithin(full, realShared)) {
    root = "shared";
    writable = false;
  }
  if (!root) throw new Error(OUTSIDE(raw));
  if (write && !writable) {
    throw new Error(`${raw} is read-only (shared); writes need a path under home.`);
  }
  if (write && hasGitComponent(full)) {
    throw new Error(`${raw} names a .git path, which is protected from write and delete.`);
  }

  const display = root === "home" ? (relative(realHome, full) || ".") : full;
  return { absolute: full, display, root, writable };
}
