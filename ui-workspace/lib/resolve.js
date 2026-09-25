// Which of these paths can be reached, and where: the transcript's links ask this in a batch before they
// turn text into a link, so it must never fail as a whole. A relative path is tried against the home,
// then against each directory of the session's project, and the first that exists wins; `~/` means the
// home. A path that is outside every space, or names nothing, is null and nothing more is said about it.
import { lstat, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { projectOfSession } from "@thetis/projects/lib/store.js";
import { contained } from "./files.js";

export const MAX_PATHS = 64;

/** The bases a relative path is tried against: the home, then the session's project directories. */
async function basesOf(env, session) {
  const project = await projectOfSession(env, session).catch(() => null);
  return [env.cwd, ...(project?.directories ?? [])];
}

/** The candidates for one given path, in the order they are tried. */
export function candidatesOf(given, bases) {
  if (given.startsWith("~/") || given === "~") return [resolvePath(bases[0], given.slice(2))];
  if (isAbsolute(given)) return [given];
  return bases.map((b) => resolvePath(b, given));
}

/** `{ absolute, display, root, mode, kind }` for a candidate that exists inside a space, else null. */
async function reachable(env, candidate) {
  let resolved;
  try {
    resolved = await contained(env, candidate);
  } catch {
    return null;
  }
  const st = await stat(resolved.absolute).catch(() => lstat(resolved.absolute).catch(() => null));
  if (!st) return null;
  const kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  return { absolute: resolved.absolute, display: resolved.display, root: resolved.root, mode: resolved.writable ? "rw" : "ro", kind };
}

/** `resolve`: one answer per given path, null when unreachable. At most 64 paths in one ask. */
export async function resolve(args, env) {
  const paths = Array.isArray(args?.paths) ? args.paths : [];
  if (paths.length > MAX_PATHS) throw new Error(`resolve takes at most ${MAX_PATHS} paths at once; ${paths.length} were given.`);
  const session = typeof args?.session === "string" && args.session ? args.session : (env.session ?? null);
  const bases = await basesOf(env, session);
  const results = {};
  for (const given of paths) {
    if (typeof given !== "string" || !given || given.includes("\u0000")) {
      if (typeof given === "string") results[given] = null;
      continue;
    }
    let found = null;
    for (const candidate of candidatesOf(given, bases)) {
      found = await reachable(env, candidate);
      if (found) break;
    }
    results[given] = found;
  }
  return { results };
}
