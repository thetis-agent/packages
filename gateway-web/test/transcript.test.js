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

for (const replay of [false, true]) {
  test(`empty text chunks keep streamed reasoning in one block${replay ? " when replaying a running turn" : ""}`, () => {
    const parent = new FakeNode("section");
    const root = new FakeNode("div");
    parent.append(root);
    const transcript = mountTranscript(root, { session: "s_1" });
    const chunks = Array.from({ length: 12 }, (_, i) => `thought ${i} `);
    const events = chunks.flatMap((delta) => [{ type: "text", delta: "" }, { type: "reasoning", delta }]);
    if (replay) transcript.restore(midTurn(ASKED, ASKED, events.map((event, i) => ({ seq: i + 1, event }))));
    else for (const event of events) transcript.applyEvent(event);

    assert.equal(root.querySelectorAll("details.reasoning").length, 1);
    assert.equal(root.querySelectorAll("details.reasoning[open]").length, 1);
    assert.equal(root.querySelector(".reasoning-text").textContent, chunks.join(""));
    assert.equal(root.querySelectorAll(".msg-text.is-live").length, 0);

    transcript.applyEvent({ type: "text", delta: "The answer" });
    assert.equal(root.querySelectorAll("details.reasoning[open]").length, 0);
    assert.equal(root.querySelector("details.reasoning > summary").textContent, "Thought for a moment");
    assert.equal(root.querySelector(".msg-text.is-live").textContent, "The answer");
  });
}

test("empty reasoning does not create a row, and a later model response gets its own thinking block", () => {
  const root = new FakeNode("div");
  const transcript = mountTranscript(root, { session: "s_1", nested: true });
  transcript.applyEvent({ type: "reasoning", delta: "" });
  assert.equal(root.querySelectorAll("details.reasoning").length, 0);
  transcript.applyEvent({ type: "reasoning", delta: "First response" });
  transcript.applyEvent({ type: "message", message: { role: "assistant", content: [] } });
  transcript.applyEvent({ type: "reasoning", delta: "Next response" });
  assert.equal(root.querySelectorAll("details.reasoning").length, 2);
  assert.equal(root.querySelectorAll("details.reasoning[open]").length, 1);
  transcript.applyEvent({ type: "turn.end" });
  assert.equal(root.querySelectorAll("details.reasoning[open]").length, 0);
});

test("markers are offered at every index on restore, with the record, and only once a renderer is registered", async () => {
  const { addRenderer, hasRenderers } = await import("../assets/lib/registry.js");
  assert.equal(hasRenderers(), false, "nothing registered yet: the restore below offers no marker and pays nothing for it");
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  const record = { id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null, harness: { "@x/compaction": { cut: 1 } } };
  transcript.restore(record);
  assert.deepEqual(root.children.map((n) => n.attrs.class), ["msg is-user", "msg is-assistant"], "the shell's rows and nothing between them");
  const seen = [];
  addRenderer("@test/markers", (event, ctx) => {
    if (event.type !== "marker") return null;
    seen.push({ index: event.index, session: event.session, sameRecord: event.record === record, restored: ctx.restored });
    if (event.index !== event.record.harness["@x/compaction"].cut) return null;
    return Object.assign(new FakeNode("div"), { attrs: { class: "compaction-card" } });
  });
  assert.equal(hasRenderers(), true);
  transcript.restore(record);
  assert.deepEqual(seen, [
    { index: 0, session: "s_1", sameRecord: true, restored: true },
    { index: 1, session: "s_1", sameRecord: true, restored: true },
    { index: 2, session: "s_1", sameRecord: true, restored: true },
  ], "before each message and once after the last");
  assert.deepEqual(root.children.map((n) => n.attrs.class), ["msg is-user", "compaction-card", "msg is-assistant"], "the Node answered at the cut sits between the messages as its own row");
});

