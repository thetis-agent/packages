// Newline-delimited JSON request/reply framing, shared by the control socket, the fence, and the agent.
// A request is `{ id, method, args }`; the replies are `{ id, event }`* and then one `{ id, result }` or
// `{ id, error, code }`. The same shape flows in both directions of the fence under other key names.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EventSink } from "@thetis/contracts";
import { CodedError, errorCode, errorMessage } from "./error.js";

export type RpcHandler = (method: string, args: unknown, emit?: EventSink) => Promise<unknown>;

export type Frame = Record<string, unknown>;

/** A reply as it arrives: one of `event`, `result`, or `error` is present. */
export interface ReplyFrame {
  id: string;
  event?: unknown;
  result?: unknown;
  error?: unknown;
  code?: unknown;
}

export type Outcome = { result: unknown } | { error: string; code?: string };

/** What a caller attaches to a call it opens. `cleanup` runs once, when the call settles for any reason. */
export interface OpenCall {
  onEvent?: EventSink;
  cleanup?: () => void;
}

interface Pending {
  /** The caller's own object, kept by reference: it may set `cleanup` after `open` returns. */
  call: OpenCall;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** The calls in flight on one connection, keyed by id. */
export class PendingCalls {
  private readonly calls = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly prefix: string) {}

  get size(): number {
    return this.calls.size;
  }

  open(call: OpenCall = {}): { id: string; result: Promise<unknown> } {
    const id = `${this.prefix}${++this.seq}`;
    const result = new Promise<unknown>((resolve, reject) => this.calls.set(id, { call, resolve, reject }));
    return { id, result };
  }

  /** Routes one reply to its call. Returns false when no call has that id. */
  receive(frame: ReplyFrame, defaultCode = "rpc"): boolean {
    const id = String(frame.id);
    const p = this.calls.get(id);
    if (!p) return false;
    if ("event" in frame) {
      p.call.onEvent?.(frame.event);
      return true;
    }
    if (frame.error !== undefined) {
      const code = typeof frame.code === "string" ? frame.code : defaultCode;
      return this.settle(id, undefined, new CodedError(String(frame.error), code));
    }
    return this.settle(id, frame.result);
  }

  settle(id: string, result: unknown, error?: unknown): boolean {
    const p = this.calls.get(id);
    if (!p) return false;
    this.calls.delete(id);
    p.call.cleanup?.();
    if (error) p.reject(error);
    else p.resolve(result);
    return true;
  }

  failAll(error: unknown): void {
    for (const id of [...this.calls.keys()]) this.settle(id, undefined, error);
  }
}

/** Runs one request and turns the outcome into the reply fields, so every server answers the same way. */
export async function callHandler(handler: RpcHandler, method: string, args: unknown, emit?: EventSink): Promise<Outcome> {
  try {
    return { result: (await handler(method, args, emit)) ?? null };
  } catch (err) {
    return { error: errorMessage(err), code: errorCode(err) };
  }
}

export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

/** Reads frames off a stream one line at a time. A line that is not a JSON object goes to `onStray`. */
export function readFrames(input: Readable, onFrame: (msg: Frame) => void, onStray?: (line: string) => void): void {
  createInterface({ input }).on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      onStray?.(line);
      return;
    }
    if (msg && typeof msg === "object" && !Array.isArray(msg)) onFrame(msg as Frame);
    else onStray?.(line);
  });
}
