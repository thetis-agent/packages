import { test } from "node:test";
import assert from "node:assert/strict";
import type { KernelClient, ToolEnv } from "@thetis/contracts";
import { spawnSubagent } from "../src/index.js";

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
