import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import type { Fence, FenceHandle, KernelRpc, Userspace } from "@thetis/contracts";
import { CodedError, errorMessage } from "@thetis/lib/error";
import { knownHostsOf } from "@thetis/lib/ssh";
import { bwrapArgs, hasBwrap, hasCgroupNamespace, launcherCommand, launcherReady, presentMounts } from "./bwrap.js";
import type { Cgroups, FenceCgroup, FenceLimits } from "./cgroup.js";
import { dockerSocket, FENCE_DOCKER_SOCKET, type DockerAccess } from "./docker.js";
import { ProcessHandle, type SandboxHandle } from "./handle.js";
import { hasSlirp, startEgress, writeResolvConf } from "./network.js";
import { FENCE_SSH_AUTH_SOCK, startSshAgent, writeSshFiles, type SshAgent } from "./ssh.js";

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
  /** Whether every fence gets the host's Docker socket. `auto` binds one when the kernel can use it. */
  docker: DockerAccess;
  /** The host socket to bind, when it is not in one of the usual places. */
  dockerSocketPath?: string;
  /** Where the per-fence ssh agent socket and its client files are written. One directory per user beneath it. */
  sshDir: string;
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
  /** Answered on the first sandboxed open with a cgroup, and remembered: it costs a bubblewrap run. */
  private namespaced?: boolean;
  /** The host's Docker socket bound into every fence, or undefined for no Docker. */
  private readonly docker?: string;

  constructor(private readonly opts: ProcessFenceOptions) {
    this.log = opts.log ?? (() => {});
    this.sandbox = opts.sandbox === "auto" ? (hasBwrap() ? "bwrap" : "none") : opts.sandbox;
    this.network = resolveNetwork(this.sandbox, opts.network);
    if (this.network === "egress") writeResolvConf(opts.resolvConf);
    // In mode `none` the agent runs as the host user and already reaches the host's socket at its own path;
    // there is nothing to bind and nothing to report.
    this.docker = this.sandbox === "bwrap" ? dockerSocket(opts.docker, opts.dockerSocketPath, this.log) : undefined;
    if (this.docker) this.log(`[fence] docker: ${this.docker} is bound into every fence (socket access is host root)`);
    // Worth saying once, because the failure it predicts looks like a broken stack rather than a fence rule:
    // egress mode has no route to the host's loopback, so a container that publishes a port there — the
    // default for `network_mode: host` with a loopback bind address — is unreachable from the fence that
    // started it. The fence can still reach a container on a bridge network by its address.
    if (this.docker && this.network === "egress") {
      this.log('[fence] docker: containers listening on the host\'s loopback cannot be reached from network mode "egress"; set fence.network to "host" to reach them');
    }
  }

  get mode(): "bwrap" | "none" {
    return this.sandbox;
  }

  get networkMode(): "egress" | "none" | "host" {
    return this.network;
  }

  /** The host's Docker socket every fence is given, or undefined when no fence has Docker. */
  get dockerMode(): string | undefined {
    return this.docker;
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
    // The fence reads its own limits under /sys/fs/cgroup: at the mount root when it gets a cgroup
    // namespace, at the path /proc/self/cgroup names when it cannot. `openGate` creates that directory
    // before it opens the gate, so it is there by the time bubblewrap execs, and puts the process in it
    // before bubblewrap unshares, so the namespace is rooted at the fence's own group. When limits are off
    // there is no directory to name and no namespace to take.
    // The agent is started before bubblewrap, because its socket is one of the paths bound into the fence.
    // It is a kernel-owned child like the egress helper: the fence talks to it, never holds what it holds.
    const ssh = this.sandbox === "bwrap" ? this.openSsh(us) : undefined;
    const child = this.spawn(us, cgroups && cgroups.fence(us.id, this.cgroupNamespace()), ssh);
    const cleanup: (() => void)[] = ssh ? [ssh.stop] : [];
    try {
      if (this.sandbox === "bwrap") await this.openGate(us, child, cgroups, cleanup, ssh);
    } catch (err) {
      child.kill("SIGKILL");
      for (const fn of cleanup) fn();
      throw new CodedError(`fence for ${us.id} could not start: ${errorMessage(err)}`, "fence");
    }
    const handle = new ProcessHandle(child, us, rpc, { requestTimeoutMs: this.opts.requestTimeoutMs, log: this.log }, cleanup);
    await handle.request("ping", {});
    return Object.assign(handle, { openedAt });
  }

  /**
   * Whether this host can give a fence its own cgroup namespace. Probed once, on the first open that has a
   * cgroup to bind — a one-shot command that opens no fence never runs bubblewrap for it — and a `false`
   * only falls back to the older layout, it never fails a fence.
   */
  private cgroupNamespace(): boolean {
    return (this.namespaced ??= hasCgroupNamespace());
  }

  /**
   * This fence's own ssh agent, holding only the keys granted to this person. Undefined when there is no
   * grant, when the host has no `ssh-agent`, or when no granted key could be loaded: a fence without ssh
   * opens exactly as it did before, and a credential problem never costs someone their workspace.
   */
  private openSsh(us: Userspace): SshAgent | undefined {
    const grants = us.ssh ?? [];
    if (!grants.length) return undefined;
    const files = writeSshFiles(join(this.opts.sshDir, us.id), knownHostsOf(grants));
    return startSshAgent(files, grants.map((g) => g.key), this.log);
  }

  private async openGate(us: Userspace, child: ChildProcess, cgroups: Cgroups | undefined, cleanup: (() => void)[], ssh?: SshAgent): Promise<void> {
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
    // The agent belongs to this fence, so it is accounted to this fence, exactly as the egress helper is.
    if (ssh && placement) placement.attach(ssh.pid);
    (child.stdio as unknown as (Writable | null)[])[5]?.end("go\n");
    this.log(`[fence] ${us.id}: started (network ${this.network}${placement ? ", limited" : ""}${this.docker ? ", docker" : ""}${ssh ? ", ssh" : ""})`);
  }

  private spawn(space: Userspace, cgroup?: FenceCgroup, ssh?: SshAgent): ChildProcess {
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
      // Set only when the socket is really bound, so a tool asks the environment what this fence has rather
      // than probing a path and guessing why it is missing — the same reason `THETIS_MOUNTS` reports the
      // mounts that were bound and not the ones that were asked for.
      ...(this.docker ? { THETIS_DOCKER: FENCE_DOCKER_SOCKET } : {}),
      // Set only when an agent is really running with a key in it, for the same reason as the two above:
      // the fence asks what it has rather than probing a path and guessing why a connection was refused.
      // `SSH_AUTH_SOCK` is what ssh itself reads; `THETIS_SSH` is what a tool or a skill checks.
      ...(ssh ? { SSH_AUTH_SOCK: FENCE_SSH_AUTH_SOCK, THETIS_SSH: FENCE_SSH_AUTH_SOCK } : {}),
    };
    const node = [process.execPath, this.opts.agentPath];
    if (this.sandbox === "none") {
      return spawn(node[0], node.slice(1), { cwd: us.home, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    const layout = { ...this.opts, network: this.network, cgroup, dockerSocket: this.docker, ssh };
    const cmd = launcherCommand(["bwrap", ...bwrapArgs(us, layout, env, this.log), "--", ...node], this.network);
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
