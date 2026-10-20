// The exporter: the trajectory grammar and its numbering, every cut with its marker, subagents numbered
// on from the conversation, the compaction summary, and a partial export over the budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_CHARS, clip, descendantsOf, eventsOf, exportConversation, marker } from "../lib/export.js";
import { assistant, call, record, result, sampleSession, text, user } from "./helpers.js";

const opts = { observationChars: 10000, inputChars: 600000 };

test("events are numbered once, in order, with the grammar's kinds", () => {
  const { record: rec } = sampleSession();
  const out = exportConversation(rec, [], { ...opts, title: "Header" });
  const t = out.files["trajectory.md"];
  assert.equal(out.events, 10);
  assert.match(t, /^# Conversation s_aaaa1111 "Header"/);
  assert.match(t, /\[1\] \[USER\] Fix the header colour\n/);
  assert.match(t, /\[2\] \[ASSISTANT\] I will edit it\./);
  assert.match(t, /\[3\] \[ACTION\] edit_path\(\{"path":"dist\/app\.js"\}\)/);
  assert.match(t, /\[4\] \[OBSERVATION\] ok/);
  assert.match(t, /\[10\] \[ASSISTANT\] Done\./);
  assert.doesNotMatch(t, /Turn context/, "the turn-context line is cut from the person's messages");
  assert.equal(out.partial, null);
  assert.deepEqual([...out.visible].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(out.files["task.md"], /\(\[1\] in the trajectory\):\n\nFix the header colour\n/);
  assert.equal(out.files["compaction.md"], undefined);
});

test("a long observation keeps its head and tail, with the exporter's marker between", () => {
  const long = `${"a".repeat(15000)}ERROR AT THE END`;
  const rec = record("s_b", [user("go"), assistant("", [call("c", "exec", {})]), result("c", "exec", long)]);
  const t = exportConversation(rec, [], opts).files["trajectory.md"];
  const cut = long.length - 10000;
  assert.ok(t.includes(marker(cut)), "the marker names how much was cut");
  assert.ok(t.includes("ERROR AT THE END"), "the tail survives");
  assert.equal(marker(1234), "[cut by the exporter: 1,234 chars]");
  assert.equal(clip("short", 10), "short");
});

test("a tool call's arguments are cut at 2,000 characters", () => {
  const rec = record("s_b", [user("go"), assistant("", [call("c", "write_path", { content: "x".repeat(5000) })]), result("c", "write_path", "ok")]);
  const ev = eventsOf(rec, opts).find((e) => e.kind === "ACTION");
  assert.ok(ev.text.includes("[cut by the exporter:"));
  assert.ok(ev.text.length < ACTION_CHARS + 200);
});

test("an `error:` tool result and an interrupted reply are ERROR events", () => {
  const rec = record("s_b", [user("go"), assistant("", [call("c", "exec", {})]), result("c", "exec", "error: permission denied")], {
    interrupted: { turn: "t", at: "x", why: "failed", error: { message: "provider error: overloaded" } },
  });
  const ev = eventsOf(rec, opts);
  assert.deepEqual(ev.map((e) => e.kind), ["USER", "ACTION", "ERROR", "ERROR"]);
  assert.match(ev.at(-1).text, /stopped before it finished \(failed\): provider error: overloaded/);
});

test("attachments are counted, not dropped", () => {
  const rec = record("s_b", [{ role: "user", content: [...text("look"), { type: "asset", data: { id: "a1", mediaType: "image/png" } }] }]);
  assert.equal(eventsOf(rec, opts)[0].text, "look [1 attachment]");
});

test("subagents are numbered on from the conversation, and the spawn result says where", () => {
  const parent = record("s_p", [user("go"), assistant("", [call("c", "spawn_subagent", { task: "dig" })]), result("c", "spawn_subagent", "[subagent s_c digger]\nfound it")]);
  const child = record("s_c", [user("dig"), assistant("found it")], { parent: "s_p" });
  const list = [{ id: "s_p" }, { id: "s_c", parent: "s_p", createdAt: "1" }, { id: "s_g", parent: "s_c", createdAt: "2" }];
  assert.deepEqual(descendantsOf(list, "s_p").map((s) => s.id), ["s_c", "s_g"]);
  const out = exportConversation(parent, [{ id: "s_c", parent: "s_p", label: "digger", record: child }], opts);
  assert.equal(out.events, 5);
  assert.match(out.files["trajectory.md"], /\(Its own trajectory: context\/subagents\/s_c\.md, events \[4\]–\[5\]\.\)/);
  const sub = out.files["subagents/s_c.md"];
  assert.match(sub, /^# Subagent s_c \(digger\)/);
  assert.match(sub, /\[4\] \[USER\] dig/);
  assert.match(sub, /\[5\] \[ASSISTANT\] found it/);
});

test("a compaction summary is exported with the events it stood for", () => {
  const { record: rec } = sampleSession();
  rec.harness["@thetis/compaction"] = { cut: 4, summary: "The person asked for a colour fix." };
  const out = exportConversation(rec, [], opts);
  assert.match(out.files["compaction.md"], /in place of events \[1\]–\[5\]/);
  assert.match(out.files["compaction.md"], /The person asked for a colour fix\./);
});

test("over the budget the middle is left out, said to be, and the export is partial", () => {
  const conversation = [user("the ask: build the thing")];
  for (let i = 0; i < 200; i++) conversation.push(assistant(`step ${i} ${"y".repeat(900)}`));
  conversation.push(user("the end: it works"));
  const rec = record("s_big", conversation);
  const out = exportConversation(rec, [], { observationChars: 10000, inputChars: 40000 });
  const t = out.files["trajectory.md"];
  assert.ok(out.partial, "the export says it is partial");
  assert.match(out.partial, /^the exporter left out events \[\d+\]–\[\d+\] of the conversation \([\d,]+ chars\) to fit the 40,000-character budget$/);
  assert.match(t, /\[events \[\d+\]–\[\d+\] left out by the exporter for length: [\d,]+ events, [\d,]+ chars\]/);
  assert.match(t, /\[1\] \[USER\] the ask/, "the head stays");
  assert.match(t, /\[202\] \[USER\] the end: it works/, "the tail stays");
  assert.ok(t.length <= 40000, "the transcript fits the budget");
  assert.ok(out.visible.has(1) && out.visible.has(202));
  assert.ok(!out.visible.has(100), "a dropped event is not visible, so citing it is refused later");
});
