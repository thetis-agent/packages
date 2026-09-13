import type { Userspace } from "../types.js";

/** A request from inside the fence back to the kernel (package install, subagent spawn...). */
export type KernelRpc = (method: string, args: unknown) => Promise<unknown>;

export type EventSink = (event: unknown) => void;

/** A live channel into one userspace. Every crossing of the fence goes through here. */
export interface FenceHandle {
  request(op: string, payload: unknown, onEvent?: EventSink): Promise<unknown>;
  close(): Promise<void>;
}

export interface Fence {
  open(userspace: Userspace, rpc: KernelRpc): Promise<FenceHandle>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
