// The Forget dialog and its receipt, under the small DOM the other view tests use: what the dialog says
// from a preview, how its button follows the typed title, a block and a running turn, what it posts, and
// the receipt card it leaves instead of an undo toast. Then the two ways in: the sidebar row's menu, where
// Forget is last after a rule in the danger tone, and the chat bar's ⋯ menu beside the archive button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";

const { defaultOptions, forgetState, keptLines, openForget, removedLines, scopeLine } = await import("../assets/views/forget.js");
const { store } = await import("../assets/lib/store.js");

const ALWAYS = ["Copies quoted into other conversations stay.", "The server's audit journal keeps that a conversation existed, never its words.", "Text already sent to the model provider is outside Thetis."];
const preview = (over = {}) => ({
  id: "s_1",
  title: "Trip plans",
  turns: 4,
  subtree: ["s_1", "s_2", "s_3"],
  running: false,
  attachments: 2,
  hooks: [{ package: "@thetis/reflections", items: [{ id: "lessons", label: "2 lessons came from this conversation", optional: true, default: true }, { id: "reflection", label: "its reflection" }] }],
  kept: ALWAYS,
  ...over,
});
const tick = () => new Promise((done) => setTimeout(done, 1));
const text = (node) => node?.textContent ?? "";
const items = (node) => (node?.querySelectorAll("li") ?? []).map(text);

/** Answers the page's fetches from `answer(path, body)`; records each POST. */
function stubFetch(t, answer) {
  const posts = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (init?.method === "POST") posts.push([path, body]);
    const [status, json] = answer(path, body);
    return new Response(JSON.stringify(json), { status });
  };
  t.after(() => { globalThis.fetch = previous; });
  return posts;
}

test("the pieces: defaults per package, the scope sentence, what goes and what stays as the boxes change, and the button", () => {
  const p = preview();
  const options = defaultOptions(p);
  assert.deepEqual(options, { "@thetis/reflections": { lessons: true } });
  assert.equal(scopeLine(p), "This conversation and its 2 subagent conversations, with 2 attachments.");
  assert.equal(scopeLine(preview({ subtree: ["s_1"], attachments: 0 })), "This conversation.");
  assert.equal(scopeLine(preview({ subtree: ["s_1", "s_2"], attachments: 1 })), "This conversation and its 1 subagent conversation, with 1 attachment.");
  assert.deepEqual(removedLines(p, options), ["2 lessons came from this conversation", "its reflection"]);
  assert.deepEqual(keptLines(p, options), ALWAYS);
  options["@thetis/reflections"].lessons = false;
  assert.deepEqual(removedLines(p, options), ["its reflection"]);
  assert.deepEqual(keptLines(p, options), ["2 lessons came from this conversation", ...ALWAYS], "an unticked part is kept, and says so");

  assert.deepEqual(forgetState(p, ""), { blocked: null, needsTitle: true, label: "Forget", enabled: false });
  assert.equal(forgetState(p, "Trip").enabled, false);
  assert.equal(forgetState(p, "  Trip plans ").enabled, true, "trimmed, as the server compares it");
  assert.deepEqual(forgetState(preview({ turns: 2 }), ""), { blocked: null, needsTitle: false, label: "Forget", enabled: true }, "under three turns no title is asked");
  const blocked = preview({ hooks: [{ package: "@thetis/workflows", items: [], block: "a workflow run that uses it is still active" }] });
  assert.deepEqual(forgetState(blocked, "Trip plans"), { blocked: "a workflow run that uses it is still active", needsTitle: true, label: "Forget", enabled: false });
  assert.equal(forgetState(preview({ running: true }), "Trip plans").label, "Stop and forget");
});

