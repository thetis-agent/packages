// Where the installation's code is, read from disk: the shipped packages under the checkout, the promoted
// ones under the home, what each person has installed (links under their userspace store), the default
// package list and the storage driver. The update needs all of it to decide what a change touches and what
// must still load afterwards. Everything here reads; nothing writes.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** The storage driver when the configuration names none, as the kernel's defaults say. */
const DEFAULT_DRIVER = "@thetis/store-toml";

function manifestAt(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** `[{ dir, name, manifest }]` for every package directly under `base`. A manifest that does not parse is skipped. */
export function packagesUnder(base) {
  if (!existsSync(base)) return [];
  const out = [];
  for (const entry of readdirSync(base)) {
    const dir = resolve(base, entry);
    const manifest = manifestAt(dir);
    if (manifest?.name) out.push({ dir, entry, name: manifest.name, manifest });
  }
  return out;
}

/** The shipped packages first, then the promoted ones: the order the kernel looks a name up in. */
export function knownPackages(root, home) {
  return [...packagesUnder(resolve(root, "packages")), ...packagesUnder(resolve(home, "packages"))];
}

/**
 * The effective configuration's default package list and storage driver. The kernel's own `loadConfig` is
 * used when it loads, so the defaults are the kernel's and not a copy; without it, the file alone is read.
 */
export async function configFacts(root, home) {
  try {
    const { loadConfig } = await import("@thetis/runtime/kernel");
    const config = loadConfig(home, root, {});
    return { defaults: [...new Set(Object.values(config.systemPackages ?? {}).flat())], driver: config.storage?.driver ?? DEFAULT_DRIVER };
  } catch {
    let file = {};
    try {
      file = JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8"));
    } catch {
      file = {};
    }
    return { defaults: [...new Set(Object.values(file.systemPackages ?? {}).flat())], driver: file.storage?.driver ?? DEFAULT_DRIVER };
  }
}

/** The people with a userspace here, `_system` included: the directories under `<home>/userspaces`. */
export function userspaces(home) {
  const base = resolve(home, "userspaces");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((id) => existsSync(resolve(base, id, "store", "node_modules")));
}

/** `[{ name, link, dir }]`: every package linked into one person's store, with the real directory it points at. */
export function installedIn(home, user) {
  const base = resolve(home, "userspaces", user, "store", "node_modules");
  const out = [];
  const add = (name, link) => {
    try {
      if (!lstatSync(link).isSymbolicLink() && !existsSync(join(link, "package.json"))) return;
      out.push({ name, link, dir: realpathSync(link) });
    } catch {
      // A dead link: the kernel repairs those when the fence opens, and there is nothing here to load.
    }
  };
  for (const entry of existsSync(base) ? readdirSync(base) : []) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const inner of readdirSync(resolve(base, entry))) add(`${entry}/${inner}`, resolve(base, entry, inner));
    } else {
      add(entry, resolve(base, entry));
    }
  }
  return out;
}

/** Whether `path` is `dir` or under it. */
export function isWithin(path, dir) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** The real path of a directory, or the path itself when it does not exist. */
export function real(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}
