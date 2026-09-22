// One live agent process, and the frames that cross it in both directions.
import type { ChildProcess } from "node:child_process";
import type { EventSink, FenceHandle, KernelRpc, Userspace } from "@thetis/contracts";
import { CodedError, errorMessage } from "@thetis/lib/error";
import { callHandler, encodeFrame, PendingCalls, readFrames, type Frame, type OpenCall } from "@thetis/lib/rpc-frames";

/** What this package's handles carry beyond the fence contract: when the agent was spawned, and a promise
 *  that resolves when it is gone. A `Fence` that returns a plainer handle simply offers neither. */
export interface SandboxHandle extends FenceHandle {
  openedAt: number;
  gone: Promise<void>;
}

export interface HandleOptions {
  requestTimeoutMs: number;
  /** How long `close` waits for the agent to exit after SIGTERM before it kills it. */
  exitGraceMs?: number;
  /** How long a cancelled request may still answer before it is settled as cancelled. Default `CANCEL_GRACE_MS`. */
  cancelGraceMs?: number;
  log: (line: string) => void;
}

const EXIT_GRACE_MS = 2_000;
/**
 * How long a cancelled request is given to answer. The cancel reaches a step as its signal, and a step that
 * was stopped returns what it has: the text streamed so far, the tool calls closed. Settling at once would
 * throw that away, so the reply is waited for; one that never comes settles with code `cancelled` here.
 */
export const CANCEL_GRACE_MS = 5_000;
/**
 * How long the agent is given to answer `shutdown`. The ask exists because the signal does not arrive: with
 * bubblewrap the child of this process is the sandbox, and `bwrap --unshare-pid` does not forward SIGTERM to
 * the agent inside it, so a service's `stop()` — and the socket it unlinks — runs only when it is asked for
 * over the protocol. Well inside the exit grace, because a fence that will not answer must still die on time.
 */
const SHUTDOWN_MS = 500;

/**
 * Kernel to agent: `{ id, op, payload }`, answered by `{ id, event }`* and `{ id, result | error }`;
 * `{ cancel: id }` aborts one request. Agent to kernel: `{ rpc, method, args }`, answered by
 * `{ rpcEvent, event }`* and `{ rpcResult, result | error, code }`; `{ rpcCancel: rpc }` aborts one call.
 */
export class ProcessHandle implements FenceHandle {
  private readonly pending = new PendingCalls("r");
  /** Aborts when the agent is gone: every RPC it opened is served with a signal that follows it, so a kernel method that streams for the life of the fence ends with it. */
  private readonly life = new AbortController();
  /** The RPCs the agent opened and the kernel is still serving, by the agent's id, so `{ rpcCancel }` can abort one. */
  private readonly served = new Map<string, AbortController>();
  /** Resolves when the agent process is gone, so the pool can forget a handle the moment it is a corpse. */
  readonly gone: Promise<void>;
  private closed = false;
  /** Set before the stop is asked for, because `closed` cannot be: the ask itself goes through `request`. */
  private closing = false;

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
    this.gone = new Promise((done) => child.once("exit", () => done()).once("error", () => done()));
  }

  request(op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodedError(`fence for ${this.us.id} is closed`, "fence"));
    if (signal?.aborted) return Promise.reject(new CodedError(`fence request ${op} cancelled`, "cancelled"));
    const call: OpenCall = { onEvent };
    const { id, result } = this.pending.open(call);
    const timer = setTimeout(() => this.pending.settle(id, undefined, new CodedError(`fence request ${op} timed out`, "fence")), this.opts.requestTimeoutMs);
    let grace: NodeJS.Timeout | undefined;
    // The agent is told; its reply within the grace is delivered as any other, since a stopped step returns what it kept.
    const onAbort = () => {
      this.send({ cancel: id });
      grace = setTimeout(() => this.pending.settle(id, undefined, new CodedError(`fence request ${op} cancelled`, "cancelled")), this.opts.cancelGraceMs ?? CANCEL_GRACE_MS);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    call.cleanup = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
    };
    this.send({ id, op, payload });
    return result;
  }

  /**
   * Stops the services, then asks the agent to exit and waits until it has; one that is still there after the
   * grace period is killed. The stop is asked for rather than signalled, for the reason at `SHUTDOWN_MS`.
   */
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    await this.shutdown();
    this.closed = true;
    const killer = setTimeout(() => {
      this.opts.log(`[fence] ${this.us.id}: agent did not exit on SIGTERM; killed`);
      this.child.kill("SIGKILL");
    }, this.opts.exitGraceMs ?? EXIT_GRACE_MS);
    this.child.kill("SIGTERM");
    await this.gone;
    clearTimeout(killer);
  }

  /** Asks the agent to stop its services. A refusal, a silence or a deadline is logged and then ignored: the
   *  close carries on regardless, because a fence that cannot be asked still has to go. */
  private async shutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new CodedError(`it did not answer within ${SHUTDOWN_MS} ms`, "fence")), SHUTDOWN_MS).unref();
      });
      await Promise.race([this.request("shutdown", {}), deadline]);
    } catch (err) {
      this.opts.log(`[fence] ${this.us.id}: the services were not stopped before the close (${errorMessage(err)})`);
    } finally {
      clearTimeout(timer);
    }
  }

  private send(msg: unknown): void {
    if (this.child.stdin?.writable) this.child.stdin.write(encodeFrame(msg));
  }

  private onFrame(msg: Frame): void {
    if (typeof msg.rpc === "string") {
      void this.serveRpc(msg.rpc, String(msg.method), msg.args);
      return;
    }
    if (typeof msg.rpcCancel === "string") {
      this.served.get(msg.rpcCancel)?.abort();
      return;
    }
    // Package code raised the error: the agent reports it without a code.
    this.pending.receive({ id: String(msg.id), ...msg }, "package");
  }

  /** Each call is served with its own signal: `{ rpcCancel }` aborts that one, and the agent's exit aborts them all. */
  private async serveRpc(rid: string, method: string, args: unknown): Promise<void> {
    const control = new AbortController();
    const onLife = () => control.abort();
    this.life.signal.addEventListener("abort", onLife, { once: true });
    this.served.set(rid, control);
    try {
      const outcome = await callHandler(this.rpc, method, args, (event) => this.send({ rpcEvent: rid, event }), control.signal);
      this.send({ rpcResult: rid, ...outcome });
    } finally {
      this.served.delete(rid);
      this.life.signal.removeEventListener("abort", onLife);
    }
  }

  private onExit(code: number | null): void {
    this.closed = true;
    this.life.abort();
    for (const fn of this.cleanup) fn();
    this.pending.failAll(new CodedError(`userspace agent for ${this.us.id} exited (${code ?? "signal"})`, "fence"));
  }
}
