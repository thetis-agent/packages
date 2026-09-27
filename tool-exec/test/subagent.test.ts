import { test } from "node:test";
import assert from "node:assert/strict";
import type { KernelClient, ToolEnv } from "@thetis/runtime/contracts";
import { resumeSubagent, spawnSubagent } from "../src/index.js";

test("stopping while a child is being created does not start its turn", async () => {
  const control = new AbortController();
  let created!: () => void;
  const waiting = new Promise<void>((resolve) => { created = resolve; });
  let sent = false;
  const sessions = {
    create: async () => { await waiting; return { id: "s_1234" }; },
    send: async () => { sent = true; },
    cancel: async () => false,
  };
  const env = { session: { id: "s_parent" }, signal: control.signal, kernel: { sessions } } as unknown as ToolEnv;
  const work = spawnSubagent({ task: "work" }, env);
  control.abort();
  created();
  const result = String(await work);
  assert.equal(sent, false, "a stopped parent must never start the newly created child");
  assert.match(result, /\[subagent s_1234\]\nstopped:/);
});

test("a child send carries the parent's signal and reports cancellation without throwing", async () => {
  const control = new AbortController();
  const sessions: Partial<KernelClient["sessions"]> = {
    create: async () => ({ id: "s_1234", user: "alice", turns: 0, running: false, createdAt: "", updatedAt: "", first: "", last: "" }),
    send: async (_session, _input, onEvent, _opts, signal) => {
      assert.equal(signal, control.signal);
      onEvent({ type: "text", delta: "partial work" });
      control.abort();
      throw Object.assign(new Error("sessions.send cancelled"), { code: "cancelled" });
    },
    cancel: async () => true,
  };
  const env = { session: { id: "s_parent" }, signal: control.signal, kernel: { sessions } } as unknown as ToolEnv;
  const result = String(await spawnSubagent({ task: "work" }, env));
  assert.match(result, /stopped:/);
  assert.match(result, /partial work/);
});

// ---- retries, failures that can be continued, and resume_subagent ----

const text = (t: string) => [{ type: "text", data: { text: t } }];

/** A kernel whose one child answers `events` for every send, and whose record says what `record` holds. */
function kernelWith(events: (input: unknown) => unknown[], record: Record<string, unknown> = {}) {
  const sends: { session: string; input: unknown }[] = [];
  const sessions = {
    create: async () => ({ id: "s_c0ffee" }),
    send: async (session: string, input: unknown, onEvent: (e: unknown) => void) => {
      sends.push({ session, input });
      for (const e of events(input)) onEvent(e);
    },
    inspect: async (session: string) => ({ id: session, parent: "s_parent", status: "idle", conversation: [], ...record }),
    cancel: async () => false,
  };
  const env = { session: { id: "s_parent" }, kernel: { sessions } } as unknown as ToolEnv;
  return { env, sends };
}

test("a retry that drops the half-finished round drops its text from what the child had said", async () => {
  const { env } = kernelWith(() => [
    { type: "text", delta: "half a sentence that" },
    { type: "extension", name: "harness-core.retry", data: { phase: "waiting", round: 1, attempt: 1, of: 5, kind: "connection", reason: "cut" } },
    { type: "text", delta: "the whole answer" },
    { type: "extension", name: "harness-core.retry", data: { phase: "exhausted", round: 1, attempt: 5, of: 5, kind: "connection", reason: "cut" } },
    { type: "error", message: "the connection kept dropping", code: "provider", retryable: true, kind: "connection" },
  ]);
  const result = String(await spawnSubagent({ task: "work", label: "survey" }, env));
  assert.match(result, /^\[subagent s_c0ffee survey\]\nerror: the connection kept dropping/);
  assert.match(result, /What it had said so far:\nthe whole answer/);
  assert.doesNotMatch(result, /half a sentence/);
  assert.match(result, /call resume_subagent with id s_c0ffee\.$/);
});

test("a failure whose record is interrupted says it can be continued; one that is neither says to look at its files", async () => {
  const failed = () => [{ type: "error", message: "userspace agent exited", code: "fence" }];
  const interrupted = kernelWith(failed, { interrupted: { turn: "t_1", at: "", error: { message: "x" }, why: "failed" } });
  assert.match(String(await spawnSubagent({ task: "work" }, interrupted.env)), /resume_subagent with id s_c0ffee/);
  const plain = kernelWith(() => [{ type: "error", message: "the model refused: context too long", code: "provider" }]);
  const result = String(await spawnSubagent({ task: "work" }, plain.env));
  assert.doesNotMatch(result, /resume_subagent/);
  assert.match(result, /Files it wrote before failing are still there/);
});

test("resume_subagent sends a turn with no input to the child and answers like spawn_subagent", async () => {
  const { env, sends } = kernelWith(
    () => [{ type: "message", message: { role: "assistant", content: text("Picked up where it stopped.") } }],
    { interrupted: { turn: "t_1", at: "", error: { message: "cut" }, why: "provider" }, conversation: [{ role: "user", content: text("task") }, { role: "assistant", content: text("half"), extensions: { "@thetis/harness-core": { partial: true } } }] },
  );
  const result = String(await resumeSubagent({ id: "s_c0ffee", label: "survey" }, env));
  assert.deepEqual(sends, [{ session: "s_c0ffee", input: [] }]);
  assert.equal(result, "[subagent s_c0ffee survey]\nPicked up where it stopped.");
});

test("resume_subagent takes the id out of a pasted result line", async () => {
  const { env, sends } = kernelWith(() => [], { conversation: [{ role: "user", content: text("task") }] });
  await resumeSubagent({ id: "[subagent s_c0ffee survey]" }, env);
  assert.equal(sends[0]?.session, "s_c0ffee");
});

test("resume_subagent does not run a child that had finished, nor one that is running, nor one of another conversation", async () => {
  const done = kernelWith(() => [], { conversation: [{ role: "user", content: text("task") }, { role: "assistant", content: text("The answer.") }] });
  assert.equal(String(await resumeSubagent({ id: "s_c0ffee" }, done.env)), "[subagent s_c0ffee]\nThe answer.");
  assert.equal(done.sends.length, 0);

  const running = kernelWith(() => [], { status: "running" });
  assert.match(String(await resumeSubagent({ id: "s_c0ffee" }, running.env)), /\nbusy: the subagent is running a turn already/);
  assert.equal(running.sends.length, 0);

  const other = kernelWith(() => [], { parent: "s_someone" });
  await assert.rejects(Promise.resolve(resumeSubagent({ id: "s_c0ffee" }, other.env)), /not a subagent of this conversation/);
  await assert.rejects(Promise.resolve(resumeSubagent({ id: "nope" }, other.env)), /id must be a subagent session id/);
});

test("a child that another caller started meanwhile answers busy instead of throwing", async () => {
  const { env } = kernelWith(() => { throw Object.assign(new Error("session s_c0ffee already has a turn in progress"), { code: "busy" }); }, { conversation: [{ role: "user", content: text("task") }] });
  assert.match(String(await resumeSubagent({ id: "s_c0ffee" }, env)), /\nbusy:/);
});
