import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import type { Fence, FenceHandle, KernelRpc, Userspace } from "@thetis/contracts";
import { CodedError, errorMessage } from "@thetis/lib/error";
import { bwrapArgs, hasBwrap, launcherCommand, launcherReady, presentMounts } from "./bwrap.js";
import type { Cgroups, FenceCgroup, FenceLimits } from "./cgroup.js";
import { ProcessHandle, type SandboxHandle } from "./handle.js";
import { hasSlirp, startEgress, writeResolvConf } from "./network.js";

export type SandboxMode = "auto" | "bwrap" | "none";
export type FenceNetwork = "auto" | "egress" | "none" | "host";

export interface ProcessFenceOptions {
  agentPath: string;
  sandbox: SandboxMode;
  /** Host paths the agent may read besides the OS (the package tree, for system packages). */
  readOnly: string[];
  /** Host paths masked with an empty tmpfs even if a parent is bound (the service-plane data dir). */
  hidden: string[];
  /** Writable for the system userspace, read-only for every other fence. */
  sharedDir: string;
  /** `egress`: a private network namespace with outbound NAT and no host loopback. `none`: no network. `host`: the host's namespace. */
  network: FenceNetwork;
  /** Where to write the resolver file bound over /etc/resolv.conf in egress mode. */
  resolvConf: string;
  limits: FenceLimits;
  /** Resolved on the first sandboxed open, so a one-shot command that opens no fence never probes the cgroup. */
  cgroups?: () => Cgroups | undefined;
  requestTimeoutMs: number;
  log?: (line: string) => void;
}

/**
 * Runs one long-lived agent process per userspace. With bubblewrap available the agent
 * gets its own PID/IPC/UTS namespaces, a read-only view of the host, and a writable bind
 * of its userspace only. Protocol: newline-delimited JSON over stdio.
 */
export class ProcessFence implements Fence {
  private readonly sandbox: "bwrap" | "none";
  private readonly network: "egress" | "none" | "host";
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ProcessFenceOptions) {
    this.log = opts.log ?? (() => {});
    this.sandbox = opts.sandbox === "auto" ? (hasBwrap() ? "bwrap" : "none") : opts.sandbox;
    this.network = resolveNetwork(this.sandbox, opts.network);
    if (this.network === "egress") writeResolvConf(opts.resolvConf);
  }

  get mode(): "bwrap" | "none" {
    return this.sandbox;
  }

  get networkMode(): "egress" | "none" | "host" {
    return this.network;
  }

  /**
   * The agent starts behind a launch gate: it is placed in its cgroup and, in egress mode, given its
   * network before its first instruction runs. A failure before the gate opens kills the process.
   */
  async open(us: Userspace, rpc: KernelRpc): Promise<SandboxHandle> {
    // Stamped before the spawn: this is when the agent reads its modules, and `status` compares it against
    // what is on disk now.
    const openedAt = Date.now();
    // The cgroup is adopted before the first child exists: enabling controllers needs the parent group empty.
    const cgroups = this.sandbox === "bwrap" ? this.opts.cgroups?.() : undefined;
    // The fence reads its own limits under /sys/fs/cgroup, at the path /proc/self/cgroup names. `openGate`
    // creates that directory before it opens the gate, so it is there by the time bubblewrap execs; when
    // limits are off there is no directory to name.
    const child = this.spawn(us, cgroups?.fence(us.id));
    const cleanup: (() => void)[] = [];
    try {
      if (this.sandbox === "bwrap") await this.openGate(us, child, cgroups, cleanup);
    } catch (err) {
      child.kill("SIGKILL");
      for (const fn of cleanup) fn();
      throw new CodedError(`fence for ${us.id} could not start: ${errorMessage(err)}`, "fence");
    }
    const handle = new ProcessHandle(child, us, rpc, { requestTimeoutMs: this.opts.requestTimeoutMs, log: this.log }, cleanup);
    await handle.request("ping", {});
    return Object.assign(handle, { openedAt });
  }

  private async openGate(us: Userspace, child: ChildProcess, cgroups: Cgroups | undefined, cleanup: (() => void)[]): Promise<void> {
    await launcherReady(child);
    const pid = child.pid ?? 0;
    const placement = cgroups?.place(us.id, this.opts.limits);
    if (placement) {
      placement.attach(pid);
      cleanup.push(placement.release);
    }
    if (this.network === "egress") {
      const egress = await startEgress(pid, this.log);
      placement?.attach(egress.pid);
      cleanup.push(egress.stop);
    }
    (child.stdio as unknown as (Writable | null)[])[5]?.end("go\n");
    this.log(`[fence] ${us.id}: started (network ${this.network}${placement ? ", limited" : ""})`);
  }

  private spawn(space: Userspace, cgroup?: FenceCgroup): ChildProcess {
    // Package code learns the mounts from the environment in every mode; without a sandbox they are simply the host's paths.
    const us = { ...space, mounts: presentMounts(space, this.log) };
    const env = {
      PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
      HOME: us.home,
      LANG: process.env.LANG ?? "C.UTF-8",
      THETIS_USERSPACE: us.root,
      THETIS_HOME_DIR: us.home,
      THETIS_STORE: us.store,
      THETIS_SHARED: this.opts.sharedDir,
      THETIS_USER: us.id,
      THETIS_MOUNTS: JSON.stringify(us.mounts),
    };
    const node = [process.execPath, this.opts.agentPath];
    if (this.sandbox === "none") {
      return spawn(node[0], node.slice(1), { cwd: us.home, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    const layout = { ...this.opts, network: this.network, cgroup };
    const cmd = launcherCommand(["bwrap", ...bwrapArgs(us, layout, env), "--", ...node], this.network);
    // fds 3 and 4 are unused; 5 is the launch gate (written by us), 6 the ready signal (written by the launcher).
    return spawn(cmd[0], cmd.slice(1), { env, stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"] });
  }
}

/** Without a sandbox there is no namespace to isolate, so the network is the host's. */
function resolveNetwork(sandbox: "bwrap" | "none", wanted: FenceNetwork): "egress" | "none" | "host" {
  if (sandbox === "none" || wanted === "host") return "host";
  if (wanted === "auto") return hasSlirp() ? "egress" : "host";
  return wanted;
}
