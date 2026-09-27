// The seams a package waits and announces through: `ext.awaitReturn`, `ext.turns`, `ext.notice`,
// `ext.developer` and `ext.build`. They are built on the page's store, so the store is driven here the
// way the reconnect loop and the event stream drive it on the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";

const { store } = await import("../assets/lib/store.js");
const { awaitReturn, onTurnsIdle, turnsRunning } = await import("../assets/lib/lifecycle.js");
const { createExt } = await import("../assets/lib/ext.js");

test("awaitReturn waits for the connection to go and come back, and says so on the way", async () => {
  store.set({ connection: "online" });
  const states = [];
  const back = awaitReturn({ timeoutMs: 1000, onState: (s) => states.push(s) });
  store.set({ connection: "reconnecting" });
  store.set({ connection: "online" });
  assert.equal(await back, "back");
  assert.deepEqual(states, ["waiting", "gone", "back"]);
});

test("awaitReturn called while away answers when it is back; one never away times out; since answers at once", async () => {
  store.set({ connection: "reconnecting" });
  const back = awaitReturn({ timeoutMs: 1000 });
  store.set({ connection: "online" });
  assert.equal(await back, "back");
  assert.equal(await awaitReturn({ timeoutMs: 20 }), "timeout", "nothing went away inside the time");
  const before = Date.now() - 1000;
  assert.equal(await awaitReturn({ timeoutMs: 20, since: before }), "back", "it already came back after `since`");
});

test("turns.running follows the running set, and onIdle fires each time it empties", () => {
  store.set({ running: new Set() });
  let idle = 0;
  const stop = onTurnsIdle(() => { idle += 1; });
  store.set({ running: new Set(["s_1"]) });
  assert.equal(turnsRunning(), true);
  store.set({ running: new Set(["s_1", "s_child"]) });
  store.set({ running: new Set(["s_1"]) });
  assert.equal(idle, 0, "still running");
  store.set({ running: new Set() });
  assert.equal(idle, 1);
  assert.equal(turnsRunning(), false);
  stop();
  store.set({ running: new Set(["s_2"]) });
  store.set({ running: new Set() });
  assert.equal(idle, 1, "stopped listening");
});

test("ext.notice is one card per id, replaced in place, the package's own, and dismissed for good", () => {
  const a = createExt({ package: "@review/a" });
  const b = createExt({ package: "@review/b" });
  const cards = () => document.body.querySelectorAll(".notice");
  const card = a.notice("update", { title: "Updates for 3 extensions", tone: "warn", actions: [{ label: "Update all", primary: true, run: () => {} }] });
  b.notice("update", { title: "Something of b's" });
  assert.equal(cards().length, 2, "the same id in two packages is two cards");
  card.update({ progress: { steps: ["Installing", "Applying", "Refreshing"], at: 1 } });
  assert.equal(cards().length, 2, "an update replaces in place");
  const mine = document.body.querySelector('.notice[data-notice="@review/a:update"]');
  assert.equal(mine.querySelector(".notice-title").textContent, "Updates for 3 extensions", "what was not updated stays");
  assert.deepEqual(mine.querySelectorAll(".notice-step").map((n) => n.attrs.class), ["notice-step is-done", "notice-step is-now", "notice-step is-later"]);
  mine.querySelector(".notice-x").click();
  assert.equal(cards().length, 1);
  card.update({ title: "back?" });
  assert.equal(cards().length, 1, "an update to a dismissed card does not bring it back");
  b.notice.close("update");
  assert.equal(cards().length, 0);
});

test("ext.developer and ext.build read the person's switch and the page's build", () => {
  const ext = createExt({ package: "@review/a" });
  const heard = [];
  const stop = ext.onDeveloper((on) => heard.push(on));
  store.set({ developer: true, build: { id: "b1" } });
  assert.equal(ext.developer(), true);
  assert.equal(ext.build.id, "b1");
  store.set({ developer: false });
  stop();
  store.set({ developer: true });
  assert.deepEqual(heard, [true, false]);
  assert.ok(FakeNode);
});
