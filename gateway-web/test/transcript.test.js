// What a transcript draws when it is rebuilt from a session record, under a DOM small enough to fit in
// this file. The case that matters here is a record with a turn still in progress, which is what a page
// gets when it is refreshed mid-turn: the kernel writes the turn's input into the saved conversation the
// moment the turn starts, so the record carries that message twice — once in `conversation` and once as
// `turn.input` — and drawing both put the person's own words on the page twice on every such refresh.
// The elements here are plain objects that remember their tag, attributes and children, with just enough
// selector matching for what the restore path asks for; anything it asks for that is not understood
// throws, so a test that stops exercising the real code says so rather than passing quietly.
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- the smallest DOM the transcript can be drawn into ----

import { FakeNode } from "./dom-fixture.js";

const { mountTranscript } = await import("../assets/views/transcript.js");

// ---- the records ----

const TURN_CONTEXT_LINE = "\n\n[Turn context: Tuesday 2026-09-23 02:14 UTC]";
const ASKED = "what is the plan?";
const EARLIER = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

/** A record as `GET /api/sessions/<id>` answers it while a turn is running. `saved` is the copy in the conversation. */
function midTurn(saved, input = ASKED, events = []) {
  return {
    id: "s_1",
    conversation: [...EARLIER, ...(saved === null ? [] : [{ role: "user", content: saved }])],
    usage: {},
    children: [],
    turn: { session: "s_1", turn: "t_1", input, startedAt: new Date().toISOString(), events },
  };
}

function drawn(record) {
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  transcript.restore(record);
  return root.querySelectorAll(".msg.is-user > .msg-text").map((node) => node.textContent);
}

// ---- what it draws ----

test("a turn in progress does not put the person's message on the page twice", () => {
  assert.deepEqual(drawn(midTurn(ASKED)), ["hello", ASKED]);
});

test("the harness's turn context line on one copy is not a different message", () => {
  // The record is saved as the turn starts, before the step that appends the line runs, so the two copies
  // of the same message can differ by exactly that line. The row drawn never shows it either way.
  assert.deepEqual(drawn(midTurn(ASKED + TURN_CONTEXT_LINE)), ["hello", ASKED]);
  assert.deepEqual(drawn(midTurn(ASKED, ASKED + TURN_CONTEXT_LINE)), ["hello", ASKED]);
});

test("a turn whose input the record does not carry is still drawn", () => {
  // A record whose opening save has not landed, or one written by an older kernel: the input is the only
  // copy there is, so dropping it would lose what the person said.
  assert.deepEqual(drawn(midTurn(null)), ["hello", ASKED]);
  assert.deepEqual(drawn(midTurn("something else")), ["hello", "something else", ASKED]);
});

test("a conversation with no turn in progress draws its saved messages and nothing more", () => {
  assert.deepEqual(drawn({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null }), ["hello"]);
});

test("the turn's events are replayed on top of the restored history", () => {
  const events = [
    { seq: 1, event: { type: "turn.start", turn: "t_1", session: "s_1" } },
    { seq: 2, event: { type: "text", delta: "wor" } },
    { seq: 3, event: { type: "text", delta: "king" } },
  ];
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  transcript.restore(midTurn(ASKED, ASKED, events));
  assert.deepEqual(root.querySelectorAll(".msg.is-user > .msg-text").map((n) => n.textContent), ["hello", ASKED]);
  // `turn.start` carries no input on a replay, so it adds no row of its own; the streamed text does.
  assert.equal(root.querySelectorAll(".msg.is-assistant").at(-1).textContent.includes("working"), true);
});

test("opening a finished descendant fetches and draws the history missing from its parent record", async (t) => {
  const previous = globalThis.fetch;
  let resolveRecord;
  globalThis.fetch = () => new Promise((resolve) => { resolveRecord = resolve; });
  t.after(() => { globalThis.fetch = previous; });
  const root = new FakeNode("div");
  const transcript = mountTranscript(root, { session: "s_child", nested: true });
  transcript.restore({ conversation: [
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "spawn_subagent", args: { task: "research" } }] },
    { role: "tool", name: "spawn_subagent", toolCallId: "call_1", content: "[subagent s_ab research]\nsummary" },
  ], children: [] });
  const child = root.querySelector("details.agent");
  child.open = true;
  child.dispatchEvent(new Event("toggle"));
  assert.equal(typeof resolveRecord, "function");
  resolveRecord(new Response(JSON.stringify({ id: "s_ab", conversation: [{ role: "assistant", content: "full research history" }], children: [], turn: null })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(child.querySelector(".agent-body").textContent, /full research history/);
});

test("structured image and unknown content render live and after restoring the record", () => {
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  const image = { id: "photo", type: "asset", data: { id: "a_123", mediaType: "image/png", name: "photo.png" } };
  const opaque = { id: "mesh", type: "@example/mesh.v1", data: { vertices: [1, 2], extra: null } };
  const content = [{ type: "text", data: { text: "Look at this" } }, image, opaque];
  const conversation = [{ role: "user", content }, { role: "assistant", content: [opaque] }];
  transcript.restore({ id: "s_1", conversation, children: [], usage: {}, turn: null });
  assert.equal(root.querySelectorAll("img.content-media").length, 1);
  assert.equal(root.querySelector("img.content-media").getAttribute("src"), "api/media/a_123");
  assert.equal(root.querySelectorAll("details.content-unknown").length, 2);
  assert.match(root.textContent, /Look at this/);
  transcript.reset();
  transcript.applyEvent({ type: "turn.start" }, "Look at this", [conversation[0]]);
  transcript.applyEvent({ type: "content.start", messageId: "m", part: { ...opaque, data: null } });
  transcript.applyEvent({ type: "content.end", messageId: "m", part: opaque });
  transcript.applyEvent({ type: "message", message: conversation[1] });
  assert.equal(root.querySelectorAll("img.content-media").length, 1);
  assert.equal(root.querySelectorAll("details.content-unknown").length, 2, "the final message replaces the streamed preview");
});

test("two media-only inputs are distinguished by their parts when restoring a running turn", () => {
  const previous = { role: "user", content: [{ type: "asset", data: { id: "a_first", mediaType: "image/png", name: "first.png" } }] };
  const current = { role: "user", content: [{ type: "asset", data: { id: "a_second", mediaType: "image/png", name: "second.png" } }] };
  const record = { id: "s_1", conversation: [previous], children: [], usage: {}, turn: { input: "", messages: [current], events: [] } };
  assert.deepEqual(drawn(record), ["first.png", "second.png"]);
  record.conversation.push(current);
  assert.deepEqual(drawn(record), ["first.png", "second.png"], "a saved input is drawn only once");
});
