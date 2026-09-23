import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";
import { mountTabs } from "../assets/views/tabs.js";
import { store } from "../assets/lib/store.js";

const id = "s_a";
const oldMessages = [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }];
const record = (turn = null) => ({ id, conversation: oldMessages, children: [], usage: {}, turn });
const event = (seq, type, extra = {}) => ({ session: id, turn: "t_a", seq, event: { type, ...extra }, ...(type === "turn.start" ? { input: "new question" } : {}) });

function fixture(t) {
  document.body.replaceChildren();
  for (const id of ["tabs", "panes", "new-tab"]) {
    const node = new FakeNode("div");
    node.setAttribute("id", id);
    document.body.append(node);
  }
  store.set({ current: null, tabs: [], sessions: [{ id, title: "Test", turns: 1 }], running: new Set(), agents: new Map(), activity: new Map() });
  const pending = [];
  const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => pending.push((body, status = 200) => resolve(new Response(JSON.stringify(body), { status }))));
  const tabs = mountTabs({});
  t.after(() => { for (const open of tabs.list()) tabs.close(open); globalThis.fetch = previous; });
  return {
    tabs, pending,
    text: () => document.getElementById("panes").querySelector(".transcript").textContent,
    turn(message) {
      if (message.event.type === "turn.start") store.mark("running", id, true);
      if (message.event.type === "turn.end") store.mark("running", id, false);
      tabs.applyTurn(message);
    },
  };
}

test("opening a pane retains live events received after its history snapshot", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  f.turn(event(1, "turn.start"));
  f.turn(event(2, "text", { delta: "live answer" }));
  f.pending.shift()(record());
  await opened;
  assert.match(f.text(), /earlier answer/);
  assert.match(f.text(), /new question/);
  assert.match(f.text(), /live answer/);
  assert.equal(store.isRunning(id), true);
});

test("the in-progress snapshot and buffered events draw each chunk once", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  const start = event(1, "turn.start");
  const first = event(2, "text", { delta: "first " });
  f.turn(start);
  f.turn(first);
  f.turn(event(3, "text", { delta: "second" }));
  f.pending.shift()(record({ turn: "t_a", input: "new question", events: [start, first] }));
  await opened;
  assert.equal(f.text().split("new question").length - 1, 1);
  assert.match(f.text(), /first second/);
  assert.equal(f.text().split("first").length - 1, 1);
});

test("a superseded fetch cannot overwrite the newer reload", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  const reloaded = f.tabs.reload();
  f.pending[1]({ ...record(), conversation: [{ role: "assistant", content: "newer history" }] });
  await reloaded;
  f.pending[0](record());
  await opened;
  assert.match(f.text(), /newer history/);
  assert.doesNotMatch(f.text(), /earlier answer/);
});

test("a turn ending during a load is reread without duplicating its saved messages", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  f.turn(event(1, "turn.start"));
  f.turn(event(2, "text", { delta: "finished answer" }));
  f.turn(event(3, "turn.end"));
  f.pending.shift()(record({ turn: "t_a", input: "new question", events: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pending.length, 1, "reread the final saved record after a racing completion");
  f.pending.shift()({ ...record(), conversation: [...oldMessages, { role: "user", content: "new question" }, { role: "assistant", content: "finished answer" }] });
  await opened;
  assert.equal(store.isRunning(id), false);
  assert.equal(f.text().split("new question").length - 1, 1);
  assert.equal(f.text().split("finished answer").length - 1, 1);
});

test("a failed reconnect refresh retains history and continues drawing live events", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  f.pending.shift()(record());
  await opened;
  const reloaded = f.tabs.reload();
  f.turn(event(1, "turn.start"));
  f.turn(event(2, "text", { delta: "live " }));
  f.pending.shift()({ error: "temporarily unavailable" }, 503);
  await reloaded;
  f.turn(event(3, "text", { delta: "continued" }));
  assert.match(f.text(), /earlier answer/);
  assert.match(f.text(), /live continued/);
  assert.equal(store.isRunning(id), true);
});

test("a failed reread after completion replays the entire buffered turn on existing history", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  f.pending.shift()(record());
  await opened;
  const reloaded = f.tabs.reload();
  f.turn(event(1, "turn.start"));
  f.turn(event(2, "text", { delta: "completed while reloading" }));
  f.turn(event(3, "turn.end"));
  f.pending.shift()(record());
  await new Promise((resolve) => setImmediate(resolve));
  f.pending.shift()({ error: "temporarily unavailable" }, 503);
  await reloaded;
  assert.match(f.text(), /earlier answer/);
  assert.match(f.text(), /completed while reloading/);
  assert.equal(store.isRunning(id), false);
});

test("a failed superseding reload retains events buffered by the earlier reload", async (t) => {
  const f = fixture(t);
  const opened = f.tabs.open(id);
  f.pending.shift()(record());
  await opened;
  const firstReload = f.tabs.reload();
  f.turn(event(1, "turn.start"));
  f.turn(event(2, "text", { delta: "first chunk " }));
  const secondReload = f.tabs.reload();
  f.pending[1]({ error: "temporarily unavailable" }, 503);
  await secondReload;
  f.pending[0](record());
  await firstReload;
  f.turn(event(3, "text", { delta: "second chunk" }));
  assert.match(f.text(), /new question/);
  assert.match(f.text(), /first chunk second chunk/);
});
