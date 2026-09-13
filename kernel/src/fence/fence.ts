import type { Userspace } from "../types.js";

/** A request from inside the fence back to the kernel (package install, subagent spawn...). */
export type KernelRpc = (method: string, args: unknown) => Promise<unknown>;

export type EventSink = (event: unknown) => void;

/** A live channel into one userspace. Every crossing of the fence goes through here. */
export interface FenceHandle {
  /** Sends one operation. An aborted `signal` cancels it: the agent is told, and the promise rejects with code `cancelled`. */
  request(op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown>;
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
