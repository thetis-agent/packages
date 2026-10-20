// The exporter: the trajectory grammar and its numbering, every cut with its marker, subagents numbered
// on from the conversation, the compaction summary, and a partial export over the budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_CHARS, clip, descendantsOf, eventsOf, exportConversation, marker } from "../lib/export.js";
import { harnessFiles, installedPackages, NONE_TEXT, readStamps, stampedVersions } from "../lib/harness.js";
import { indexMarkdown } from "../lib/library.js";
import { assistant, call, fakeKernel, put, record, result, sampleSession, tempHome, text, user } from "./helpers.js";

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

test("the exporter keeps room for the other evidence", () => {
  const conversation = [user("the ask")];
  for (let i = 0; i < 100; i++) conversation.push(assistant(`step ${i} ${"y".repeat(900)}`));
  const rec = record("s_r", conversation);
  assert.equal(exportConversation(rec, [], { observationChars: 10000, inputChars: 200000 }).partial, null);
  assert.ok(exportConversation(rec, [], { observationChars: 10000, inputChars: 200000, reserve: 150000 }).partial, "a reserve takes from the transcript's budget");
});

const stamp = (turn, extra = {}) => ({ turn, at: `2026-10-20T10:0${turn}:00.000Z`, model: "anthropic/claude-sonnet-5.5", versions: { "@thetis/harness-core": "0.8.0", "@thetis/tools-files": "0.4.0" }, system: "aaaa1111aaaa1111", tools: "bbbb2222bbbb2222", skills: { loader: "@thetis/skills-hybrid", pinned: [{ id: "packages", contentHash: "x" }], universal: ["thetis"] }, groups: ["files"], project: null, ...extra });
const TOOLS = [{ name: "read_file", package: "@thetis/tools-files", description: "Reads a file.", parameters: { type: "object" } }];

