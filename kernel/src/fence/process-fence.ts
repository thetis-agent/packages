import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { existsSync, readlinkSync } from "node:fs";
import type { Userspace } from "../types.js";
import { KernelError } from "../util.js";
import type { EventSink, Fence, FenceHandle, KernelRpc } from "./fence.js";

export interface ProcessFenceOptions {
  agentPath: string;
  sandbox: "auto" | "bwrap" | "none";
  /** Host paths the agent may read besides the OS (the package tree, for system packages). */
  readOnly: string[];
  /** Host paths masked with an empty tmpfs even if a parent is bound (the service-plane data dir). */
  hidden: string[];
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

  constructor(private readonly opts: ProcessFenceOptions) {
    this.sandbox = opts.sandbox === "auto" ? (hasBwrap() ? "bwrap" : "none") : opts.sandbox;
  }

  get mode(): "bwrap" | "none" {
    return this.sandbox;
  }

  async open(us: Userspace, rpc: KernelRpc): Promise<FenceHandle> {
    const child = this.spawn(us);
    const handle = new ProcessHandle(child, us, rpc, this.opts);
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
    args.push("--bind", us.root, us.root, "--chdir", us.home);
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session");
    for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
    return spawn("bwrap", [...args, "--", ...node], { env, stdio: ["pipe", "pipe", "pipe"] });
  }
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
