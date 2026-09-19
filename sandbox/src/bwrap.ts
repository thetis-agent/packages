// The bubblewrap command line for one fence, and the launch gate around it.
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { SYSTEM_USER, type Mount, type Userspace } from "@thetis/contracts";
import type { FenceCgroup } from "./cgroup.js";
import { FENCE_DOCKER_SOCKET } from "./docker.js";

/** The OS directories every fence may read. Missing ones are skipped. */
const OS_DIRS = ["/usr", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib32", "/lib64"];
const READY_MS = 10_000;

export interface BwrapLayout {
  /** Host paths the agent may read besides the OS (the package tree, for system packages). */
  readOnly: string[];
  /** Host paths masked with an empty tmpfs even if a parent is bound (the service-plane data dir). */
  hidden: string[];
  /** Writable for the system userspace, read-only for every other fence. */
  sharedDir: string;
  /** The resolver file bound over /etc/resolv.conf in egress mode. */
  resolvConf: string;
  network: "egress" | "none" | "host";
  /**
   * This fence's own cgroup directory, the path inside the fence it is bound read-only at, and whether the
   * fence gets a cgroup namespace of its own. Undefined when the kernel has no delegated cgroup (limits
   * off) or the host runs cgroups v1; then the bind and the namespace are both simply left out.
   */
  cgroup?: FenceCgroup;
  /**
   * The host's Docker socket, bound into the fence at `FENCE_DOCKER_SOCKET`. Undefined for no Docker.
   * Socket access is host root; see `docker.ts` for why it is offered anyway.
   */
  dockerSocket?: string;
}

export function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Whether a fence can have its own cgroup namespace: the kernel has to offer one (Linux 4.6 and later,
 * which is what `/proc/self/ns/cgroup` being there means) and this bubblewrap has to know the flag and be
 * allowed to use it. The second half is answered by running it rather than by reading a version number: an
 * older bubblewrap rejects the unknown option, and a kernel that refuses `CLONE_NEWCGROUP` in a user
 * namespace fails the clone, and either way the probe is not exit 0. A false answer is never fatal — the
 * fence is then built the way it was before the namespace existed, with the group at the path
 * `/proc/self/cgroup` names.
 */
export function hasCgroupNamespace(): boolean {
  if (!existsSync("/proc/self/ns/cgroup")) return false;
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-cgroup", "--", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

/** The directory the running Node binary was installed under, so the fence sees the same runtime. */
export function nodePrefix(): string {
  return dirname(dirname(process.execPath));
}

/** The bubblewrap arguments that give `us` a read-only host, a writable userspace, and its namespaces. */
export function bwrapArgs(us: Userspace, layout: BwrapLayout, env: Record<string, string>): string[] {
  const args = ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  // Hidden directories are masked first, so a read-only bind inside one (the promoted packages) still shows.
  for (const dir of layout.hidden) args.push("--tmpfs", dir);
  for (const dir of [...OS_DIRS, nodePrefix(), ...layout.readOnly]) {
    if (!existsSync(dir)) continue;
    const link = linkTarget(dir);
    if (link) args.push("--symlink", link, dir);
    else args.push("--ro-bind", dir, dir);
  }
  if (existsSync(layout.sharedDir)) {
    args.push(us.id === SYSTEM_USER ? "--bind" : "--ro-bind", layout.sharedDir, layout.sharedDir);
  }
  if (layout.network === "egress" && existsSync(layout.resolvConf)) {
    args.push("--ro-bind", layout.resolvConf, "/etc/resolv.conf");
  }
  // The fence's own cgroup, and nothing else of the host's tree: this is how an agent reads its own
  // `memory.max`, `memory.current` and `memory.events` and can tell an OOM kill (exit 137, `oom_kill`
  // rising) from a transient failure, and how a language runtime sizes its heap for the fence rather than
  // for the machine. Read-only, so it is self-knowledge and not control. Where it goes is decided in
  // `cgroup.ts` and is one of two layouts: at the mount root together with `--unshare-cgroup` below, the
  // arrangement every container uses, or — when there is no cgroup namespace to be had — at the full path
  // `/proc/self/cgroup` reports. A runtime resolves its own group by appending that line to the mount
  // point, so the two have to agree; the leaf at the root without the namespace makes that concatenation
  // name a directory that does not exist, which corrupts .NET's probe and aborts the process. Bubblewrap
  // creates the intermediate directories of the destination itself. `-try` because the directory is
  // created by `Cgroups.place` while the launch gate is still shut: it exists by the time bubblewrap
  // execs, and if limits are off it never appears and bubblewrap skips the bind instead of failing the
  // fence. `/proc/meminfo` still reports the host's memory; correcting that needs something like lxcfs and
  // is out of scope.
  if (layout.cgroup) args.push("--ro-bind-try", layout.cgroup.dir, layout.cgroup.dest);
  // The Docker socket, always at the path the CLI looks at by default, whatever it is called on the host, so
  // `docker` and `docker compose` work in the fence with nothing configured. It goes after every bind above
  // and its destination is under no other bind's path, because a bind of a parent directory lands on top of
  // whatever was mounted beneath it and would silently take this away again. A unix socket is filesystem and
  // not network, so this works in network mode `none` too. Read-only still permits `connect` — that needs
  // write permission on the inode, which the mount's read-only flag does not govern — and does stop the
  // fence unlinking the socket or putting its own there. `-try` so a daemon that is not running, or a path
  // that is wrong, never keeps a fence from starting.
  if (layout.dockerSocket) args.push("--ro-bind-try", layout.dockerSocket, FENCE_DOCKER_SOCKET);
  args.push("--bind", us.root, us.root, "--chdir", us.home);
  // Mounts come after the userspace and the OS, so a granted path wins over a read-only bind above it.
  for (const m of us.mounts ?? []) args.push(m.mode === "rw" ? "--bind" : "--ro-bind", m.path, m.path);
  args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts");
  // The cgroup namespace makes the group the fence is already in — `Cgroups.place` put it there while the
  // launch gate was shut — the root of the hierarchy it can see: `/proc/self/cgroup` inside reads `0::/`,
  // and `/sys/fs/cgroup` is a cgroup2 filesystem holding the fence's own files rather than a tmpfs with a
  // bind buried in it. That is what lets .NET find its limit at all: it picks the cgroup version by
  // `statfs` on the mount point, and only this layout answers v2. It is unshared only when the group is
  // bound at the root, because each is wrong without the other, and only when the kernel and this
  // bubblewrap both have it (`hasCgroupNamespace`); otherwise the fence keeps the layout it had before.
  if (layout.cgroup?.namespace) args.push("--unshare-cgroup");
  args.push("--cap-drop", "ALL", "--disable-userns", "--die-with-parent", "--new-session");
  if (layout.network === "none") args.push("--unshare-net");
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  return args;
}

/** The mounts of `us` whose host path exists. A missing one is logged and skipped, so the fence still opens. */
export function presentMounts(us: Userspace, log: (line: string) => void): Mount[] {
  return (us.mounts ?? []).filter((m) => {
    if (existsSync(m.path)) return true;
    log(`[fence] ${us.id}: mount ${m.path} does not exist on the host; skipped`);
    return false;
  });
}

/**
 * Wraps a bubblewrap command in the launch gate. fd 5 is the gate: the launcher waits for a line on it
 * before it execs. fd 6 says the launcher runs, and so its namespaces exist. In egress mode `unshare`
 * makes the private network namespace before bubblewrap runs, because slirp4netns cannot enter one
 * bubblewrap made itself.
 */
export function launcherCommand(inner: string[], network: BwrapLayout["network"]): string[] {
  const script = 'printf ready >&6; read -r go <&5 || exit 97; exec "$@"';
  const shell = ["/bin/sh", "-c", script, "sh", ...inner];
  return network === "egress" ? ["unshare", "--map-root-user", "--net", "--", ...shell] : shell;
}

/** Resolves once the launcher script reports that it runs (and so its namespaces exist). */
export function launcherReady(child: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the sandbox launcher did not start")), READY_MS);
    // Node types the stdio tuple with five slots; the launcher has seven.
    (child.stdio as unknown as (Readable | null)[])[6]?.once("data", () => {
      clearTimeout(timer);
      done();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`the sandbox launcher exited (${code})`));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

function linkTarget(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}
