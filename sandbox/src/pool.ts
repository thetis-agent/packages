import type { EventSink, Fence, FenceHandle, Fences, KernelRpc, Userspace } from "@thetis/contracts";
import { errorCode } from "@thetis/lib/error";

/** Keeps at most one open fence per userspace, opening lazily and re-opening after a crash. */
export class FencePool implements Fences {
  private readonly handles = new Map<string, Promise<FenceHandle>>();

  constructor(
    private readonly fence: Fence,
    private readonly rpcFor: (us: Userspace) => KernelRpc,
    private readonly onOpen?: (us: Userspace, handle: FenceHandle) => Promise<void>,
  ) {}

  /** The handle for a userspace, opening the fence on first use. `onOpen` runs on the new handle before anyone else uses it. */
  handle(us: Userspace): Promise<FenceHandle> {
    let h = this.handles.get(us.id);
    if (!h) {
      h = this.fence
        .open(us, this.rpcFor(us))
        .then(async (handle) => {
          await this.onOpen?.(us, handle);
          return handle;
        })
        .catch((err: unknown) => {
          this.handles.delete(us.id);
          throw err;
        });
      this.handles.set(us.id, h);
    }
    return h;
  }

  /** Sends one request, dropping the handle if the agent died so the next call reopens it. */
  async request(us: Userspace, op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    const h = await this.handle(us);
    try {
      return await h.request(op, payload, onEvent, signal);
    } catch (err) {
      if (errorCode(err) === "fence") this.handles.delete(us.id);
      throw err;
    }
  }

  async close(id?: string): Promise<void> {
    const ids = id ? [id] : [...this.handles.keys()];
    for (const key of ids) {
      const h = this.handles.get(key);
      this.handles.delete(key);
      if (h) await h.then((x) => x.close()).catch(() => {});
    }
  }
}
