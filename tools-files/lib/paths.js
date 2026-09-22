// Path containment: every tool must resolve paths through here before touching disk.
// Roots: env.cwd (home) is read-write, env.shared is read-only, and each mount the fence
// announces in THETIS_MOUNTS is rw or ro as granted. We resolve symlinks with realpath so a
// link that points outside the roots cannot be used to escape them, and we walk up to the
// nearest existing ancestor so a path that names a file yet to be created (e.g. a new file
// under an existing directory) can still be checked and located.
import { realpath, lstat } from "node:fs/promises";
import { dirname, basename, resolve, isAbsolute, sep, relative } from "node:path";

// The mounts, read once: a JSON list of { path, mode } set by the fence. Absent or malformed means none.
export function mountsFromEnv(value) {
  try {
    const list = JSON.parse(value ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((m) => m && typeof m.path === "string" && isAbsolute(m.path) && (m.mode === "rw" || m.mode === "ro")).map((m) => ({ path: m.path, mode: m.mode }));
  } catch {
    return [];
  }
}

const MOUNTS = mountsFromEnv(process.env.THETIS_MOUNTS);

// The refusal names every space, so the model learns what it may reach without a second probe.
const OUTSIDE = (raw) => {
  const spaces = ["home rw", "shared ro", ...MOUNTS.map((m) => `${m.path} ${m.mode}`)];
  return `${raw} is outside the spaces you can reach (${spaces.join(", ")}).`;
};

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
 * Resolve `rawPath` against home, contain it to home (rw), shared (ro) or a mount (as granted),
 * and detect dangling symlinks. Throws Error with model-facing text on any violation.
 * Returns { absolute, display, root: "home"|"shared"|"mount", writable }.
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
  let label = "";
  let mount = null;
  if (isWithin(full, realHome)) {
    root = "home";
    writable = true;
  } else if (realShared && isWithin(full, realShared)) {
    root = "shared";
    writable = false;
    label = "shared";
  } else {
    for (const m of MOUNTS) {
      const realMount = await realpath(m.path).catch(() => null);
      if (!realMount || !isWithin(full, realMount)) continue;
      root = "mount";
      writable = m.mode === "rw";
      label = `mount ${m.path}`;
      mount = m;
      break;
    }
  }
  if (!root) throw new Error(OUTSIDE(raw));
  if (write && !writable) {
    const rw = MOUNTS.filter((m) => m.mode === "rw").map((m) => ` or ${m.path}`).join("");
    throw new Error(`${raw} is read-only (${label}); writes need a path under home${rw}.`);
  }
  if (write && hasGitComponent(full)) {
    throw new Error(`${raw} names a .git path, which is protected from write and delete.`);
  }

  const display = root === "home" ? (relative(realHome, full) || ".") : full;
  return { absolute: full, display, root, writable, mount };
}

/**
 * A write this module allowed and the kernel refused anyway, turned into a sentence worth reading.
 *
 * What this module trusts is THETIS_MOUNTS: the list the fence announced. What actually refuses a write is
 * the fence's mount table. The two are supposed to agree and they have not always: a read-only bind landing
 * *inside* a granted `rw` mount takes that subtree back without changing a word of the list, so every
 * surface -- this tool, the project page, the system prompt -- said `rw` while every write failed. The
 * person who hit it had an agent discover it, and what the agent had to go on was the string `EROFS`.
 *
 * `EROFS` on a path the list calls writable is that disagreement and nothing else, so say so, say it is the
 * workspace and not the path, and say not to work around it -- because the tempting workaround is to write
 * somewhere else and leave the real fault in place. Anything else is returned unchanged; an ordinary
 * permission error is an ordinary permission error.
 */
export function writeRefusal(err, resolved) {
  if (err?.code !== "EROFS" || !resolved?.writable) return null;
  const where = resolved.mount ? `${resolved.mount.path} is mounted ${resolved.mount.mode}` : "this path is in your own space, which is read-write";
  return new Error(
    `${resolved.display} is on a read-only filesystem, but ${where}. Something in your workspace is bound read-only inside a space the mount list calls read-write, so the two disagree. This is a fault in the workspace, not in the path: report it in these words and do not work around it.`,
  );
}