test("the dialog: title, cannot be undone, what goes, a box at its default, the Kept list; Forget waits for the title, posts the choices, and leaves a receipt card", async (t) => {
  document.body.replaceChildren();
  const receipt = { id: "s_1", removed: ["the conversation and 2 subagent conversations", "2 attachments", "its reflection"], kept: ["2 lessons stay", ...ALWAYS] };
  const posts = stubFetch(t, (path) => (path.endsWith("/forget/preview") ? [200, preview()] : [200, receipt]));
  const forgotten = [];
  const done = openForget("s_1", { onForgotten: (r) => forgotten.push(r) });
  await tick();
  const dialog = document.body.querySelector("dialog.forget");
  assert.ok(dialog?.open, "a modal dialog");
  assert.equal(text(dialog.querySelector(".forget-title")), "Forget “Trip plans”?");
  assert.equal(text(dialog.querySelector(".forget-warn")), "This cannot be undone.");
  const [removed, kept] = dialog.querySelectorAll(".forget-list");
  assert.deepEqual(items(removed), ["This conversation and its 2 subagent conversations, with 2 attachments.", "2 lessons came from this conversation", "its reflection"]);
  assert.deepEqual(items(kept), ALWAYS);
  const box = dialog.querySelector(".forget-check");
  assert.equal(box.checked, true, "at the package's default");
  const go = dialog.querySelector(".forget-go");
  assert.equal(text(go), "Forget");
  assert.equal(go.disabled, true, "not before the title is typed");

  box.checked = false;
  box.dispatchEvent({ type: "change" });
  assert.deepEqual(items(kept), ["2 lessons came from this conversation", ...ALWAYS], "unticked: it moves to Kept");
  const input = dialog.querySelector(".forget-confirm");
  input.value = "Trip plan";
  input.dispatchEvent({ type: "input" });
  assert.equal(go.disabled, true);
  input.value = "Trip plans";
  input.dispatchEvent({ type: "input" });
  assert.equal(go.disabled, false);
  go.dispatchEvent({ type: "click" });
  assert.deepEqual(await done, receipt);
  assert.deepEqual(posts.at(-1), ["api/sessions/s_1/forget", { confirm: "Trip plans", stop: false, options: { "@thetis/reflections": { lessons: false } } }]);
  assert.equal(dialog.open, false);
  assert.equal(document.body.querySelector("dialog.forget"), null, "the dialog is gone");
  assert.deepEqual(forgotten, [receipt], "the page heard of it, to close the tab");
  const card = document.body.querySelector('[data-notice="forget-s_1"]');
  assert.ok(card, "a notice card, not a toast with Undo");
  assert.equal(text(card.querySelector(".notice-title")), "Forgotten: Trip plans");
  const [went, stayed] = card.querySelectorAll(".forget-list");
  assert.deepEqual(items(went), receipt.removed);
  assert.deepEqual(items(stayed), receipt.kept);
  assert.equal(document.body.querySelector(".toast"), null);
});

test("a block disables the button and says why; a running turn makes it Stop and forget, which posts stop; a refusal stays in the dialog", async (t) => {
  document.body.replaceChildren();
  stubFetch(t, () => [200, preview({ hooks: [{ package: "@thetis/workflows", items: [], block: "a workflow run that uses it is still active" }] })]);
  const blocked = openForget("s_1");
  await tick();
  let dialog = document.body.querySelector("dialog.forget");
  assert.equal(text(dialog.querySelector(".forget-block")), "a workflow run that uses it is still active");
  const input = dialog.querySelector(".forget-confirm");
  input.value = "Trip plans";
  input.dispatchEvent({ type: "input" });
  assert.equal(dialog.querySelector(".forget-go").disabled, true, "typing the title does not get past a block");
  dialog.querySelector(".forget-cancel").dispatchEvent({ type: "click" });
  assert.equal(await blocked, null, "cancelled: nothing forgotten");

  document.body.replaceChildren();
  let refuse = true;
  const posts = stubFetch(t, (path) => (path.endsWith("/preview") ? [200, preview({ turns: 1, running: true })] : refuse ? [409, { error: "a turn in this conversation did not stop in time; try again" }] : [200, { id: "s_1", removed: [], kept: [] }]));
  const running = openForget("s_1");
  await tick();
  dialog = document.body.querySelector("dialog.forget");
  assert.equal(dialog.querySelector(".forget-confirm"), null, "one turn: no title to type");
  assert.match(text(dialog.querySelector(".forget-running")), /will be stopped first/);
  const go = dialog.querySelector(".forget-go");
  assert.equal(text(go), "Stop and forget");
  go.dispatchEvent({ type: "click" });
  await tick();
  await tick();
  assert.equal(dialog.open, true, "a refusal leaves the dialog up");
  const error = dialog.querySelector(".forget-error");
  assert.equal(text(error), "a turn in this conversation did not stop in time; try again");
  assert.equal(error.getAttribute("hidden"), null);
  refuse = false;
  go.dispatchEvent({ type: "click" });
  await running;
  assert.deepEqual(posts.at(-1)[1], { confirm: "", stop: true, options: { "@thetis/reflections": { lessons: true } } });
});

