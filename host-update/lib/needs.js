// What an update needs to be put into service, decided from what git says changed and not from file times:
// a restart when code the daemon read once at start changed, else a reload of each workspace that runs a
// shipped package that changed. The same answer is shown before the button is pressed and acted on after.
import { resolve } from "node:path";
import { git } from "./checkout.js";
import { configFacts, installedIn, isWithin, knownPackages, real, userspaces } from "./layout.js";

/** Runtime paths the daemon reads once, at start: its own modules, the command, and what builds or installs them. */
const RESTART_RUNTIME = [/^src\//, /^bin\//, /^package\.json$/, /^package-lock\.json$/, /^tsconfig[^/]*$/];

/**
 * Package directories the daemon itself loads once: the CLI adapter that serves. The storage driver is added by
 * name. Host packages are not here: the host imports a host package's whole module graph fresh when any of its
 * files changed, so an updated one is live on its next call.
 */
const RESTART_PACKAGES = [/^gateway-cli$/];

/** Paths whose change means `npm ci` has something to do: the lock and any manifest's dependencies. */
const DEPENDENCIES = [/^package-lock\.json$/, /(^|\/)package\.json$/];

/** How many file names a `why` quotes. The rest is `git diff` on the host. */
const WHY_LIMIT = 6;

/** `git diff --name-only from to`, or null when either commit is not here. */
export async function changedBetween(dir, from, to) {
  if (!from || !to) return null;
  if (from === to) return [];
  try {
    const text = await git(dir, ["diff", "--name-only", from, to]);
    return text ? text.split("\n") : [];
  } catch {
    return null;
  }
}

/**
 * `{ restart, reload, why, dependencies }` for a move of the runtime from `runtime[0]` to `runtime[1]` and of
 * the packages from `packages[0]` to `packages[1]`. `reload` lists the workspaces (`_system` included) whose
 * installed shipped packages changed; it is computed even when a restart is needed, which reopens every
 * fence anyway, so the page can say who is affected. `why` names what makes a restart necessary.
 * `dependencies` says whether `npm ci` has anything to do. When the packages' commits are not both here the
 * change is unknown, and every workspace is listed rather than none.
 */
export async function needsFor(root, home, { runtime, packages }) {
  const runtimeFiles = (await changedBetween(root, runtime[0], runtime[1])) ?? [];
  const packageFiles = await changedBetween(resolve(root, "packages"), packages[0], packages[1]);
  const { driver } = await configFacts(root, home);
  const known = knownPackages(root, home);
  const shipped = known.filter((p) => isWithin(p.dir, resolve(root, "packages")));
  const driverEntry = shipped.find((p) => p.name === driver)?.entry;
  const why = [];
  for (const file of runtimeFiles) if (RESTART_RUNTIME.some((re) => re.test(file))) why.push(file);
  const changedDirs = packageFiles === null ? null : [...new Set(packageFiles.map((f) => f.split("/")[0]))];
  for (const dir of changedDirs ?? []) {
    if (RESTART_PACKAGES.some((re) => re.test(dir)) || dir === driverEntry) why.push(`packages/${dir}/`);
  }
  const dependencies = runtimeFiles.some((f) => DEPENDENCIES.some((re) => re.test(f))) || packageFiles === null || packageFiles.some((f) => DEPENDENCIES.some((re) => re.test(f)));
  const reload = changedDirs === null ? userspaces(home) : affected(root, home, changedDirs, shipped);
  if (changedDirs === null) why.push("the packages' new commit is not fetched yet, so what changed in them is not known");
  return { restart: why.length > 0, reload: ordered(reload), why: why.slice(0, WHY_LIMIT), dependencies };
}

/** The workspaces with a link into one of the changed shipped package directories. */
function affected(root, home, dirs, shipped) {
  const base = real(resolve(root, "packages"));
  const changed = new Set(dirs.map((d) => resolve(base, d)));
  const byName = new Set(shipped.filter((p) => changed.has(resolve(base, p.entry))).map((p) => p.name));
  if (!byName.size) return [];
  return userspaces(home).filter((user) => installedIn(home, user).some((p) => byName.has(p.name) && isWithin(p.dir, base)));
}

/** `_system` first: it serves the login and the providers every other workspace is waiting on. */
function ordered(users) {
  return [...users].sort((a, b) => (a === "_system" ? -1 : b === "_system" ? 1 : a.localeCompare(b)));
}
