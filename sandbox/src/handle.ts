// One live agent process, and the frames that cross it in both directions.
import type { ChildProcess } from "node:child_process";
import type { EventSink, FenceHandle, KernelRpc, Userspace } from "@thetis/contracts";
import { CodedError } from "@thetis/lib/error";
import { callHandler, encodeFrame, PendingCalls, readFrames, type Frame, type OpenCall } from "@thetis/lib/rpc-frames";

export interface HandleOptions {
  requestTimeoutMs: number;
  log: (line: string) => void;
}

/**
 * Kernel to agent: `{ id, op, payload }`, answered by `{ id, event }`* and `{ id, result | error }`;
 * `{ cancel: id }` aborts one request. Agent to kernel: `{ rpc, method, args }`, answered by
 * `{ rpcEvent, event }`* and `{ rpcResult, result | error, code }`.
 */
export class ProcessHandle implements FenceHandle {
  private readonly pending = new PendingCalls("r");
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly us: Userspace,
    private readonly rpc: KernelRpc,
    private readonly opts: HandleOptions,
    private readonly cleanup: (() => void)[] = [],
  ) {
    if (child.stdout) readFrames(child.stdout, (msg) => this.onFrame(msg), (line) => opts.log(`[${us.id}] stray output: ${line}`));
    if (child.stderr) readFrames(child.stderr, () => {}, (line) => opts.log(`[${us.id}] ${line}`));
    child.on("exit", (code) => this.onExit(code));
  }

  request(op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodedError(`fence for ${this.us.id} is closed`, "fence"));
    if (signal?.aborted) return Promise.reject(new CodedError(`fence request ${op} cancelled`, "cancelled"));
    const call: OpenCall = { onEvent };
    const { id, result } = this.pending.open(call);
    const timer = setTimeout(() => this.pending.settle(id, undefined, new CodedError(`fence request ${op} timed out`, "fence")), this.opts.requestTimeoutMs);
    const onAbort = () => {
      this.send({ cancel: id });
      this.pending.settle(id, undefined, new CodedError(`fence request ${op} cancelled`, "cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    call.cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    this.send({ id, op, payload });
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGTERM");
  }

  private send(msg: unknown): void {
    if (this.child.stdin?.writable) this.child.stdin.write(encodeFrame(msg));
  }

  private onFrame(msg: Frame): void {
    if (typeof msg.rpc === "string") {
      void this.serveRpc(msg.rpc, String(msg.method), msg.args);
      return;
    }
    // Package code raised the error: the agent reports it without a code.
    this.pending.receive({ id: String(msg.id), ...msg }, "package");
  }

  private async serveRpc(rid: string, method: string, args: unknown): Promise<void> {
    const outcome = await callHandler(this.rpc, method, args, (event) => this.send({ rpcEvent: rid, event }));
    this.send({ rpcResult: rid, ...outcome });
  }

  private onExit(code: number | null): void {
    this.closed = true;
    for (const fn of this.cleanup) fn();
    this.pending.failAll(new CodedError(`userspace agent for ${this.us.id} exited (${code ?? "signal"})`, "fence"));
  }
}