test("harness/: turns.md, one system and one tools file per distinct snapshot, versions as changes", async () => {
  const { home, done } = await tempHome();
  try {
    const S = "s_aaaa1111";
    const lines = [stamp(1), stamp(2), stamp(3, { system: "cccc3333cccc3333", versions: { "@thetis/harness-core": "0.9.0", "@thetis/tools-files": "0.4.0", "@thetis/exa": "0.1.0" } })];
    await put(home, `harness-core/turns/${S}.jsonl`, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{torn`);
    await put(home, `harness-core/snapshots/${S}/aaaa1111aaaa1111.md`, "You are Thetis. First guide.");
    await put(home, `harness-core/snapshots/${S}/cccc3333cccc3333.md`, "You are Thetis. Second guide.");
    await put(home, `harness-core/snapshots/${S}/bbbb2222bbbb2222.json`, TOOLS);
    const C = "s_cccc0000";
    await put(home, `harness-core/turns/${C}.jsonl`, `${JSON.stringify(stamp(1, { tools: "dddd4444dddd4444" }))}\n`);
    const stamps = await readStamps(home, S);
    assert.equal(stamps.length, 3, "a torn line is skipped");
    const out = await harnessFiles(home, [{ id: S, stamps, dir: `harness-core/snapshots/${S}` }, { id: C, label: "digger", stamps: await readStamps(home, C), dir: `harness-core/snapshots/${C}` }], {});
    assert.equal(out.stamped, true);
    assert.deepEqual(Object.keys(out.files).sort(), ["system-1.md", "system-2.md", "tools-1.md", "tools-2.md", "turns.md"]);
    assert.match(out.files["system-1.md"], /You are Thetis\. First guide\./);
    assert.match(out.files["system-2.md"], /Second guide/);
    assert.match(out.files["tools-1.md"], /## read_file · @thetis\/tools-files\n\nReads a file\./);
    assert.doesNotMatch(out.files["tools-1.md"], /"type"/, "parameters are left out");
    assert.match(out.files["tools-2.md"], /the snapshot dddd4444dddd4444 is missing/);
    const t = out.files["turns.md"];
    assert.match(t, /### Turn 1[^\n]*\n\nmodel: anthropic\/claude-sonnet-5\.5\nsystem: system-1\.md · tools: tools-1\.md\nversions:\n- @thetis\/harness-core 0\.8\.0\n- @thetis\/tools-files 0\.4\.0/);
    assert.match(t, /### Turn 2[\s\S]*?versions: unchanged/);
    assert.match(t, /### Turn 3[\s\S]*?system: system-2\.md · tools: tools-1\.md\nversions changed:\n- added @thetis\/exa 0\.1\.0\n- @thetis\/harness-core 0\.8\.0 → 0\.9\.0/);
    assert.match(t, /skills: loader @thetis\/skills-hybrid; pinned: packages; universal: thetis/);
    assert.match(t, /groups: files\nproject: none/);
    assert.match(t, /## Subagent s_cccc0000 \(digger\)/);
    assert.deepEqual(out.versions, { "@thetis/harness-core": "0.9.0", "@thetis/tools-files": "0.4.0", "@thetis/exa": "0.1.0" });
    assert.deepEqual(stampedVersions([]), {});
  } finally {
    await done();
  }
});

test("harness/NONE.md when the conversation was never stamped: today's versions, no system text", async () => {
  const { home, done } = await tempHome();
  try {
    const today = { "@thetis/tools-files": "0.4.0", "@thetis/harness-core": "0.8.0" };
    const out = await harnessFiles(home, [{ id: "s_a", stamps: [], dir: "x" }], today);
    assert.equal(out.stamped, false);
    assert.deepEqual(Object.keys(out.files), ["NONE.md"]);
    assert.ok(out.files["NONE.md"].includes(NONE_TEXT));
    assert.match(out.files["NONE.md"], /- @thetis\/harness-core 0\.8\.0\n- @thetis\/tools-files 0\.4\.0/);
    assert.deepEqual(out.versions, today);
  } finally {
    await done();
  }
});

test("today's packages come from the kernel, else from the store beside the home", async () => {
  const { home, done } = await tempHome();
  try {
    assert.equal((await installedPackages({ home, kernel: fakeKernel() })).find((p) => p.name === "@thetis/tools-files").version, "0.4.0");
    await put(home, "store/node_modules/@thetis/sheets/package.json", { name: "@thetis/sheets", version: "0.2.0" });
    await put(home, "store/node_modules/plain/package.json", { name: "plain", version: "1.0.0" });
    const inner = `${home}/home`;
    const list = await installedPackages({ home: inner, kernel: {} });
    assert.deepEqual(list.map((p) => `${p.name}@${p.version}`).sort(), ["@thetis/sheets@0.2.0", "plain@1.0.0"]);
  } finally {
    await done();
  }
});

test("library/INDEX.md lists live entries, open findings, and what was tried and rejected", () => {
  const lib = {
    entries: [
      { id: "L-aaaaaa", state: "adopted", kind: "skill", target: "generated-files", cue: "a generated file", lesson: "Find the generator." },
      { id: "L-bbbbbb", state: "proposed", kind: "guide-note", target: "-", cue: "always", lesson: "Ask first." },
      { id: "L-cccccc", state: "rejected", kind: "config", target: "@thetis/harness-core maxRounds", cue: "c", lesson: "More rounds.", verdict: { result: "hurt", why: "change runs graded 2, base runs 4" } },
      { id: "L-dddddd", state: "rejected", kind: "skill", target: "x", cue: "c", lesson: "Never tried.", verdict: null },
    ],
  };
  const store = { findings: [
    { id: "F-111111", package: "@thetis/tools-files", component: "read_file", what: "Cut the file.", state: "open", seen: [] },
    { id: "F-222222", package: "@thetis/exa", component: "search", what: "Empty.", state: "possibly-fixed", since: "0.2.0", seen: [] },
    { id: "F-333333", package: "@thetis/exa", component: "x", what: "Closed one.", state: "closed", seen: [] },
  ] };
  const md = indexMarkdown(lib, store);
  assert.match(md, /- L-aaaaaa · adopted · skill generated-files · a generated file · Find the generator\./);
  assert.match(md, /- L-bbbbbb · proposed · guide-note · always · Ask first\./);
  assert.match(md, /- F-111111 · @thetis\/tools-files read_file · Cut the file\./);
  assert.match(md, /- F-222222 · @thetis\/exa search · Empty\. \(possibly fixed in 0\.2\.0\)/);
  assert.doesNotMatch(md, /F-333333/);
  const [live, rejected] = md.split("## Tried and rejected");
  assert.doesNotMatch(live, /L-cccccc/);
  assert.match(rejected, /- L-cccccc · config @thetis\/harness-core maxRounds · More rounds\. — the trial: hurt: change runs graded 2, base runs 4/);
  assert.match(rejected, /- L-dddddd · skill x · Never tried\. — rejected without a trial/);
  assert.match(indexMarkdown({ entries: [] }, { findings: [] }), /## Changes\n\n\(none\)/);
});