test("a live extension event reaches a renderer and its Node is placed; one nobody takes draws nothing", async () => {
  const { addRenderer } = await import("../assets/lib/registry.js");
  const seen = [];
  addRenderer("@test/ext", (event) => {
    if (event.type !== "extension") return null;
    seen.push(event);
    return event.name === "@x/compaction" ? Object.assign(new FakeNode("div"), { attrs: { class: "compaction-card is-busy" } }) : null;
  });
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  transcript.restore({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null });
  transcript.applyEvent({ type: "turn.start" }, "go");
  transcript.applyEvent({ type: "extension", name: "@x/compaction", data: { phase: "planning" } });
  transcript.applyEvent({ type: "extension", name: "@y/other", data: {} });
  transcript.applyEvent({ type: "text", delta: "after" });
  assert.deepEqual(seen.map((e) => e.name), ["@x/compaction", "@y/other"]);
  const classes = root.children.map((n) => n.attrs.class);
  assert.ok(classes.includes("compaction-card is-busy"), `the renderer's row is on the page: ${classes.join(", ")}`);
  assert.equal(classes.filter((c) => c.includes("compaction-card")).length, 1, "and the untaken event drew nothing");
  assert.ok(classes.indexOf("compaction-card is-busy") > classes.indexOf("msg is-user"), "placed after the person's message, before the reply");
});

test("a complete bubble is offered to the renderers as message.rendered, restored and live, and their answer changes nothing", async () => {
  const { addRenderer } = await import("../assets/lib/registry.js");
  const seen = [];
  addRenderer("@test/links", (event, ctx) => {
    if (event.type !== "message.rendered") return null;
    seen.push({ role: event.role, session: event.session, restored: event.restored, text: event.node.textContent, ctxSession: ctx.session });
    event.node.append(Object.assign(new FakeNode("a"), { attrs: { class: "ws-link" } }));
    return event.node; // a Node answer replaces a tool card; here it must not replace the bubble
  });
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  transcript.restore({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null });
  assert.deepEqual(seen, [
    { role: "user", session: "s_1", restored: true, text: "hello", ctxSession: "s_1" },
    { role: "assistant", session: "s_1", restored: true, text: "hi", ctxSession: "s_1" },
  ]);
  assert.equal(root.querySelectorAll(".msg").length, 2, "the rows are the shell's; nothing was added or replaced");
  assert.equal(root.querySelectorAll(".msg > .msg-text > a.ws-link").length, 2, "and the renderer decorated the text in place");
  seen.length = 0;
  transcript.applyEvent({ type: "turn.start" }, "what now?");
  assert.deepEqual(seen, [{ role: "user", session: "s_1", restored: false, text: "what now?", ctxSession: "s_1" }]);
  seen.length = 0;
  transcript.applyEvent({ type: "text", delta: "stream" });
  transcript.applyEvent({ type: "text", delta: "ing" });
  assert.deepEqual(seen, [], "a bubble still growing is not offered");
  transcript.applyEvent({ type: "message", message: { role: "assistant", content: "streaming" } });
  assert.deepEqual(seen, [{ role: "assistant", session: "s_1", restored: false, text: "streaming", ctxSession: "s_1" }], "settled once, when the message lands");
  seen.length = 0;
  transcript.applyEvent({ type: "turn.end" });
  assert.deepEqual(seen, [], "and not again at the turn's end");
});

// ---- a turn that did not finish: the row that stays, the retry row, the resumed divider ----

/** A transcript in a pane, and every request it makes: `{ path, method, body }`. */
function pane(t, { nested = false, session = "s_1", answer = () => ({ status: 202, body: { session } }) } = {}) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path: String(path), method: init.method ?? "GET", body });
    const { status, body: out } = answer(String(path));
    return new Response(JSON.stringify(out), { status });
  };
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session, nested });
  t.after(() => {
    transcript.reset(); // stops a countdown still ticking
    globalThis.fetch = previous;
  });
  return { root, transcript, requests };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ends = (root) => root.querySelectorAll(".msg.is-end");
const buttonsOf = (row) => row.querySelectorAll("button").map((b) => b.textContent);

