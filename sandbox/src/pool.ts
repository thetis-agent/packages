import type { EventSink, Fence, FenceHandle, Fences, KernelRpc, Userspace } from "@thetis/contracts";
import { errorCode } from "@thetis/lib/error";
import type { SandboxHandle } from "./handle.js";

/** Keeps at most one open fence per userspace, opening lazily and re-opening after a crash. */
export class FencePool implements Fences {
  private readonly handles = new Map<string, Promise<FenceHandle>>();
  /** When each open fence opened, for the reader that asks what code a running fence is holding. */
  private readonly opened = new Map<string, number>();

  constructor(
    private readonly fence: Fence,
    private readonly rpcFor: (us: Userspace) => KernelRpc,
    private readonly onOpen?: (us: Userspace, handle: FenceHandle) => Promise<void>,
  ) {}

  /** The handle for a userspace, opening the fence on first use. `onOpen` runs on the new handle before anyone else uses it. */
  handle(us: Userspace): Promise<FenceHandle> {
    const held = this.handles.get(us.id);
    if (held) return held;
    const opening: Promise<FenceHandle> = this.fence
      .open(us, this.rpcFor(us))
      .then(async (handle) => {
        await this.onOpen?.(us, handle);
        const sandboxed = handle as Partial<SandboxHandle>;
        // The fence stamps the handle with the moment its agent was spawned, which is when its modules were
        // read; a fence that stamps nothing is taken to have opened now.
        this.opened.set(us.id, sandboxed.openedAt ?? Date.now());
        // A dead agent is forgotten as soon as it dies, not when something next fails on it: a corpse in the
        // map is a userspace nothing can reopen, because whoever asks for a handle is handed the corpse.
        void sandboxed.gone?.then(() => {
          if (this.handles.get(us.id) === opening) this.forget(us.id);
        });
        return handle;
      })
      .catch((err: unknown) => {
        this.forget(us.id);
        throw err;
      });
    this.handles.set(us.id, opening);
    return opening;
  }

  /** Sends one request, dropping the handle if the agent died so the next call reopens it. */
  async request(us: Userspace, op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    const h = await this.handle(us);
    try {
      return await h.request(op, payload, onEvent, signal);
    } catch (err) {
      if (errorCode(err) === "fence") this.forget(us.id);
      throw err;
    }
  }

  /** Closes one fence, or every fence at once: each waits for its agent, so they are not waited for in turn. */
  async close(id?: string): Promise<void> {
    const ids = id ? [id] : [...this.handles.keys()];
    await Promise.all(
      ids.map((key) => {
        const h = this.handles.get(key);
        this.forget(key);
        return h?.then((x) => x.close()).catch(() => {});
      }),
    );
  }

  /** The open fences and when each opened, by userspace. A userspace with no fence open is absent. */
  openedAt(): Record<string, number> {
    return Object.fromEntries(this.opened);
  }

  private forget(id: string): void {
    this.handles.delete(id);
    this.opened.delete(id);
  }
}
