// Whether the running daemon is older than the code on disk: the dev-box case, where someone rebuilt the
// checkout by hand and only a new process picks it up ("Restart to finish"). This runs in the daemon's own
// process, so its start time is this process's. The comparison mirrors the kernel's `status`: the newest
// modification time under what the daemon loaded against when it started, walked over module files only.
// Besides the runtime's `dist/src` and the CLI adapter it counts the storage driver, which the kernel's own
// answer leaves out. Host packages are not counted: the host imports their whole module graph fresh.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFacts, knownPackages } from "./layout.js";

/** Never walked: dependencies, history, tests, and files the gateway or the per-turn loader re-reads anyway. */
const SKIP = new Set(["node_modules", ".git", "test", "ui", "skills", "bench", "docs"]);
const CODE = /\.(m?js|cjs)$|^package\.json$/;

function newest(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let at = 0;
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) at = Math.max(at, newest(path));
    else if (entry.isFile() && CODE.test(entry.name)) {
      try {
        at = Math.max(at, statSync(path).mtimeMs);
      } catch {
        // Removed while walking.
      }
    }
  }
  return at;
}

/** When this process started, in epoch milliseconds. */
export const daemonStartedAt = () => Date.now() - Math.round(process.uptime() * 1000);

/**
 * `{ daemon, why? }`: `daemon` is true when any of the sets below has a module file newer than the daemon's
 * start, and `why` names each such set in a plain phrase.
 */
export async function staleDaemon(root, home, startedAt = daemonStartedAt()) {
  const { driver } = await configFacts(root, home);
  const known = knownPackages(root, home);
  const sets = [
    { why: "Thetis's own code was rebuilt", dirs: [resolve(root, "dist/src"), resolve(root, "packages/gateway-cli/dist/src")] },
    ...known.filter((p) => p.name === driver).slice(0, 1).map((p) => ({ why: `the storage driver ${p.name} changed`, dirs: [p.dir] })),
  ];
  const why = sets.filter((s) => s.dirs.some((d) => newest(d) > startedAt)).map((s) => s.why);
  return why.length ? { daemon: true, why } : { daemon: false };
}