test("a failed turn leaves one plain sentence, the raw words under Details, and a Retry that resumes", async (t) => {
  const { root, transcript, requests } = pane(t);
  transcript.restore({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null });
  transcript.applyEvent({ type: "turn.start" }, "go on");
  transcript.applyEvent({ type: "error", code: "provider", kind: "connection", retryable: true, message: "provider error: the connection closed before the reply finished" });
  const [row] = ends(root);
  assert.match(row.querySelector(".end-text").textContent, /^The connection to the model kept dropping, so the reply stopped here\. Everything before it is kept\.$/);
  assert.equal(row.querySelector(".end-raw").textContent, "provider error: the connection closed before the reply finished");
  assert.deepEqual(buttonsOf(row), ["Retry"]);
  assert.equal(root.textContent.includes("The turn failed"), false, "the raw red line is gone");
  row.querySelector("button").click();
  await settle();
  assert.deepEqual(requests.map((r) => [r.method, r.path]), [["POST", "api/sessions/s_1/resume"]]);
  // The resumed turn starts: the row goes and the divider says what happened, as a reopened page draws it.
  transcript.applyEvent({ type: "turn.start", resumed: { why: "provider", from: "t_1" } }, "", []);
  assert.equal(ends(root).length, 0);
  assert.equal(root.querySelector(".msg.is-divider").textContent, "Retried");
});

test("a subagent's nested failure row, which has no button, goes too when the subagent is resumed", (t) => {
  const { root, transcript } = pane(t, { nested: true, session: "s_child" });
  transcript.applyEvent({ type: "turn.start" }, "do the child work");
  transcript.applyEvent({ type: "error", code: "provider", kind: "connection", retryable: true, message: "provider error: cut" });
  transcript.applyEvent({ type: "turn.end" });
  assert.equal(ends(root).length, 1);
  assert.deepEqual(buttonsOf(ends(root)[0]), [], "the block's Resume is the button");
  transcript.applyEvent({ type: "turn.start", resumed: { why: "provider", from: "t_1" } }, "", []);
  assert.equal(ends(root).length, 0);
  assert.equal(root.querySelector(".msg.is-divider").textContent, "Retried");
});

test("a turn with input after a failure keeps the row's words and takes its button", (t) => {
  const { root, transcript } = pane(t);
  transcript.applyEvent({ type: "turn.start" }, "go on");
  transcript.applyEvent({ type: "error", code: "provider", kind: "overloaded", retryable: true, message: "provider error: overloaded" });
  transcript.applyEvent({ type: "turn.end" });
  transcript.applyEvent({ type: "turn.start" }, "try something else");
  assert.equal(ends(root).length, 1);
  assert.deepEqual(buttonsOf(ends(root)[0]), []);
});

test("each kind has its own sentence, and a message with no kind is still read", () => {
  return import("../assets/lib/failure.js").then(({ failureSentence, failureShort }) => {
    assert.match(failureSentence({ kind: "credits" }), /out of credits.*Add credits/);
    assert.match(failureSentence({ kind: "output-limit" }), /output limit.*Ask for less/);
    assert.match(failureSentence({ kind: "filter" }), /content filter/);
    assert.match(failureSentence({ kind: "rate-limit" }), /limiting requests/);
    assert.match(failureSentence({ error: { message: "x" }, why: "restart" }), /^Thetis restarted during this reply/);
    assert.match(failureSentence({ error: { message: "x" }, why: "reload" }), /^Your space was updated/);
    assert.match(failureSentence({ error: { message: "x" }, why: "crash" }), /stopped unexpectedly/);
    assert.match(failureSentence({ message: "openrouter 402: insufficient credits" }), /out of credits/, "an old error with no kind");
    assert.match(failureSentence({ message: "something odd" }), /^The reply failed, so it stopped here/);
    assert.match(failureSentence({ kind: "connection" }, { tries: 5 }), /\(5 tries\)/);
    assert.equal(failureShort({ message: "error: provider error: the connection closed part-way" }), "the connection kept dropping");
    assert.equal(failureShort({ message: "error: something specific broke" }), "something specific broke");
  });
});

