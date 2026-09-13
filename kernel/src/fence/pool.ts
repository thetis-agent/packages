import type { Userspace } from "../types.js";
import type { Fence, FenceHandle, KernelRpc } from "./fence.js";

/** Keeps at most one open fence per userspace, opening lazily and re-opening after a crash. */
export class FencePool {
  private readonly handles = new Map<string, Promise<FenceHandle>>();

  constructor(
    private readonly fence: Fence,
    private readonly rpcFor: (us: Userspace) => KernelRpc,
  ) {}

  handle(us: Userspace): Promise<FenceHandle> {
    let h = this.handles.get(us.id);
    if (!h) {
      h = this.fence.open(us, this.rpcFor(us)).catch((err) => {
        this.handles.delete(us.id);
        throw err;
      });
      this.handles.set(us.id, h);
    }
    return h;
  }

  /** Sends one request, dropping the handle if the agent died so the next call reopens it. */
  async request(us: Userspace, op: string, payload: unknown, onEvent?: (e: unknown) => void): Promise<unknown> {
    const h = await this.handle(us);
    try {
      return await h.request(op, payload, onEvent);
    } catch (err) {
      if ((err as { code?: string }).code === "fence") this.handles.delete(us.id);
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
