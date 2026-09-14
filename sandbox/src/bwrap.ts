// The bubblewrap command line for one fence, and the launch gate around it.
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { SYSTEM_USER, type Userspace } from "@thetis/contracts";

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
}

export function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stdio: "ignore" });
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
  args.push("--bind", us.root, us.root, "--chdir", us.home);
  args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts");
  args.push("--cap-drop", "ALL", "--disable-userns", "--die-with-parent", "--new-session");
  if (layout.network === "none") args.push("--unshare-net");
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  return args;
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
