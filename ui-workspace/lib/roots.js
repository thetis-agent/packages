// The spaces this fence can reach, as the explorer's top level: the home (rw), the shared directory (ro),
// and the person's projects, each directory with the same state word `@thetis/projects` shows on the
// project page, so the two never disagree about whether a directory is usable. The mounts ride along
// so a directory outside every project can still be named. An admin also gets the mounts written down
// for them (`host.grants.mountsList`), which tells `skipped` from `unmounted`, exactly as projects does.
import { basename, dirname } from "node:path";
import { currentMounts, stateOf } from "@thetis/projects/lib/mounts.js";
import { listProjects, projectOfSession } from "@thetis/projects/lib/store.js";

/** The mounts the operator wrote down for this person: an admin may read them, anyone else gets null. */
export async function boundMounts(env) {
  if (env.role !== "admin") return null;
  try {
    const all = await env.kernel.operator.call("host.grants.mountsList", { user: env.user });
    const list = all?.[env.user];
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

/** One project directory with its state and the names the tree draws it by. */
export function directoryRow(path, mounts, bound, home) {
  const s = stateOf(path, mounts, bound, home);
  return { path, name: basename(path) || path, parent: dirname(path), state: s.state, mode: s.mode, kind: s.kind, ...(s.home ? { home: true } : {}), ...(s.mount ? { mount: s.mount } : {}) };
}

/**
 * The person's mounted folders as roots, each in its real state: a mount the fence took, with what is at
 * its path now, and — for an admin, who can read what is written down — a mount the fence did not take
 * because its host path was gone, as `skipped`.
 */
export function folderRows(mounts, bound) {
  const rows = mounts.map((m) => {
    const s = stateOf(m.path, mounts, bound, null);
    return { path: m.path, name: basename(m.path) || m.path, mode: m.mode, state: s.state, kind: s.kind };
  });
  for (const b of bound ?? []) {
    if (!b || typeof b.path !== "string" || mounts.some((m) => m.path === b.path)) continue;
    rows.push({ path: b.path, name: basename(b.path) || b.path, mode: b.mode === "rw" ? "rw" : "ro", state: "skipped", kind: "none", mount: b.path });
  }
  return rows;
}

/** `roots`: home, shared, the mounted folders, every project with its directories and their states, and the mount list. */
export async function roots(args, env) {
  const session = typeof args?.session === "string" && args.session ? args.session : (env.session ?? null);
  const mounts = currentMounts();
  const [projects, current, bound] = await Promise.all([listProjects(env), projectOfSession(env, session), boundMounts(env)]);
  const rows = projects.map((p) => {
    const directories = p.directories.map((d) => directoryRow(d, mounts, bound, env.cwd));
    const ready = directories.filter((d) => d.state === "ready").length;
    return { id: p.id, name: p.name, current: current?.id === p.id, directories, summary: { ready, broken: directories.length - ready } };
  });
  return {
    user: env.user,
    admin: env.role === "admin",
    home: { path: env.cwd, mode: "rw" },
    shared: env.shared ? { path: env.shared, mode: "ro" } : null,
    projects: rows,
    folders: folderRows(mounts, bound),
    mounts,
    ...(bound ? { bound } : {}),
  };
}
