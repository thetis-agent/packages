// The host paths a person may not bind into their own fence. An admin's mount is not checked here: this is
// the limit on a self call (`mountsSet` with `args.self`), which lets a person mount any host directory the
// daemon's user can reach except these.
//
// A blocklist is the weaker kind of rule -- it says what is dangerous, and whatever it forgets is allowed --
// so it errs wide. Three relations are refused:
//
// - the path is a blocked path or lies inside one;
// - the path contains a blocked path that the fence does not mask on its own (a mount of /home/thetis would
//   carry ~/.ssh in with it). $THETIS_HOME is the exception: the fence lays an empty tmpfs over it inside
//   any mount, so a mount of its parent is safe;
// - either of the above after symlinks are followed, because bubblewrap binds what the link points at.
//
// What is blocked, and why:
// - the runtime checkout (`env.root`): its `.env` holds the provider key, and its packages are code the
//   daemon itself imports -- this one included -- so writing there is running code as the host.
// - $THETIS_HOME (`env.home`): every person's space, the users, the configuration, the keys the host holds.
// - the Node install the daemon runs, for the same reason as the checkout.
// - the daemon user's home itself and every dot-entry in it (~/.ssh, ~/.config, ~/.local, ~/.bashrc, ...):
//   credentials, and files a login shell of the host user executes.
// - the kernel's own trees: /proc, /sys, /dev, /run, /var/run (the Docker socket, the control token),
//   /boot, /etc, /var/lib/docker, /root.
// - any path through a directory named like a credential store (secrets, .ssh, .gnupg, .aws, .kube, ...),
//   wherever it is. Only the path is checked: a mount of a parent that holds one is not refused by this.
// - whatever an admin lists in `<THETIS_HOME>/host-grants/blocked.json`, a JSON list of absolute paths.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The daemon user's home from the password database, not `$HOME`, which a caller's environment could move. */
const hostHome = () => {
  try {
    return userInfo().homedir;
  } catch {
    return process.env.HOME ?? "";
  }
};

/** Directory names that hold credentials wherever they are: a path through one of them is refused. */
const CREDENTIAL_NAMES = new Set(["secrets", ".secrets", ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".password-store", ".vault-token"]);

const SYSTEM = ["/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc", "/var/lib/docker", "/root"];

/** The blocked paths for this host, each `{ path, why, masked }`; `masked` means the fence hides it inside any mount. */
export function blockedPaths(env) {
  const out = [];
  const add = (path, why, masked = false) => {
    if (path && isAbsolute(path)) out.push({ path: resolve(path), why, masked });
  };
  add(env.root, "the Thetis runtime checkout: its .env holds the provider key and its packages are code the daemon runs");
  add(env.home, "the Thetis data directory: every person's space, the users, the configuration and the keys", true);
  add(resolve(dirname(process.execPath), ".."), "the Node install the daemon runs");
  const user = hostHome();
  add(user, "the home of the user Thetis runs as");
  for (const p of SYSTEM) add(p, "the operating system's own tree");
  for (const p of extraBlocked(env)) add(p, "listed in host-grants/blocked.json by an admin");
  return out;
}

/** An admin's own additions, `<home>/host-grants/blocked.json`. A missing or malformed file adds nothing. */
function extraBlocked(env) {
  const file = join(String(env.home ?? ""), "host-grants", "blocked.json");
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The path with symlinks followed as far as the host has it, the rest appended: what bubblewrap would bind. */
export function realOf(path) {
  let head = path;
  const rest = [];
  while (!existsSync(head) && head !== dirname(head)) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  try {
    return join(realpathSync(head), ...rest);
  } catch {
    return path;
  }
}

const within = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Why a person may not mount `path`, or null when they may. The home of the daemon's user is special:
 * the directory itself and its dot-entries are blocked, while a plain subdirectory (~/projects) is not.
 */
export function blockedReason(env, path) {
  const candidates = [...new Set([resolve(path), realOf(resolve(path))])];
  const user = hostHome();
  for (const p of candidates) {
    const named = p.split(sep).find((part) => CREDENTIAL_NAMES.has(part));
    if (named) return `${path} goes through a directory named ${named}, which holds credentials`;
    for (const b of blockedPaths(env)) {
      const reals = [...new Set([b.path, realOf(b.path)])];
      for (const dir of reals) {
        if (dir === user || dir === realOf(user)) {
          if (p === dir) return `${path} is ${b.why}`;
          const first = p.startsWith(dir + sep) ? p.slice(dir.length + 1).split(sep)[0] : null;
          if (first?.startsWith(".")) return `${path} is inside ${join(dir, first)}, in ${b.why}`;
          if (within(p, dir)) return `${path} contains ${dir}, ${b.why}`;
          continue;
        }
        if (within(dir, p)) return p === dir ? `${path} is ${b.why}` : `${path} is inside ${dir}, ${b.why}`;
        if (!b.masked && within(p, dir)) return `${path} contains ${dir}, ${b.why}`;
      }
    }
  }
  return null;
}