test("the chat bar's ⋯ menu: Archive (or Restore), a rule, then Forget… in the danger tone", async (t) => {
  document.body.replaceChildren();
  for (const id of ["tabs", "panes", "new-tab"]) {
    const node = new FakeNode("div");
    node.setAttribute("id", id);
    document.body.append(node);
  }
  store.set({ current: null, activeTab: null, tabs: [], sessions: [{ id: "s_1", title: "Trip plans", turns: 4, archived: false }], running: new Set(), agents: new Map(), activity: new Map() });
  const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const { mountTabs } = await import("../assets/views/tabs.js");
  const asked = [];
  const tabs = mountTabs({ onArchive: (id) => asked.push(["archive", id]), onForget: (id) => asked.push(["forget", id]) });
  t.after(() => { for (const open of tabs.list()) tabs.close(open); globalThis.fetch = previous; });
  void tabs.open("s_1");
  const more = document.getElementById("panes").querySelector(".chat-more");
  assert.ok(more, "beside the archive button");
  more.click();
  const menu = document.body.querySelector(".menu");
  const rows = menu.querySelectorAll(".menu-item");
  assert.deepEqual(rows.map((r) => text(r.querySelector(".menu-label"))), ["Archive", "Forget…"]);
  assert.equal(menu.querySelectorAll(".menu-sep").length, 1);
  assert.ok(rows[1].classList.contains("is-danger"));
  rows[1].click();
  assert.deepEqual(asked, [["forget", "s_1"]]);
  store.set({ sessions: [{ id: "s_1", title: "Trip plans", turns: 4, archived: true }] });
  more.click();
  const again = document.body.querySelector(".menu").querySelectorAll(".menu-item");
  assert.equal(text(again[0].querySelector(".menu-label")), "Restore");
  again[0].click();
  assert.deepEqual(asked.at(-1), ["archive", "s_1"]);
});

test("the sidebar row menu: Forget… is the last item, after a rule, in the danger tone", async (t) => {
  // The sidebar's clocks tick on an interval; a hidden page stops them, so the test process can end.
  t.after(() => {
    document.hidden = true;
    document.dispatchEvent({ type: "visibilitychange" });
    delete document.hidden;
  });
  document.body.replaceChildren();
  for (const [tag, id] of [["div", "session-list"], ["input", "session-search"], ["button", "new-chat"]]) {
    const node = new FakeNode(tag);
    node.setAttribute("id", id);
    document.body.append(node);
  }
  store.set({ current: null, activeTab: null, tabs: [], sessions: [{ id: "s_1", title: "Trip plans", turns: 4, named: true, archived: false, updatedAt: new Date().toISOString() }], running: new Set(), agents: new Map(), activity: new Map() });
  const { mountSessions } = await import("../assets/views/sessions.js");
  const asked = [];
  mountSessions({ onOpen() {}, onNew() {}, onArchive() {}, onRename() {}, onAgent() {}, onOpenAgent() {}, onForget: (id) => asked.push(id) });
  const row = document.getElementById("session-list").querySelector('[data-session="s_1"]');
  row.querySelector(".session-more").click();
  const menu = row.querySelector(".session-menu");
  const children = menu.children;
  assert.deepEqual(children.map(text), ["Rename", "Archive", "Use the first message as the name", "", "Forget…"]);
  assert.ok(children.at(-2).classList.contains("session-menu-sep"), "a rule before it");
  assert.ok(children.at(-1).classList.contains("is-danger"));
  children.at(-1).click();
  assert.deepEqual(asked, ["s_1"]);
  assert.equal(row.querySelector(".session-menu"), null, "the menu closes first");
});
