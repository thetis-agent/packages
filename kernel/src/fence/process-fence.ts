import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { existsSync, readlinkSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { SYSTEM_USER, type Userspace } from "../types.js";
import { KernelError } from "../util.js";
import type { Cgroups, FenceLimits } from "./cgroup.js";
import type { EventSink, Fence, FenceHandle, KernelRpc } from "./fence.js";
import { hasSlirp, startEgress } from "./network.js";

export type FenceNetwork = "auto" | "egress" | "none" | "host";

export interface ProcessFenceOptions {
  agentPath: string;
  sandbox: "auto" | "bwrap" | "none";
  /** Host paths the agent may read besides the OS (the package tree, for system packages). */
  readOnly: string[];
  /** Host paths masked with an empty tmpfs even if a parent is bound (the service-plane data dir). */
  hidden: string[];
  /** Writable for the system userspace, read-only for every other fence. */
  sharedDir: string;
  /** `egress`: a private network namespace with outbound NAT and no host loopback. `none`: no network. `host`: the host's namespace. */
  network: FenceNetwork;
  /** The resolver file bound over /etc/resolv.conf in egress mode. */
  resolvConf: string;
  limits: FenceLimits;
  /** Resolved on the first sandboxed open, so a one-shot command that opens no fence never probes the cgroup. */
  cgroups?: () => Cgroups | undefined;
  requestTimeoutMs: number;
  log?: (line: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onEvent?: EventSink;
  timer: NodeJS.Timeout;
  unlisten?: () => void;
}

/**
 * Runs one long-lived agent process per userspace. With bubblewrap available the agent
 * gets its own PID/IPC/UTS namespaces, a read-only view of the host, and a writable bind
 * of its userspace only. Protocol: newline-delimited JSON over stdio.
 */
export class ProcessFence implements Fence {
  private readonly sandbox: "bwrap" | "none";
  private readonly network: "egress" | "none" | "host";

  constructor(private readonly opts: ProcessFenceOptions) {
    this.sandbox = opts.sandbox === "auto" ? (hasBwrap() ? "bwrap" : "none") : opts.sandbox;
    this.network = this.sandbox === "none" || opts.network === "host" ? "host" : opts.network === "auto" ? (hasSlirp() ? "egress" : "host") : opts.network;
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
  async open(us: Userspace, rpc: KernelRpc): Promise<FenceHandle> {
    // The cgroup is adopted before the first child exists: enabling controllers needs the parent group empty.
    const cgroups = this.sandbox === "bwrap" ? this.opts.cgroups?.() : undefined;
    const child = this.spawn(us);
    const cleanup: (() => void)[] = [];
    try {
      if (this.sandbox === "bwrap") {
        await ready(child);
        const placement = cgroups?.place(us.id, this.opts.limits);
        if (placement) {
          placement.attach(child.pid!);
          cleanup.push(placement.release);
        }
        if (this.network === "egress") {
          const egress = await startEgress(child.pid!, this.opts.log ?? (() => {}));
          placement?.attach(egress.pid);
          cleanup.push(egress.stop);
        }
        (child.stdio as unknown as Writable[])[5].end("go\n");
        this.opts.log?.(`[fence] ${us.id}: started (network ${this.network}${placement ? ", limited" : ""})`);
      }
    } catch (err) {
      child.kill("SIGKILL");
      for (const fn of cleanup) fn();
      throw new KernelError(`fence for ${us.id} could not start: ${(err as Error).message}`, "fence");
    }
    const handle = new ProcessHandle(child, us, rpc, this.opts, cleanup);
    await handle.request("ping", {});
    return handle;
  }

  private spawn(us: Userspace): ChildProcess {
    const env = {
      PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
      HOME: us.home,
      LANG: process.env.LANG ?? "C.UTF-8",
      THETIS_USERSPACE: us.root,
      THETIS_HOME_DIR: us.home,
      THETIS_STORE: us.store,
      THETIS_SHARED: this.opts.sharedDir,
      THETIS_USER: us.id,
    };
    const node = [process.execPath, this.opts.agentPath];
    if (this.sandbox === "none") {
      return spawn(node[0], node.slice(1), { cwd: us.home, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    const args = ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
    // Hidden directories are masked first, so a read-only bind inside one (the promoted packages) still shows.
    for (const dir of this.opts.hidden) args.push("--tmpfs", dir);
    for (const dir of ["/usr", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib32", "/lib64", nodePrefix(), ...this.opts.readOnly]) {
      if (!existsSync(dir)) continue;
      const link = linkTarget(dir);
      if (link) args.push("--symlink", link, dir);
      else args.push("--ro-bind", dir, dir);
    }
    if (existsSync(this.opts.sharedDir)) args.push(us.id === SYSTEM_USER ? "--bind" : "--ro-bind", this.opts.sharedDir, this.opts.sharedDir);
    if (this.network === "egress" && existsSync(this.opts.resolvConf)) args.push("--ro-bind", this.opts.resolvConf, "/etc/resolv.conf");
    args.push("--bind", us.root, us.root, "--chdir", us.home);
    args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--cap-drop", "ALL", "--disable-userns", "--die-with-parent", "--new-session");
    if (this.network === "none") args.push("--unshare-net");
    for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
    // fd 5 is the launch gate, fd 6 says the namespace exists. In egress mode `unshare` makes the private
    // network namespace before bubblewrap runs, because slirp4netns cannot enter one bubblewrap made itself.
    const script = 'printf ready >&6; read -r go <&5 || exit 97; exec "$@"';
    const inner = ["bwrap", ...args, "--", ...node];
    const cmd = this.network === "egress" ? ["unshare", "--map-root-user", "--net", "--", "/bin/sh", "-c", script, "sh", ...inner] : ["/bin/sh", "-c", script, "sh", ...inner];
    return spawn(cmd[0], cmd.slice(1), { env, stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"] });
  }
}

/** Resolves once the launcher script reports that it runs (and so its namespaces exist). */
function ready(child: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the sandbox launcher did not start")), 10_000);
    (child.stdio as unknown as Readable[])[6].once("data", () => (clearTimeout(timer), done()));
    child.once("exit", (code) => (clearTimeout(timer), fail(new Error(`the sandbox launcher exited (${code})`))));
    child.once("error", (err) => (clearTimeout(timer), fail(err)));
  });
}

class ProcessHandle implements FenceHandle {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly us: Userspace,
    private readonly rpc: KernelRpc,
    private readonly opts: ProcessFenceOptions,
    private readonly cleanup: (() => void)[] = [],
  ) {
    const log = opts.log ?? (() => {});
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr! }).on("line", (line) => log(`[${us.id}] ${line}`));
    child.on("exit", (code) => this.onExit(code));
  }

  request(op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new KernelError(`fence for ${this.us.id} is closed`, "fence"));
    if (signal?.aborted) return Promise.reject(new KernelError(`fence request ${op} cancelled`, "cancelled"));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, undefined, new KernelError(`fence request ${op} timed out`, "fence")), this.opts.requestTimeoutMs);
      const onAbort = () => {
        this.send({ cancel: id });
        this.settle(id, undefined, new KernelError(`fence request ${op} cancelled`, "cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, onEvent, timer, unlisten: () => signal?.removeEventListener("abort", onAbort) });
      this.send({ id, op, payload });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGTERM");
  }

  private send(msg: unknown): void {
    if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log?.(`[${this.us.id}] stray output: ${line}`);
      return;
    }
    if (typeof msg.rpc === "string") return void this.serveRpc(msg.rpc, String(msg.method), msg.args);
    const id = String(msg.id);
    const p = this.pending.get(id);
    if (!p) return;
    if ("event" in msg) return p.onEvent?.(msg.event);
    if ("error" in msg) return this.settle(id, undefined, new KernelError(String(msg.error), "package"));
    this.settle(id, msg.result, undefined);
  }

  private async serveRpc(rid: string, method: string, args: unknown): Promise<void> {
    try {
      this.send({ rpcResult: rid, result: await this.rpc(method, args, (event) => this.send({ rpcEvent: rid, event })) });
    } catch (err) {
      this.send({ rpcResult: rid, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code });
    }
  }

  private settle(id: string, result: unknown, error: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.unlisten?.();
    if (error) p.reject(error);
    else p.resolve(result);
  }

  private onExit(code: number | null): void {
    this.closed = true;
    for (const fn of this.cleanup) fn();
    const err = new KernelError(`userspace agent for ${this.us.id} exited (${code ?? "signal"})`, "fence");
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, err);
  }
}

function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

function nodePrefix(): string {
  return dirname(dirname(process.execPath));
}

function linkTarget(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}
