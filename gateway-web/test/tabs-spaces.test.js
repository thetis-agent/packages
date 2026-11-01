// The tab strip in spaces: other spaces' tabs are parked (hidden, never closed, still fed), showing a parked
// pane enters its space, each space comes back to the pane last shown in it, and there is one draft tab,
// replaced in place by the conversation its first send makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";

const kept = new Map();
globalThis.localStorage = {
  getItem: (key) => kept.get(key) ?? null,
  setItem: (key, value) => kept.set(key, String(value)),
  removeItem: (key) => kept.delete(key),
};

const { mountTabs } = await import("../assets/views/tabs.js");
const registry = await import("../assets/lib/registry.js");
const { resetSpace, space } = await import("../assets/lib/space.js");
const { store } = await import("../assets/lib/store.js");

const NAMES = { p_1: "One", p_2: "Two" };

function fixture(t, { provider = true, map = {} } = {}) {
  kept.clear();
  resetSpace();
  document.body.replaceChildren();
  for (const id of ["tabs", "panes", "new-tab"]) {
    const node = new FakeNode("div");
    node.setAttribute("id", id);
    document.body.append(node);
  }
  const ids = ["s_a", "s_b", "s_c", "s_d"];
  store.set({ current: null, activeTab: null, tabs: [], sessions: ids.map((id) => ({ id, title: id, turns: 1 })), running: new Set(), agents: new Map(), activity: new Map() });
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const id = String(url).split("/").pop();
    return new Response(JSON.stringify({ id, conversation: [{ role: "user", content: `asked in ${id}` }], children: [], usage: {}, turn: null }), { status: 200 });
  };
  if (provider) space.provide({ of: (id) => (id in map ? map[id] : undefined), name: (id) => (id ? NAMES[id] : "No project") });
  const tabs = mountTabs({ onExample: () => {} });
  t.after(() => { for (const open of tabs.list()) tabs.close(open); globalThis.fetch = previous; });
  const strip = document.getElementById("tabs");
  return {
    tabs,
    map,
    tab: (id) => strip.querySelector(`.tab[data-session="${id}"]`),
    parked: (id) => strip.querySelector(`.tab[data-session="${id}"]`).getAttribute("hidden") !== null,
    drafts: () => strip.querySelectorAll(".tab.is-draft"),
    strip,
    paneText: (id) => document.getElementById("panes").querySelector(`.pane[data-session="${id}"]`).textContent,
    draftText: () => document.getElementById("panes").querySelector(".pane.is-draft").textContent,
  };
}

test("another space's tabs are parked, not closed, and still drawn into; showing a parked pane enters its space", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1", s_b: null } });
  space.enter("p_1");
  await f.tabs.open("s_a");
  assert.equal(store.get("current"), "s_a");
  await f.tabs.open("s_b");
  assert.equal(space.current, null, "opening a conversation of No project took the page there");
  assert.equal(f.parked("s_a"), true);
  assert.equal(f.parked("s_b"), false);
  assert.deepEqual(f.tabs.list(), ["s_a", "s_b"], "parked is not closed");

  store.mark("running", "s_a", true);
  f.tabs.applyTurn({ session: "s_a", turn: "t_1", seq: 1, event: { type: "turn.start" }, input: "while parked" });
  f.tabs.applyTurn({ session: "s_a", turn: "t_1", seq: 2, event: { type: "text", delta: "still drawn" } });
  assert.match(f.paneText("s_a"), /still drawn/, "a parked pane keeps receiving its events");

  await f.tabs.activate("s_a");
  assert.equal(space.current, "p_1");
  assert.equal(store.get("current"), "s_a");
  assert.equal(f.parked("s_b"), true);
  assert.equal(f.parked("s_a"), false);
});

test("each space comes back to the pane last shown in it; an empty space opens the draft, which names the space", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1", s_b: "p_1", s_c: null } });
  space.enter("p_1");
  await f.tabs.open("s_a");
  await f.tabs.open("s_b");
  await f.tabs.activate("s_a");
  await f.tabs.open("s_c");
  assert.equal(space.current, null);
  space.enter("p_1");
  assert.equal(store.get("current"), "s_a", "the one last shown there, not the last opened");
  space.enter(null);
  assert.equal(store.get("current"), "s_c");

  space.enter("p_2");
  assert.equal(f.drafts().length, 1, "a space with no tab opens the draft");
  assert.equal(store.get("current"), null);
  assert.equal(store.get("activeTab"), null);
  assert.match(f.draftText(), /New conversation/);
  assert.match(f.draftText(), /in Two/);
  for (const id of ["s_a", "s_b", "s_c"]) assert.equal(f.parked(id), true);
  assert.equal(f.drafts()[0].getAttribute("hidden"), null, "the draft is never parked");
});

