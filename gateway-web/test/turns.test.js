import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnHub } from "../dist/src/turns.js";

test("a rejected concurrent send leaves the first turn's events and completion single", async () => {
  let watched;
  let sent;
  let finish;
  const kernel = {
    sessions: {
      watch: (fn) => {
        watched = fn;
        return new Promise(() => {});
      },
      send: (_session, _input, fn) => {
        if (sent) return Promise.reject(Object.assign(new Error("session is busy"), { code: "busy" }));
        sent = fn;
        return new Promise((resolve) => {
          finish = resolve;
          queueMicrotask(() => emit({ type: "turn.start", session: "s_1", turn: "t_1" }));
        });
      },
    },
  };
  // The kernel's watch hears an event before the send iterator does.
  const emit = (event) => {
    watched({ session: "s_1", input: "first", event });
    sent(event);
  };
  const ended = [];
  const hub = new TurnHub(kernel, () => {}, (_user, run) => ended.push(run), "alice");
  const messages = [];
  hub.subscribe("alice", (message) => messages.push(message));
  await hub.start("alice", "s_1", "first");
  await assert.rejects(hub.start("alice", "s_1", "second"), { code: "busy" });
  emit({ type: "text", delta: "hello" });
  emit({ type: "message", message: { role: "assistant", content: "hello" }, usage: { cost: 1 } });
  emit({ type: "turn.end", session: "s_1", turn: "t_1" });
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.map((m) => m.event.type), ["turn.start", "text", "message", "turn.end"]);
  assert.deepEqual(messages.map((m) => m.seq), [1, 2, 3, 4]);
  assert.equal(ended.length, 1);
  assert.equal(hub.snapshot("alice").length, 0);
});
