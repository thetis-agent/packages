// The agent as a process, with this test as its kernel: a step that emits, calls the kernel with the turn's
// signal, runs a tool through `env.invokeTool`, and is cancelled mid-call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/agent.js");

const PROBE = `
export async function probe(ctx) {
  const events = [];
  const tool = await ctx.env.invokeTool({ package: "@t/p", export: "greet", name: "greet" }, { who: "bob" }, { session: ctx.session, config: { k: 1 }, signal: ctx.signal });
  ctx.emit({ type: "text", delta: "hi" });
  let cancelled;
  try {
    await ctx.env.kernel.providers.call({ model: "m", messages: [], tools: [], params: {} }, (e) => events.push(e), ctx.signal);
  } catch (err) {
    cancelled = err.code;
  }
  return { harness: { tool, events, cancelled, aborted: ctx.signal.aborted } };
}
export async function greet(args, env) {
  return "hello " + args.who + " config=" + JSON.stringify(env.config) + " session=" + env.session.id + " storage=" + typeof env.storage + " signal=" + (env.signal instanceof AbortSignal);
}
`;

test("a step emits, runs a tool under its package's env, and a cancel aborts its signal and the kernel call it made", async () => {
  const root = mkdtempSync(join(tmpdir(), "thetis-agent-"));
  const pkg = join(root, "store", "node_modules", "@t", "p");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@t/p", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), PROBE);
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, THETIS_USERSPACE: root }, stdio: ["pipe", "pipe", "pipe"] });
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    frames.push(JSON.parse(line));
    waiters.splice(0).forEach((w) => w());
  });
  const stderr: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const next = async <T extends Record<string, unknown>>(pick: (f: Record<string, unknown>) => boolean): Promise<T> => {
    for (;;) {
      const hit = frames.find(pick);
      if (hit) return hit as T;
      await new Promise<void>((w) => waiters.push(w));
    }
  };
  try {
    const ctx = { session: { id: "s1", user: "alice" }, turn: { id: "t1", input: [] }, conversation: [], call: { model: "m", messages: [], tools: [], params: {} }, harness: {}, packages: [], config: {} };
    send({ id: "r1", op: "step", payload: { package: "@t/p", export: "probe", ctx } });
    const text = await next((f) => f.id === "r1" && "event" in f);
    assert.deepEqual(text.event, { type: "text", delta: "hi" }, "the step's emit reaches the kernel as an event frame of the step request");
    const rpc = await next<{ rpc: string; method: string; args: unknown }>((f) => typeof f.rpc === "string");
    assert.equal(rpc.method, "providers.call");
    assert.deepEqual(rpc.args, { call: { model: "m", messages: [], tools: [], params: {} } });
    send({ rpcEvent: rpc.rpc, event: { type: "text", delta: "one" } });
    send({ rpcEvent: rpc.rpc, event: { type: "text", delta: "two" } });
    // The kernel stops the turn: the step's signal aborts, and the call it was waiting on is cancelled on both sides.
    send({ cancel: "r1" });
    const cancel = await next((f) => typeof f.rpcCancel === "string");
    assert.equal(cancel.rpcCancel, rpc.rpc, "the agent tells the kernel which call to stop serving");
    const done = await next<{ result: { harness: Record<string, unknown> } }>((f) => f.id === "r1" && ("result" in f || "error" in f));
    assert.deepEqual(done.result.harness, {
      tool: "hello bob config={\"k\":1} session=s1 storage=function signal=true",
      events: [{ type: "text", delta: "one" }, { type: "text", delta: "two" }],
      cancelled: "cancelled",
      aborted: true,
    });
    // A late reply to the cancelled call is dropped, not delivered anywhere.
    send({ rpcResult: rpc.rpc, result: "late" });
    send({ id: "r2", op: "ping", payload: {} });
    assert.equal((await next((f) => f.id === "r2")).result, "pong", "the agent is still serving after the cancel");
    assert.ok(!frames.some((f) => f.id === "r1" && (f as { result?: unknown }).result === "late"));
  } finally {
    child.stdin.end();
    await new Promise<void>((done) => child.once("exit", () => done()));
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(stderr, [], "the agent logged nothing");
});