test("there is one draft: a second + shows it again; the space changing under it keeps it on screen, and No project says so", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1" } });
  space.enter("p_1");
  assert.equal(f.drafts().length, 0, "nothing opened yet: the page is still choosing, so no draft of the shell's own");
  await f.tabs.open("s_a");
  space.enter("p_2");
  assert.equal(f.drafts().length, 1, "entering a space with no tab opened the draft");
  await f.tabs.activate("s_a");
  assert.equal(space.current, "p_1");
  f.tabs.close("draft");
  assert.equal(f.drafts().length, 0);
  assert.equal(store.get("current"), "s_a", "closing a draft that is not shown changes nothing on screen");
  assert.equal(f.tabs.openDraft(), true, "made");
  assert.equal(f.tabs.openDraft(), false, "shown again, not made again");
  assert.equal(f.drafts().length, 1);
  assert.ok(f.drafts()[0].classList.contains("is-active"));
  assert.ok(f.drafts()[0].classList.contains("is-flash"), "the second + flashes it");
  assert.match(f.draftText(), /in One/);

  space.enter(null);
  assert.equal(store.get("current"), null, "the draft stays on screen: it comes along to the new space");
  assert.ok(f.drafts()[0].classList.contains("is-active"));
  assert.match(f.draftText(), /not in a project/);
  assert.equal(f.parked("s_a"), true);

  f.tabs.close("draft");
  assert.equal(f.drafts().length, 0, "closing the draft leaves nothing behind");
});

test("a draft the shell put up for an empty space does not hold the screen on the way back, until the person touches it", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1" } });
  space.enter("p_1");
  await f.tabs.open("s_a");
  space.enter("p_2");
  assert.equal(f.drafts().length, 1, "an empty space opened the draft");
  space.enter("p_1");
  assert.equal(store.get("current"), "s_a", "back in p_1: its conversation, not the draft");
  assert.equal(f.drafts().length, 0, "the untouched draft went");

  space.enter("p_2");
  const composer = new FakeNode("div");
  composer.setAttribute("id", "composer");
  const pill = new FakeNode("button");
  composer.append(pill);
  document.body.append(composer);
  document.dispatchEvent({ type: "pointerdown", target: pill });
  space.enter("p_1");
  assert.equal(store.get("current"), null, "a draft reached into comes along");
  assert.ok(f.drafts()[0].classList.contains("is-active"));
  composer.remove();
});

test("the first send replaces the draft in place: the conversation's tab takes its position", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1" } });
  space.enter("p_1");
  await f.tabs.open("s_a");
  f.tabs.openDraft();
  const at = f.strip.children.indexOf(f.drafts()[0]);
  f.map.s_d = "p_1";
  await f.tabs.open("s_d", { fromDraft: true });
  assert.equal(f.drafts().length, 0);
  assert.equal(f.strip.children.indexOf(f.tab("s_d")), at);
  assert.equal(store.get("current"), "s_d");
  assert.equal(space.current, "p_1");
  assert.deepEqual(f.tabs.list(), ["s_a", "s_d"]);
});

test("a new tab goes before the draft, which stays last; closing the active tab shows a neighbour of this space only", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1", s_b: null, s_c: "p_1" } });
  space.enter("p_1");
  await f.tabs.open("s_a");
  f.tabs.openDraft();
  await f.tabs.open("s_b");
  space.enter("p_1");
  await f.tabs.open("s_c");
  const draftAt = f.strip.children.indexOf(f.drafts()[0]);
  assert.ok(f.strip.children.indexOf(f.tab("s_c")) < draftAt, "the draft stays at the end of the strip");
  f.tabs.close("s_c");
  assert.equal(store.get("current"), "s_a", "the parked s_b between them is skipped");
  assert.equal(space.current, "p_1");
});

test("the provider moving the open conversation takes the space with it; an unknown space keeps the tab where it is", async (t) => {
  const f = fixture(t, { map: {} });
  space.enter("p_1");
  await f.tabs.open("s_a");
  assert.equal(f.parked("s_a"), false, "not known yet: it stays in the space it opened in");
  f.map.s_a = "p_2";
  space.changed();
  assert.equal(space.current, "p_2");
  assert.equal(store.get("current"), "s_a");
  assert.equal(f.parked("s_a"), false);
});

test("a package's tab belongs to the space it was opened for, else the current one; with no provider every tab is in one space", async (t) => {
  const f = fixture(t, { map: { s_a: "p_1" } });
  registry.declare({ package: "@t/canvas", tabs: [{ id: "canvas", label: "Canvas" }] });
  registry.register("tabs", "@t/canvas", "canvas", { open: (root, handle) => { root.textContent = `board ${handle.id}`; } });
  space.enter("p_1");
  await f.tabs.open("s_a");
  await f.tabs.openKind("@t/canvas#canvas", "c1", { id: "c1" }, { space: "p_2" });
  assert.equal(space.current, "p_2", "opening it entered its space");
  assert.deepEqual(store.get("activeTab"), { kind: "canvas", id: "c1" });
  assert.equal(f.parked("s_a"), true);
  await f.tabs.openKind("@t/canvas#canvas", "c2", { id: "c2" });
  assert.equal(f.strip.querySelector('.tab[data-key="canvas:c2"]').getAttribute("hidden"), null, "the current space's");
  await f.tabs.activate("s_a");
  assert.equal(f.strip.querySelector('.tab[data-key="canvas:c2"]').getAttribute("hidden"), "", "parked with p_2");

  const g = fixture(t, { provider: false });
  await g.tabs.open("s_a");
  await g.tabs.openKind("@t/canvas#canvas", "c3", { id: "c3" }, { space: "p_2" });
  assert.equal(space.current, null);
  assert.equal(g.parked("s_a"), false, "no provider: nothing is ever parked");
  g.tabs.openDraft();
  assert.doesNotMatch(g.draftText(), /in a project|in Two/, "no provider: the draft names no space");
  assert.match(g.draftText(), /New conversation/);
});