test("the failure row survives a refresh: it is drawn from the record's interrupted when no turn runs", (t) => {
  const { root, transcript } = pane(t);
  const interrupted = { turn: "t_1", at: "2026-09-27T10:00:00Z", why: "provider", error: { message: "openrouter: overloaded", code: "provider", kind: "overloaded", retryable: true } };
  transcript.restore({ id: "s_1", conversation: [...EARLIER, { role: "user", content: "more" }], usage: {}, children: [], turn: null, interrupted });
  const [row] = ends(root);
  assert.match(row.querySelector(".end-text").textContent, /overloaded/);
  assert.deepEqual(buttonsOf(row), ["Retry"]);
  assert.equal(root.children.at(-1), row, "at the end, where the turn stopped");
  // While a turn runs (the resume itself), there is no row: the turn is what is on screen.
  transcript.restore({ id: "s_1", conversation: EARLIER, usage: {}, children: [], interrupted, turn: { turn: "t_2", input: "", events: [] } });
  assert.equal(ends(root).length, 0);
  // A restart says so in its own words.
  transcript.restore({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null, interrupted: { ...interrupted, why: "restart", error: { message: "turn cancelled", code: "cancelled" } } });
  assert.match(ends(root)[0].querySelector(".end-text").textContent, /^Thetis restarted during this reply/);
});

test("a Stop leaves Stopped with Continue, live and on restore, and a cut reply is dimmed and labelled", (t) => {
  const { root, transcript } = pane(t);
  transcript.applyEvent({ type: "turn.start" }, "write it");
  transcript.applyEvent({ type: "text", delta: "Here is the first half" });
  transcript.applyEvent({ type: "error", code: "cancelled", message: "turn cancelled" });
  const [live] = ends(root);
  assert.equal(live.querySelector(".end-text").textContent, "Stopped.");
  assert.deepEqual(buttonsOf(live), ["Continue"]);
  const cut = { role: "assistant", content: "Here is the first half", extensions: { "@thetis/harness-core": { partial: true } } };
  transcript.restore({ id: "s_1", conversation: [...EARLIER, { role: "user", content: "write it" }, cut], usage: {}, children: [], turn: null });
  const partial = root.querySelector(".msg.is-partial");
  assert.ok(partial, "the cut reply is drawn, marked");
  assert.equal(partial.querySelector(".msg-cut").textContent, "cut off");
  assert.deepEqual(buttonsOf(ends(root)[0]), ["Continue"]);
  // The gateway's own mark says the same when the record carries no cut reply (stopped before any output).
  transcript.restore({ id: "s_1", conversation: [...EARLIER, { role: "user", content: "write it" }], usage: {}, children: [], turn: null, stopped: "2026-09-27T10:00:00Z" });
  assert.deepEqual(buttonsOf(ends(root)[0]), ["Continue"]);
  // A finished conversation has nothing to carry on.
  transcript.restore({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null, stopped: null });
  assert.equal(ends(root).length, 0);
});

test("a turn with no input takes the cut reply off the page, live and when a refresh lands mid-resume", (t) => {
  const { root, transcript } = pane(t);
  const cut = { role: "assistant", content: "half a sentence", extensions: { "@thetis/harness-core": { partial: true } } };
  const conversation = [...EARLIER, { role: "user", content: "go" }, cut];
  transcript.restore({ id: "s_1", conversation, usage: {}, children: [], turn: null });
  assert.equal(root.querySelectorAll(".msg.is-partial").length, 1);
  transcript.applyEvent({ type: "turn.start", resumed: { why: "restart", from: "t_1" } }, "", []);
  assert.equal(root.querySelectorAll(".msg.is-partial").length, 0);
  assert.equal(root.querySelector(".msg.is-divider").textContent, "Resumed after Thetis restarted");
  // The same page refreshed while that turn runs: the record still holds the cut reply, the replay hides it.
  const events = [{ seq: 1, event: { type: "turn.start", turn: "t_2", session: "s_1", resumed: { why: "restart", from: "t_1" } } }];
  transcript.restore({ id: "s_1", conversation, usage: {}, children: [], turn: { turn: "t_2", input: "", events }, resumed: [{ index: 3, why: "restart", at: "x", turn: "t_2" }] });
  assert.equal(root.querySelectorAll(".msg.is-partial").length, 0);
  assert.equal(root.querySelectorAll(".msg.is-divider").length, 1, "the running turn's divider once, from its turn.start");
});

