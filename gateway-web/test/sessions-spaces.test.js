// The sidebar list in spaces: only the current space's rows, a row not known yet left out, a package's
// group folded on its own, the search's second pass under "Other projects", and an empty space's button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";

const kept = new Map();
globalThis.localStorage = {
  getItem: (key) => kept.get(key) ?? null,
  setItem: (key, value) => kept.set(key, String(value)),
  removeItem: (key) => kept.delete(key),
};
document.hidden = true; // no clock ticking in the background of a test

const { mountSessions } = await import("../assets/views/sessions.js");
const { groups, resetSpace, space } = await import("../assets/lib/space.js");
const { createExt } = await import("../assets/lib/ext.js");
const { store } = await import("../assets/lib/store.js");

const now = new Date().toISOString();
const SESSIONS = [
  { id: "s_1", title: "alpha one", preview: "", updatedAt: now, turns: 2 },
  { id: "s_2", title: "Bug 12 · verify", preview: "", updatedAt: now, turns: 1 },
  { id: "s_3", title: "loose", preview: "", updatedAt: now, turns: 1 },
  { id: "s_4", title: "alpha four", preview: "", updatedAt: now, turns: 3 },
  { id: "s_5", title: "alpha unknown", preview: "", updatedAt: now, turns: 1 },
  { id: "s_6", title: "old", preview: "", updatedAt: now, turns: 1, archived: true },
];
const MAP = { s_1: "p_1", s_2: "p_1", s_3: null, s_4: "p_2", s_6: "p_1" };
const NAMES = { p_1: "One", p_2: "Two" };

function fixture() {
  kept.clear();
  resetSpace();
  document.body.replaceChildren();
  for (const [tag, id] of [["nav", "session-list"], ["input", "session-search"], ["button", "new-chat"]]) {
    const node = new FakeNode(tag);
    node.setAttribute("id", id);
    document.body.append(node);
  }
  store.set({ sessions: SESSIONS, current: null, sessionFilter: null, running: new Set(), agents: new Map(), activity: new Map() });
  space.provide({ of: (id) => (id in MAP ? MAP[id] : undefined), name: (id) => (id ? NAMES[id] : "No project") });
  space.enter("p_1");
  const news = [];
  const view = mountSessions({ onOpen() {}, onNew: () => news.push(1), onArchive() {}, onRename() {}, onAgent() {}, onOpenAgent() {} });
  const list = document.getElementById("session-list");
  const search = document.getElementById("session-search");
  const ids = (node) => node.querySelectorAll(".session").map((n) => n.getAttribute("data-session"));
  return {
    view, list, news, ids,
    buckets: () => list.querySelectorAll(":scope > .session-bucket").filter((b) => !b.classList.contains("is-elsewhere")).flatMap(ids),
    find(text) {
      search.value = text;
      search.dispatchEvent({ type: "input" });
    },
  };
}

test("only the current space's rows are listed; a row whose space is not known yet is left out", () => {
  const f = fixture();
  assert.deepEqual(f.buckets(), ["s_1", "s_2"]);
  assert.deepEqual(f.ids(f.list.querySelector(".session-archived")), ["s_6"], "archived, per space");
  space.enter(null);
  assert.deepEqual(f.buckets(), ["s_3"]);
  MAP.s_5 = null;
  space.changed();
  assert.deepEqual(f.buckets(), ["s_3", "s_5"], "known now, and drawn on the provider's word");
  delete MAP.s_5;
});

test("a group a package claims is a folded folder after the buckets, remembered when opened, counting its working rows", () => {
  const f = fixture();
  const flows = createExt({ package: "@t/workflows" });
  const stop = flows.sessions.group("runs", { label: "Workflow runs", test: (s) => s.title.startsWith("Bug ") });
  try {
    assert.deepEqual(f.buckets(), ["s_1"], "the run left the buckets");
    const folder = f.list.querySelector('.session-folder[data-group="@t/workflows#runs"]');
    assert.ok(folder);
    assert.deepEqual(f.ids(folder), ["s_2"]);
    assert.equal(folder.getAttribute("open"), null, "folded by default");
    assert.match(folder.querySelector(":scope > summary").textContent, /^Workflow runs1/);
    const children = f.list.children;
    assert.ok(children.indexOf(folder) < children.indexOf(f.list.querySelector(".session-archived")), "between the buckets and Archived");

    folder.dispatchEvent({ type: "toggle", target: { open: true } });
    assert.equal(kept.get("thetis.sidebar.folder:@t/workflows#runs"), "1");
    f.view.draw();
    assert.equal(f.list.querySelector(".session-folder").getAttribute("open"), "", "comes back open");

    // Set in place and drawn whole: the fake DOM has no childNodes for the one-row swap.
    store.get("activity").set("s_2", { state: "working", step: "Thinking", tool: null, since: Date.now(), steps: 0, agents: 0, cost: 0 });
    f.view.draw();
    assert.equal(f.list.querySelector(".session-folder > summary > .session-group > .session-count.is-working").textContent, "1 working");
    store.get("activity").delete("s_2");
  } finally { stop(); }
  assert.equal(f.list.querySelector(".session-folder"), null, "dropped with its group");
  assert.equal(groups.list().length, 0);
});

test("a search finds this space's rows first, then other projects' under their own heading, each naming its project", () => {
  const f = fixture();
  f.find("alpha");
  assert.deepEqual(f.buckets(), ["s_1"]);
  const other = f.list.querySelector(".session-bucket.is-elsewhere");
  assert.ok(other);
  assert.match(other.querySelector(".session-group").textContent, /^Other projects/);
  assert.deepEqual(f.ids(other), ["s_4"], "a row not known yet is not found either");
  assert.equal(other.querySelector(".session-meta").children[0].textContent, "Two", "the facts start with the project");
  f.find("");
  assert.equal(f.list.querySelector(".session-bucket.is-elsewhere"), null);
});

test("an empty space says so and offers the draft; a package's filter still narrows the list", () => {
  const f = fixture();
  space.enter("p_9");
  assert.equal(f.list.querySelector(".session-empty").textContent, "Nothing here yet.");
  f.list.querySelector(".session-start").click();
  assert.deepEqual(f.news, [1]);
  space.enter("p_1");
  createExt({ package: "@t/other" }).sessions.filter((s) => s.id !== "s_1");
  assert.deepEqual(f.buckets(), ["s_2"]);
  store.set({ sessionFilter: null });
});

test("with no provider every row is in the one space, and a search has no second pass", () => {
  const f = fixture();
  resetSpace();
  f.view.draw();
  assert.deepEqual(f.buckets(), ["s_1", "s_2", "s_3", "s_4", "s_5"]);
  f.find("alpha");
  assert.equal(f.list.querySelector(".session-bucket.is-elsewhere"), null);
  assert.deepEqual(f.buckets(), ["s_1", "s_4", "s_5"]);
});
