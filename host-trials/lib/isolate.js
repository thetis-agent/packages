// The isolation of one trial run, done by the inner runner as root of its own user and mount namespace
// before anything else runs. The plan is pure (`overlayPlan`, `parseMountinfo`) so it can be tested; the
// rest calls mount(8).
//
// Every path a trial could write for real -- THETIS_HOME, the runtime checkout, the source of every
// read-write mount grant, and every filesystem mounted beneath any of them -- is overlaid onto itself, its
// writes going to one tmpfs. The lower layers are bound into that tmpfs first, all of them, before the first
// overlay goes up: an overlay hides whatever is mounted beneath its path, so a lower taken afterwards would
// be the overlay's stub and not the real filesystem. The process works from inside the tmpfs (`chdir`), and
// every layer is named relative to it, because the tmpfs's own path lies under THETIS_HOME and stops
// resolving to it the moment THETIS_HOME is overlaid; a working directory is held by reference, not by path.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export const within = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
const depth = (p) => (p === "/" ? 0 : p.split("/").length - 1);

/** The mount points of `/proc/self/mountinfo`, with the kernel's octal escapes undone. */
export function parseMountinfo(text) {
  const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const f = line.split(" ");
      const dash = f.indexOf("-");
      return { mountPoint: unescape(f[4] ?? ""), fstype: dash > 0 ? f[dash + 1] : "", source: dash > 0 ? unescape(f[dash + 2] ?? "") : "" };
    })
    .filter((m) => m.mountPoint.startsWith("/"));
}

/**
 * What to overlay, shallowest first: every root, and every mount point strictly beneath one. A path beneath
 * another that is not a mount point of its own is left out, because the overlay above it already takes its
 * writes; a mount point beneath one is kept, because the overlay above hides it and only its own overlay
 * brings its files back.
 */
export function overlayPlan(roots, mountPoints) {
  const points = new Set(mountPoints);
  const candidates = new Set(roots);
  for (const mp of points) if (roots.some((r) => mp !== r && within(mp, r))) candidates.add(mp);
  const all = [...candidates];
  return all
    .filter((p) => points.has(p) || !all.some((q) => q !== p && within(p, q)))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** A real directory's real path, or null for anything else or nothing. */
export function realDir(path) {
  try {
    const real = realpathSync(path);
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

const isPlainDir = (p) => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

function mount(args) {
  try {
    execFileSync("mount", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const why = String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0];
    throw new Error(`mount ${args.join(" ")} failed: ${why}`);
  }
}

/** Whether a unix socket at `path` accepts a connection within `ms`. */
export function connectable(path, ms = 2000) {
  return new Promise((done) => {
    const sock = createConnection(path);
    const timer = setTimeout(() => finish(false), ms);
    function finish(ok) {
      clearTimeout(timer);
      sock.destroy();
      done(ok);
    }
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

/**
 * The isolation, in order. `spec` carries `home`, `root`, `rwMounts`, `ns` (an empty directory for the
 * tmpfs), `scratchMb`, `uid` and optionally `dockerSockets`. Answers what it did:
 * `{overlays, masked, sentinels, docker}`, every docker entry `{path, blocked}`. Throws a sentence on any
 * failure; the caller then runs nothing.
 */
export async function isolate(spec, { mountinfo = () => readFileSync("/proc/self/mountinfo", "utf8") } = {}) {
  const points = parseMountinfo(mountinfo()).map((m) => m.mountPoint);
  const roots = [...new Set([spec.home, spec.root, ...(spec.rwMounts ?? [])].map(realDir).filter(Boolean))];
  const home = realDir(spec.home);
  if (!home) throw new Error(`THETIS_HOME ${spec.home} is not a directory`);
  const plan = overlayPlan(roots, points);

  // 1. The tmpfs for every upper and work directory, and the lowers bound into it while they are still real.
  if (!isPlainDir(spec.ns)) throw new Error(`the trial's scratch directory ${spec.ns} is not a plain directory`);
  mount(["-t", "tmpfs", "-o", `size=${spec.scratchMb}m,mode=0700`, "thetis-trial", spec.ns]);
  process.chdir(spec.ns);
  plan.forEach((_, i) => {
    for (const d of ["l", "u", "w"]) mkdirSync(`${d}/${i}`, { recursive: true });
  });
  plan.forEach((p, i) => mount(["--bind", p, `l/${i}`]));
  // 2 and 3. THETIS_HOME, the checkout, every read-write grant, and what is mounted beneath them.
  plan.forEach((p, i) => mount(["-t", "overlay", "overlay", "-o", `lowerdir=l/${i},upperdir=u/${i},workdir=w/${i}`, p]));

  // 4 and 5. No real socket through the overlay, and no docker.
  const masked = [];
  const tmpfs = (p) => {
    if (!isPlainDir(p)) return;
    mount(["-t", "tmpfs", "-o", "size=1m,mode=0700", "thetis-trial-mask", p]);
    masked.push(p);
  };
  const devnull = (p) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory() || st.isSymbolicLink()) return;
    mount(["--bind", "/dev/null", p]);
    masked.push(p);
  };
  for (const d of ["run", "fence-ssh", "fence-keys"]) tmpfs(resolve(home, d));
  const spaces = resolve(home, "userspaces");
  for (const u of safeNames(spaces)) tmpfs(resolve(spaces, u, "run"));
  if (Number.isInteger(spec.uid)) tmpfs(`/run/user/${spec.uid}`);
  // Any other socket at the top of the home or of a userspace (the control socket is `<home>/thetis.sock`).
  for (const dir of [home, ...safeNames(spaces).map((u) => resolve(spaces, u))]) {
    for (const name of safeNames(dir)) {
      const p = resolve(dir, name);
      try {
        if (lstatSync(p).isSocket()) devnull(p);
      } catch {
        // gone meanwhile
      }
    }
  }
  const dockerPaths = [...new Set(["/run/docker.sock", "/var/run/docker.sock", ...(spec.dockerSockets ?? [])])];
  for (const p of dockerPaths) {
    // `/var/run` is a link to `/run` on most hosts: bind over the socket it leads to.
    let real;
    try {
      real = realpathSync(p);
    } catch {
      continue;
    }
    if (!masked.includes(real)) devnull(real);
  }

  // 7. The check. A sentinel in every overlaid path, which the outer runner must not see; and the sockets.
  const tag = randomBytes(6).toString("hex");
  const sentinels = plan.map((p) => {
    const file = resolve(p, `.thetis-trial-sentinel-${tag}`);
    writeFileSync(file, "a trial wrote this inside its namespace; it must never be visible outside\n");
    return file;
  });
  const docker = [];
  for (const p of dockerPaths) {
    if (!existsSync(p)) continue;
    const blocked = !(await connectable(p));
    docker.push({ path: p, blocked });
    if (!blocked) throw new Error(`the docker socket ${p} is still reachable`);
  }
  return { overlays: plan, masked, sentinels, docker };
}

function safeNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