test("resumed dividers are drawn on restore where each resumed turn began", (t) => {
  const { root, transcript } = pane(t);
  const conversation = [...EARLIER, { role: "user", content: "go" }, { role: "assistant", content: "done after the restart" }];
  transcript.restore({ id: "s_1", conversation, usage: {}, children: [], turn: null, resumed: [{ index: 3, why: "reload", at: "x", turn: "t_9" }] });
  const classes = root.children.map((n) => n.attrs.class);
  assert.deepEqual(classes, ["msg is-user", "msg is-assistant", "msg is-user", "msg is-divider", "msg is-assistant"]);
  assert.equal(root.querySelector(".msg.is-divider").textContent, "Resumed after an update");
});

test("a round being retried withdraws what it drew, counts down, and settles into one line", async (t) => {
  const { root, transcript, requests } = pane(t);
  transcript.applyEvent({ type: "turn.start" }, "build it");
  transcript.applyEvent({ type: "reasoning", delta: "planning the file" });
  transcript.applyEvent({ type: "text", delta: "I will write tools.js now." });
  transcript.applyEvent({ type: "extension", name: "tool_call.progress", data: { index: 0, name: "write_path", chars: 31_200 } });
  assert.equal(root.querySelector(".tool.is-writing > .tool-head > .tool-gist").textContent, "writing write_path… 31k chars");
  const until = new Date(Date.now() + 8000).toISOString();
  transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase: "waiting", round: 3, attempt: 1, of: 5, inMs: 8000, until, kind: "connection", reason: "the stream closed part-way", dropped: { text: 26, tools: 31200 } } });
  assert.equal(root.querySelectorAll(".msg-text.is-live").length, 0, "the half round's bubble is gone");
  assert.equal(root.querySelectorAll("details.reasoning").length, 0, "and its thinking");
  assert.equal(root.querySelectorAll(".tool.is-writing").length, 0, "and its half-written tool call");
  assert.equal(root.querySelectorAll(".tool-run").length, 0, "with the run that held only that");
  const [row] = ends(root);
  assert.match(row.querySelector(".end-text").textContent, /^The connection to the model dropped\. Retrying in [78] s \(2 of 6\)\.$/);
  assert.equal(row.querySelector(".end-raw").textContent, "the stream closed part-way");
  assert.deepEqual(buttonsOf(row), ["Retry now", "Stop"]);
  row.querySelectorAll("button")[0].click();
  await settle();
  row.querySelectorAll("button")[1].click();
  await settle();
  assert.deepEqual(requests.map((r) => [r.method, r.path, r.body]), [
    ["POST", "api/ext/@thetis/harness-core/retry-now", { session: "s_1", args: { session: "s_1" } }],
    ["POST", "api/sessions/s_1/cancel", undefined],
  ]);
  // harness-core numbers the retry on every phase: the first retry is attempt 1, and it is the second call.
  transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase: "sending", round: 3, attempt: 1, of: 5, kind: "connection" } });
  assert.match(row.querySelector(".end-text").textContent, /Retrying now \(2 of 6\)…$/);
  transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase: "recovered", round: 3, attempt: 1, of: 5, kind: "connection" } });
  assert.equal(row.querySelector(".end-text").textContent, "Reconnected after 1 retry.");
  assert.deepEqual(buttonsOf(row), []);
  transcript.applyEvent({ type: "text", delta: "Writing it again." });
  transcript.applyEvent({ type: "tool.call", call: { id: "c1", name: "write_path", args: { path: "tools.js" } } });
  assert.equal(root.querySelectorAll("details.tool").length, 1, "the real call's card");
});

