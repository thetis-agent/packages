import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";
import { mountTabs } from "../assets/views/tabs.js";
import * as registry from "../assets/lib/registry.js";
import { store } from "../assets/lib/store.js";

const id = "s_a";
const oldMessages = [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }];
const record = (turn = null) => ({ id, conversation: oldMessages, children: [], usage: {}, turn });
const event = (seq, type, extra = {}) => ({ session: id, turn: "t_a", seq, event: { type, ...extra }, ...(type === "turn.start" ? { input: "new question" } : {}) });

function fixture(t, hooks = {}) {
  document.body.replaceChildren();
  for (const id of ["tabs", "panes", "new-tab"]) {
    const node = new FakeNode("div");
    node.setAttribute("id", id);
    document.body.append(node);
  }
  store.set({ current: null, activeTab: null, tabs: [], sessions: [{ id, title: "Test", turns: 1 }], running: new Set(), agents: new Map(), activity: new Map() });
  const pending = [];
  const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => pending.push((body, status = 200) => resolve(new Response(JSON.stringify(body), { status }))));
  const tabs = mountTabs(hooks);
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

test("a package's tab: its pane is the package's, no conversation is on screen, its hooks fire, and closing it never discards anything", async (t) => {
  const closed = [];
  const f = fixture(t, { onClosed: (id) => closed.push(id) });
  registry.declare({ package: "@t/canvas", tabs: [{ id: "canvas", label: "Canvas" }] });
  const calls = [];
  registry.register("tabs", "@t/canvas", "canvas", {
    open: (root, handle) => {
      calls.push(["open", handle.id, handle.params]);
      root.textContent = `board ${handle.id}`;
      handle.setTitle(`Canvas ${handle.id}`);
      return { unmount: () => calls.push(["unmount", handle.id]), activate: () => calls.push(["activate", handle.id]), deactivate: () => calls.push(["deactivate", handle.id]) };
    },
  });
  assert.equal(await f.tabs.openKind("@t/canvas#canvas", "c1", { id: "c1" }), true);
  assert.equal(f.pending.length, 0, "nothing was fetched: a package's pane has no record");
  assert.equal(store.get("current"), null, "no conversation is on screen");
  assert.deepEqual(store.get("activeTab"), { kind: "canvas", id: "c1" });
  assert.deepEqual(store.get("tabs"), ["canvas:c1"]);
  assert.deepEqual(calls, [["open", "c1", { id: "c1" }], ["activate", "c1"]]);
  const pane = document.getElementById("panes").querySelector(".pane.is-kind");
  assert.equal(pane.querySelector(".kind-body").textContent, "board c1");
  assert.ok(pane.classList.contains("is-active"));
  const tab = document.getElementById("tabs").querySelector(".tab.is-kind");
  assert.equal(tab.querySelector(".tab-title").textContent, "Canvas c1", "the package named its tab");
  assert.equal(tab.title, "Canvas c1");

  // A conversation beside it: the canvas is told it went out of view, and the conversation is `current`.
  const opened = f.tabs.open(id);
  f.pending.shift()(record());
  await opened;
  assert.equal(store.get("current"), id);
  assert.deepEqual(store.get("activeTab"), { kind: "session", id });
  assert.deepEqual(calls.at(-1), ["deactivate", "c1"]);
  assert.deepEqual(store.get("tabs"), ["canvas:c1", id]);
  assert.ok(!pane.classList.contains("is-active"));

  // Back to the canvas: shown again, not made again; the conversation's events still reach its pane meanwhile.
  await f.tabs.openKind("@t/canvas#canvas", "c1");
  assert.deepEqual(calls.at(-1), ["activate", "c1"]);
  assert.equal(calls.filter((c) => c[0] === "open").length, 1);
  assert.equal(store.get("current"), null);
  f.turn(event(1, "turn.start"));
  f.turn(event(2, "text", { delta: "live answer" }));
  assert.match(f.text(), /live answer/);

  // `+` takes the canvas off screen too.
  f.tabs.showNew();
  assert.equal(store.get("activeTab"), null);
  assert.deepEqual(calls.at(-1), ["deactivate", "c1"]);

  // Closing: unmounted, the neighbour takes over, and `onClosed` — which discards empty conversations — is not told.
  await f.tabs.openKind("@t/canvas#canvas", "c1");
  f.tabs.close("canvas:c1");
  assert.deepEqual(calls.at(-1), ["unmount", "c1"]);
  assert.equal(store.get("current"), id, "the neighbour takes over");
  assert.deepEqual(store.get("tabs"), [id]);
  assert.deepEqual(closed, []);
  assert.equal(document.getElementById("panes").querySelector(".pane.is-kind"), null);
});

test("a kind declared but not yet registered shows Loading… and is drawn when its module lands; an unknown kind opens nothing", async (t) => {
  const f = fixture(t);
  registry.declare({ package: "@t/late", tabs: [{ id: "late", label: "Late" }] });
  assert.equal(await f.tabs.openKind("@t/late#late", "x"), true);
  const body = document.getElementById("panes").querySelector(".pane.is-kind > .kind-body");
  assert.equal(body.textContent, "Loading…");
  registry.register("tabs", "@t/late", "late", { open: (root) => { root.textContent = "drawn"; } });
  assert.equal(body.textContent, "drawn");
  assert.equal(await f.tabs.openKind("@t/none#none", "x"), false);
  assert.deepEqual(store.get("tabs"), ["late:x"]);
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
