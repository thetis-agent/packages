// A process handle over a child that ignores SIGTERM: close must still return, by killing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Userspace } from "@thetis/contracts";
import { ProcessHandle } from "../src/handle.js";

const us = { id: "alice", root: "/nowhere", home: "/nowhere", store: "/nowhere", run: "/nowhere", mounts: [] } as unknown as Userspace;

test("close waits for the agent to exit and kills one that ignores SIGTERM", async () => {
  const lines: string[] = [];
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.error('ready')"], { stdio: ["pipe", "pipe", "pipe"] });
  const handle = new ProcessHandle(stubborn, us, async () => null, { requestTimeoutMs: 1000, exitGraceMs: 300, log: (l) => lines.push(l) });
  // The handle relays the child's stderr to the log; the handler is in place once the child says so.
  while (!lines.some((l) => /ready/.test(l))) await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  await handle.close();
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 2000, `close took ${took} ms`);
  assert.equal(stubborn.exitCode ?? stubborn.signalCode, "SIGKILL");
  assert.ok(lines.some((l) => /did not exit/.test(l)));

  const polite = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const quick = new ProcessHandle(polite, us, async () => null, { requestTimeoutMs: 1000, exitGraceMs: 5000, log: () => {} });
  const t = Date.now();
  await quick.close();
  assert.ok(Date.now() - t < 1000, "a child that honours SIGTERM is not waited on for the grace period");
  assert.equal(polite.signalCode, "SIGTERM");
  await assert.rejects(quick.request("ping", {}), /closed/);
});

/**
 * A child that speaks the agent's protocol for the cancellation tests. `slow` answers 100 ms after it is
 * cancelled; `deaf` never answers; `ask` opens one RPC to the kernel, cancels it after 100 ms, and answers
 * with the outcome the kernel sent back; `ask-and-die` opens one RPC and exits.
 */
const AGENT = `
  const rl = require("node:readline").createInterface({ input: process.stdin });
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const onCancel = new Map();
  let asking;
  rl.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.op === "slow") { onCancel.set(m.id, () => setTimeout(() => out({ id: m.id, result: "partial" }), 100)); return; }
    if (m.op === "deaf") return;
    if (m.op === "ask") { asking = m.id; out({ rpc: "k1", method: "wait", args: {} }); setTimeout(() => out({ rpcCancel: "k1" }), 100); return; }
    if (m.op === "ask-and-die") { out({ rpc: "k2", method: "wait", args: {} }); setTimeout(() => process.exit(0), 100); return; }
    if (typeof m.cancel === "string") { onCancel.get(m.cancel)?.(); return; }
    if (typeof m.rpcResult === "string") { out({ id: asking, result: m }); return; }
  });
  console.error("ready");
`;

/** A handle over the protocol child, whose kernel side answers `wait` when its signal aborts. */
async function agent(opts: { cancelGraceMs?: number; requestTimeoutMs?: number } = {}) {
  const lines: string[] = [];
  const signals: AbortSignal[] = [];
  const child = spawn(process.execPath, ["-e", AGENT], { stdio: ["pipe", "pipe", "pipe"] });
  const rpc = (_method: string, _args: unknown, _emit?: unknown, signal?: AbortSignal) =>
    new Promise<unknown>((res) => {
      signals.push(signal!);
      signal!.addEventListener("abort", () => res("aborted"), { once: true });
    });
  const handle = new ProcessHandle(child, us, rpc, { requestTimeoutMs: opts.requestTimeoutMs ?? 5000, cancelGraceMs: opts.cancelGraceMs, exitGraceMs: 300, log: (l) => lines.push(l) });
  while (!lines.some((l) => /ready/.test(l))) await new Promise((r) => setTimeout(r, 10));
  return { handle, signals, lines };
}

test("rpcCancel aborts the one served call it names, and the agent gets that call's outcome", async () => {
  const { handle, signals } = await agent();
  try {
    const outcome = await handle.request("ask", {});
    assert.deepEqual(outcome, { rpcResult: "k1", result: "aborted" });
    assert.equal(signals.length, 1);
    assert.ok(signals[0].aborted);
  } finally {
    await handle.close();
  }
});

test("the agent's exit aborts every call it still had open", async () => {
  const { handle, signals } = await agent();
  await assert.rejects(handle.request("ask-and-die", {}), /exited/);
  await handle.gone;
  assert.equal(signals.length, 1);
  assert.ok(signals[0].aborted, "the served call's signal followed the agent out");
});

test("a cancelled request is told, and its answer within the grace is delivered", async () => {
  const { handle } = await agent({ cancelGraceMs: 1000 });
  try {
    const control = new AbortController();
    const result = handle.request("slow", {}, undefined, control.signal);
    setTimeout(() => control.abort(), 50);
    assert.equal(await result, "partial", "what the stopped step returned reaches the caller");
  } finally {
    await handle.close();
  }
});

test("a cancelled request that never answers settles as cancelled when the grace runs out; one never answered at all times out", async () => {
  const { handle } = await agent({ cancelGraceMs: 200, requestTimeoutMs: 300 });
  try {
    const control = new AbortController();
    const result = handle.request("deaf", {}, undefined, control.signal);
    const started = Date.now();
    setTimeout(() => control.abort(), 20);
    await assert.rejects(result, (err: { code?: string; message: string }) => err.code === "cancelled" && /cancelled/.test(err.message));
    const took = Date.now() - started;
    assert.ok(took >= 200 && took < 300, `settled after the grace, before the timeout: ${took} ms`);
    await assert.rejects(handle.request("deaf", {}), (err: { code?: string; message: string }) => err.code === "fence" && /timed out/.test(err.message));
    const already = new AbortController();
    already.abort();
    await assert.rejects(handle.request("deaf", {}, undefined, already.signal), (err: { code?: string }) => err.code === "cancelled");
  } finally {
    await handle.close();
  }
});