test("when the retries run out the retry row becomes the failure row, with the tries counted", (t) => {
  const { root, transcript } = pane(t);
  transcript.applyEvent({ type: "turn.start" }, "go");
  transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase: "waiting", round: 1, attempt: 5, of: 5, inMs: 16000, kind: "connection", reason: "cut" } });
  assert.match(ends(root)[0].querySelector(".end-text").textContent, /\(6 of 6\)\.$/, "the last retry is the sixth call of six, never 6 of 5");
  transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase: "sending", round: 1, attempt: 5, of: 5, kind: "connection", reason: "cut" } });
  transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase: "exhausted", round: 1, attempt: 5, of: 5, kind: "connection", reason: "cut" } });
  transcript.applyEvent({ type: "error", code: "provider", kind: "connection", retryable: true, message: "provider error: cut" });
  transcript.applyEvent({ type: "turn.end" });
  const rows = ends(root);
  assert.equal(rows.length, 1, "one row for one stop");
  assert.match(rows[0].querySelector(".end-text").textContent, /kept dropping \(6 tries\), so the reply stopped here/);
  assert.deepEqual(buttonsOf(rows[0]), ["Retry"]);
});

test("a round that reconnects and drops again, over and over, is one row; the cut reply is marked and a Retry takes both away", (t) => {
  // The shape harness-core emits for a stream that is cut part-way on every attempt: each retry's first
  // text is a "recovered", and then the same round drops again (harness-core's retry.test pins it).
  const { root, transcript } = pane(t);
  transcript.applyEvent({ type: "turn.start" }, "go");
  const retry = (phase, attempt) => transcript.applyEvent({ type: "extension", name: "harness-core.retry", data: { phase, round: 1, attempt, of: 2, inMs: 10, kind: "connection", reason: "cut" } });
  transcript.applyEvent({ type: "text", delta: "Half" });
  for (const attempt of [1, 2]) {
    retry("waiting", attempt);
    retry("sending", attempt);
    retry("recovered", attempt);
    assert.equal(ends(root).length, 1, "one row, whatever the attempt");
    assert.equal(ends(root)[0].querySelector(".end-text").textContent, `Reconnected after ${attempt} ${attempt === 1 ? "retry" : "retries"}.`);
    transcript.applyEvent({ type: "text", delta: "Half again" });
  }
  retry("exhausted", 2);
  transcript.applyEvent({ type: "error", code: "provider", kind: "connection", retryable: true, message: "provider error: cut" });
  transcript.applyEvent({ type: "turn.end" });
  const rows = ends(root);
  assert.equal(rows.length, 1, "the failure row alone");
  assert.match(rows[0].querySelector(".end-text").textContent, /kept dropping \(3 tries\)/);
  const cut = root.querySelector(".msg.is-assistant.is-partial");
  assert.ok(cut, "the reply that was streaming is drawn as the record keeps it: partial");
  assert.equal(cut.querySelector(".msg-cut").textContent, "cut off");
  // Retry: the resume drops the cut reply before asking again, so the page does too, and the row goes.
  transcript.applyEvent({ type: "turn.start", resumed: { why: "provider", from: "t_1" } }, "", []);
  assert.equal(root.querySelectorAll(".msg.is-partial").length, 0);
  assert.equal(ends(root).length, 0);
  assert.equal(root.querySelector(".msg.is-divider").textContent, "Retried");
});

