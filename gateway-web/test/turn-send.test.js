import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTurn } from "../assets/lib/turn-send.js";
import { store } from "../assets/lib/store.js";

function pendingSend(t) {
  let respond;
  const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
  t.after(() => { globalThis.fetch = previous; store.set({ running: new Set() }); });
  store.set({ running: new Set() });
  return { acknowledge: (status = 202) => respond(new Response("{}", { status })) };
}

test("a late send acknowledgement cannot revive a completed turn", async (t) => {
  const { acknowledge } = pendingSend(t);
  const sent = sendTurn("s_a", "hello");
  store.mark("running", "s_a", true);
  store.mark("running", "s_a", false);
  acknowledge();
  await sent;
  assert.equal(store.isRunning("s_a"), false);
});

test("a reconnect snapshot cannot be overwritten by a late acknowledgement", async (t) => {
  const { acknowledge } = pendingSend(t);
  const sent = sendTurn("s_a", "hello");
  // The entire turn happened while disconnected, so membership never changed locally.
  store.setRunningSnapshot([]);
  acknowledge();
  await sent;
  assert.equal(store.isRunning("s_a"), false);
});

test("an acknowledgement before the stream starts locks the composer", async (t) => {
  const { acknowledge } = pendingSend(t);
  const sent = sendTurn("s_a", "hello");
  store.mark("running", "s_b", true);
  acknowledge();
  await sent;
  assert.equal(store.isRunning("s_a"), true);
});

test("a rejected send leaves another tab's active turn alone", async (t) => {
  const { acknowledge } = pendingSend(t);
  const sent = sendTurn("s_a", "hello");
  store.mark("running", "s_a", true);
  acknowledge(409);
  await assert.rejects(sent, { status: 409 });
  assert.equal(store.isRunning("s_a"), true);
});