test("a failed subagent's badge says why in a line, offers Resume, and resume_subagent carries on in the same block", async (t) => {
  const { root, transcript, requests } = pane(t);
  const spawn = { id: "call_1", name: "spawn_subagent", args: { task: "slice A", label: "slice-A" } };
  transcript.restore({
    id: "s_1",
    conversation: [
      { role: "user", content: "split it" },
      { role: "assistant", content: "", toolCalls: [spawn] },
      { role: "tool", name: "spawn_subagent", toolCallId: "call_1", content: "[subagent s_c1 slice-A]\nerror: provider error: the connection closed before the reply finished, part-way through it" },
    ],
    usage: {},
    children: [{ id: "s_c1", parent: "s_1", createdAt: "2026-09-27T10:00:00Z", updatedAt: "2026-09-27T10:05:00Z", turns: 1, status: "idle", label: "slice-A", task: "slice A", conversation: [], usage: {}, turn: null, resumed: [], stopped: null }],
    turn: null,
  });
  const block = root.querySelector("details.agent");
  assert.equal(block.querySelector(".agent-state").textContent, "failed");
  assert.equal(block.querySelector(".agent-reason").textContent, "the connection kept dropping");
  const resume = block.querySelector(".agent-resume");
  assert.equal(resume.hidden, false);
  resume.click();
  await settle();
  assert.deepEqual(requests.map((r) => [r.method, r.path]), [["POST", "api/sessions/s_c1/resume"]]);
  // The parent's model resumes it instead: no second block, the same one working again, then done.
  transcript.applyEvent({ type: "turn.start" }, "resume it");
  transcript.applyEvent({ type: "tool.call", call: { id: "call_2", name: "resume_subagent", args: { id: "s_c1" } } });
  assert.equal(root.querySelectorAll("details.agent").length, 1);
  assert.equal(block.querySelector(".agent-state").textContent, "working");
  assert.equal(block.querySelector(".agent-reason").textContent, "");
  transcript.applyEvent({ type: "tool.result", id: "call_2", name: "resume_subagent", result: "[subagent s_c1 slice-A]\nAll of slice A is written." });
  assert.equal(block.querySelector(".agent-state").textContent, "done");
  assert.equal(block.querySelectorAll(":scope > pre.tool-pre").length, 1, "the resume's reply replaced the earlier error quote");
  assert.match(block.querySelector(":scope > pre.tool-pre").textContent, /All of slice A/);
});

test("a clean pause says what it paused for: a restart of Thetis or an update of the space", () => {
  return import("../assets/lib/failure.js").then(({ failureSentence, failureShort }) => {
    assert.match(failureSentence({ why: "yield", for: "restart", error: { message: "the turn stopped at a round boundary for a restart" } }), /^This reply paused for a restart of Thetis\. It continues by itself/);
    assert.match(failureSentence({ why: "yield", for: "reload", error: { message: "x" } }), /^This reply paused for an update of your space/);
    assert.equal(failureShort({ why: "yield", for: "restart", error: { message: "x" } }), "Thetis restarted");
    assert.match(failureSentence({ why: "restart", error: { message: "x" } }), /^Thetis restarted during this reply/);
  });
});

test("a live resume after a paused restart draws the restart divider", (t) => {
  const { root, transcript } = pane(t);
  transcript.restore({ id: "s_1", conversation: [...EARLIER], usage: {}, children: [], turn: null, resumed: [] });
  transcript.applyEvent({ type: "turn.start", turn: "t_5", session: "s_1", resumed: { why: "yield", from: "t_4", for: "restart" } }, "", []);
  assert.equal(root.querySelector(".msg.is-divider").textContent, "Resumed after Thetis restarted");
});

test("a planned pause is a quiet row with Continue, not an error with Retry", (t) => {
  const { root, transcript } = pane(t);
  transcript.restore({ id: "s_1", conversation: [...EARLIER], usage: {}, children: [], turn: null, resumed: [], interrupted: { turn: "t_4", at: "x", why: "yield", for: "restart", clean: true, error: { message: "the turn stopped at a round boundary for a restart", code: "yield" } } });
  const row = root.querySelector(".msg.is-end");
  assert.ok(row.attrs.class.includes("is-quiet"), row.attrs.class);
  assert.match(row.textContent, /paused for a restart of Thetis/);
});
