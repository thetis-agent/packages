import { assetPart, textContent, textPart } from "@thetis/runtime/lib/content";
// Editing a sent message: the request the gateway writes, the `rewind` step that applies it, the earlier
// versions it keeps and reads back, the stamp of the turn that applied it, and the forget hook over all of
// it. Over temporary homes; nothing here reaches a model.
import { test, after } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import type { Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, TurnEvent, UiCommandEnv } from "@thetis/runtime/contracts";
import { callModel, editsPath, forgetSession, harnessStamps, messageHash, rewindRequestPath, rewindTurn, textHash, uiEditVersions, uiRewindCancel, uiRewindRequest, unattendedPath, type EditRecord } from "../src/index.js";

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "thetis-rewind-test-"));
  homes.push(h);
  return h;
}

const user = (text: string): Message => ({ role: "user", content: textContent(text) });
const reply = (text: string, calls: string[] = []): Message => ({ role: "assistant", content: textContent(text), ...(calls.length ? { toolCalls: calls.map((name, i) => ({ id: `c${i}`, name, args: {} })) } : {}) });
const result = (id: string, text: string): Message => ({ role: "tool", content: textContent(text), toolCallId: id, name: "t" });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The command env as the gateway builds it: files relative to the home. */
function uiEnv(h: string, session?: string): UiCommandEnv {
  return {
    cwd: h,
    readFile: async (p: string) => readFileSync(join(h, p), "utf8"),
    writeFile: async (p: string, content: string) => {
      mkdirSync(dirname(join(h, p)), { recursive: true });
      writeFileSync(join(h, p), content);
    },
    user: "alice",
    role: "user",
    config: {},
    ...(session ? { session } : {}),
  } as unknown as UiCommandEnv;
}

/** The step's context: the saved conversation with this turn's input appended, as the kernel hands it over. */
function stepCtx(h: string, saved: Message[], input: Message[], over: Partial<PackageStepContext> = {}) {
  const events: TurnEvent[] = [];
  const ctx = {
    emit: (e: TurnEvent) => events.push(e),
    signal: new AbortController().signal,
    session: { id: "s1", user: "alice" },
    turn: { id: "t_edit", input },
    conversation: [...saved, ...input],
    call: { model: "m", messages: [], tools: [], params: {} },
    harness: { "@thetis/harness-core": { lastCall: { model: "m" }, keep: 1 }, "@other/pkg": { x: 1 } },
    packages: { has: () => false, get: () => undefined, list: () => [] },
    config: {},
    env: { cwd: h },
    ...over,
  } as unknown as PackageStepContext;
  return { ctx, events };
}

const saved: Message[] = [user("first\n\n[Turn context: Monday 2026-11-02 10:00 UTC]"), reply("one"), user("second\n\n[Turn context: Monday 2026-11-02 10:01 UTC]"), reply("", ["t"]), result("c0", "ran"), reply("two")];

async function request(h: string, at: number, text: string, conv: Message[] = saved): Promise<void> {
  await uiRewindRequest({ session: "s1", at, expect: messageHash(conv[at]), input: textHash(text) }, uiEnv(h));
}

const edits = (h: string): EditRecord[] => readFileSync(join(h, editsPath("s1")), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("the hashes are the one-liners the gateway copies", () => {
  assert.equal(messageHash(user("hi")), sha("user\nhi"));
  assert.equal(messageHash({ role: "user", content: [assetPart("a1", "image/png", "x.png"), textPart("hi")] }), sha("user\nhi"), "text parts only");
  assert.equal(textHash("  hi \n"), sha("hi"));
});

test("rewind-request validates and writes the request; rewind-cancel empties it", async () => {
  const h = home();
  const ok = { session: "s1", at: 2, expect: "a".repeat(64), input: "b".repeat(64) };
  assert.deepEqual(await uiRewindRequest(ok, uiEnv(h)), { data: { requested: true, session: "s1" } });
  const written = JSON.parse(readFileSync(join(h, "harness-core/rewind/s1.json"), "utf8"));
  assert.deepEqual({ ...written, createdAt: undefined }, { v: 1, at: 2, expect: "a".repeat(64), input: "b".repeat(64), createdAt: undefined });
  assert.ok(Date.parse(written.createdAt) <= Date.now());
  await assert.rejects(uiRewindRequest({ ...ok, at: -1 }, uiEnv(h)), /at must be/);
  await assert.rejects(uiRewindRequest({ ...ok, at: 1.5 }, uiEnv(h)), /at must be/);
  await assert.rejects(uiRewindRequest({ ...ok, expect: "A".repeat(64) }, uiEnv(h)), /expect must be/);
  await assert.rejects(uiRewindRequest({ ...ok, input: "short" }, uiEnv(h)), /input must be/);
  await assert.rejects(uiRewindRequest({ ...ok, session: "../x" }, uiEnv(h)), /invalid session id/);
  await assert.rejects(uiRewindRequest({ at: 0, expect: ok.expect, input: ok.input }, uiEnv(h)), /no conversation is open/);
  assert.deepEqual(await uiRewindRequest({ at: 0, expect: ok.expect, input: ok.input }, uiEnv(h, "s2")), { data: { requested: true, session: "s2" } }, "the session the page named is used when args name none");
  assert.deepEqual(await uiRewindCancel({ session: "s1" }, uiEnv(h)), { data: { cancelled: true, session: "s1" } });
  assert.equal(readFileSync(join(h, rewindRequestPath("s1")), "utf8"), "");
  const { ctx } = stepCtx(h, saved, [user("x")]);
  assert.equal(await rewindTurn(ctx), undefined, "an empty request is none");
});

test("a matching request cuts back to the edited message and keeps what it cut", async () => {
  const h = home();
  await request(h, 2, "second, better");
  const input = [user("second, better")];
  const { ctx, events } = stepCtx(h, saved, input);
  const out = await rewindTurn(ctx);
  assert.deepEqual(out!.conversation, [...saved.slice(0, 2), ...input]);
  assert.deepEqual(out!.harness, { "@thetis/harness-core": { keep: 1, rewound: { turn: "t_edit", at: 2 } }, "@other/pkg": { x: 1 } }, "lastCall goes; the rest is kept");
  assert.deepEqual(events, [{ type: "extension", name: "@thetis/harness-core", data: { phase: "rewound", at: 2, replaced: 4 } }]);
  const [line] = edits(h);
  assert.deepEqual({ ...line, editedAt: undefined }, { v: 1, session: "s1", turn: "t_edit", at: 2, editedAt: undefined, replaced: saved.slice(2) });
  assert.ok(!existsSync(join(h, rewindRequestPath("s1"))), "the request is consumed");
  assert.equal(await rewindTurn(stepCtx(h, saved, input).ctx), undefined, "and applies once");
});

test("an edit of the first message, and of the last one, both apply", async () => {
  const h = home();
  await request(h, 0, "zero");
  const first = await rewindTurn(stepCtx(h, saved, [user("zero")]).ctx);
  assert.deepEqual(first!.conversation, [user("zero")]);
  // The last message from the person, with only its reply after it.
  const two = [user("a"), reply("b")];
  await request(h, 0, "a2", two);
  const last = await rewindTurn(stepCtx(h, two, [user("a2")]).ctx);
  assert.deepEqual(last!.conversation, [user("a2")]);
  assert.deepEqual(edits(h).map((e) => e.replaced.length), [6, 2]);
});

test("the input keeps the edited message's attachments; only its text is hashed", async () => {
  const h = home();
  const withFile: Message = { role: "user", content: [assetPart("a1", "image/png", "shot.png"), textPart("what is this")] };
  const conv = [withFile, reply("a cat")];
  await request(h, 0, "what is this, exactly", conv);
  const input: Message = { role: "user", content: [assetPart("a1", "image/png", "shot.png"), textPart("what is this, exactly")] };
  const out = await rewindTurn(stepCtx(h, conv, [input]).ctx);
  assert.deepEqual(out!.conversation, [input]);
  assert.deepEqual(edits(h)[0].replaced, conv);
});

test("a mismatch changes nothing and consumes the request: expect, input, index, age", async () => {
  const h = home();
  const input = [user("second, better")];
  const tries: [string, () => Promise<void>][] = [
    ["expect", () => uiRewindRequest({ session: "s1", at: 2, expect: messageHash(user("something else")), input: textHash("second, better") }, uiEnv(h)).then(() => {})],
    ["input", () => request(h, 2, "not what was sent")],
    ["index", () => uiRewindRequest({ session: "s1", at: 99, expect: messageHash(saved[2]), input: textHash("second, better") }, uiEnv(h)).then(() => {})],
    ["age", async () => {
      await request(h, 2, "second, better");
      const file = join(h, rewindRequestPath("s1"));
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), createdAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
    }],
    ["garbage", async () => writeFileSync(join(h, rewindRequestPath("s1")), "{not json")],
  ];
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [why, write] of tries) {
      await write();
      const { ctx, events } = stepCtx(h, saved, input);
      assert.equal(await rewindTurn(ctx), undefined, why);
      assert.deepEqual(events, [], why);
      assert.ok(!existsSync(join(h, rewindRequestPath("s1"))), `${why}: consumed`);
    }
  } finally {
    console.warn = warn;
  }
  assert.ok(!existsSync(join(h, editsPath("s1"))), "nothing was kept, because nothing was cut");
});

test("the resume of an edit's turn a crash cut before the step ran applies the edit with the saved input", async () => {
  const h = home();
  await request(h, 2, "second, better");
  // The kernel saved the record with the input appended, then the process died; the resume has no input.
  const { ctx } = stepCtx(h, [...saved, user("second, better")], []);
  const out = await rewindTurn(ctx);
  assert.deepEqual(out!.conversation, [...saved.slice(0, 2), user("second, better")]);
  assert.deepEqual(edits(h)[0].replaced, saved.slice(2));
  // A resume whose last message is not the person's is no candidate.
  await request(h, 2, "second, better");
  assert.equal(await rewindTurn(stepCtx(h, saved, []).ctx), undefined);
});

test("edit-versions: earlier versions newest first, text without the turn context, tool work counted", async () => {
  const h = home();
  const conv: Message[] = [user("a\n\n[Turn context: Monday 2026-11-02 10:00 UTC]"), reply("looking", ["read", "spawn_subagent", "spawn_subagent"]), result("c0", "x"), result("c1", "y"), result("c2", "z"), reply("done")];
  await request(h, 0, "b", conv);
  await rewindTurn(stepCtx(h, conv, [user("b")]).ctx);
  const second = [user("b"), reply("ok")];
  await request(h, 0, "c", second);
  await rewindTurn(stepCtx(h, second, [user("c")]).ctx);
  const answer = (await uiEditVersions({ session: "s1", at: 0 }, uiEnv(h))) as { data: { versions: { at: number; turn: string; editedAt: string; messages: unknown[] }[] } };
  const versions = answer.data.versions;
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[0].messages, [{ role: "user", text: "b", tools: 0, agents: 0 }, { role: "assistant", text: "ok", tools: 0, agents: 0 }], "newest first");
  assert.deepEqual(versions[1].messages, [
    { role: "user", text: "a", tools: 0, agents: 0 },
    { role: "assistant", text: "looking", tools: 1, agents: 2 },
    { role: "assistant", text: "done", tools: 0, agents: 0 },
  ], "tool results are counted on the call, not listed");
  assert.equal(versions[0].turn, "t_edit");
  assert.ok(Date.parse(versions[0].editedAt));
  assert.deepEqual(((await uiEditVersions({ session: "s1", at: 3 }, uiEnv(h))) as { data: { versions: unknown[] } }).data.versions, []);
  assert.deepEqual(((await uiEditVersions({ session: "s9" }, uiEnv(h))) as { data: { versions: unknown[] } }).data.versions, [], "no file, no versions");
  await assert.rejects(uiEditVersions({ session: "s1", at: "0" }, uiEnv(h)), /at must be/);
});

test("edit-versions drops an edit a later one cut away, and clips long text", async () => {
  const h = home();
  const lines: EditRecord[] = [
    { v: 1, session: "s1", turn: "t1", at: 4, editedAt: "2026-11-01T10:00:00.000Z", replaced: [user("late")] },
    { v: 1, session: "s1", turn: "t2", at: 2, editedAt: "2026-11-01T10:05:00.000Z", replaced: [user("x".repeat(30_000))] },
  ];
  mkdirSync(join(h, "harness-core/edits"), { recursive: true });
  writeFileSync(join(h, editsPath("s1")), lines.map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
  const all = ((await uiEditVersions({ session: "s1" }, uiEnv(h))) as { data: { versions: { at: number; messages: { text: string }[] }[] } }).data.versions;
  assert.deepEqual(all.map((v) => v.at), [2], "the edit at 4 was on a branch the edit at 2 replaced");
  assert.equal(all[0].messages[0].text.length, 20_000);
});

test("the turn that applied an edit is stamped rewound; the project falls back to the agents file", async () => {
  const h = home();
  mkdirSync(join(h, "projects/agents"), { recursive: true });
  writeFileSync(join(h, "projects/sessions.json"), JSON.stringify({ s_root: "p_1234abcd" }));
  writeFileSync(join(h, "projects/agents/s1.json"), JSON.stringify({ project: "p_00000000", parent: "s_root" }));
  const turn = async (turnId: string, harness: Record<string, unknown>, session = "s1") => {
    const ctx = {
      emit: () => {},
      signal: new AbortController().signal,
      session: { id: session, user: "alice", parent: "s_root" },
      turn: { id: turnId, input: [user("go")] },
      conversation: [user("go")],
      call: { model: "m", system: "S", messages: [], tools: [], params: {} },
      harness,
      config: {},
      packages: { has: () => false, get: () => undefined, list: () => [] as PackageInfo[] },
      env: { cwd: h, invokeTool: async () => "", kernel: { providers: { call: async (_c: ProviderCall, onEvent: (e: ProviderEvent) => void) => onEvent({ type: "text", delta: "ok" }) } } },
    } as unknown as PackageStepContext;
    await callModel(ctx);
    for (let i = 0; i < 50 && (await harnessStamps(h, session)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  };
  await turn("t_a", { "@thetis/harness-core": { rewound: { turn: "t_a", at: 2 } } });
  await turn("t_b", { "@thetis/harness-core": { rewound: { turn: "t_a", at: 2 } } }, "s_other");
  await new Promise((r) => setTimeout(r, 50));
  const [stamp] = await harnessStamps(h, "s1");
  assert.equal(stamp.rewound, 2);
  assert.equal(stamp.project, "p_00000000", "a subagent's project is the one it inherited");
  const [other] = await harnessStamps(h, "s_other");
  assert.equal("rewound" in other, false, "a later turn is not the one that rewound");
  assert.equal(other.project, null, "no entry, no agents file: no project");
  writeFileSync(join(h, "projects/sessions.json"), JSON.stringify({ s_root: "p_1234abcd", s1: "p_aaaaaaaa" }));
  await turn("t_c", {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await harnessStamps(h, "s1")).at(-1)!.project, "p_aaaaaaaa", "the map wins over the agents file");
});

test("forget removes the earlier versions, an untaken request and the unattended marker, and says so", async () => {
  const h = home();
  await request(h, 0, "b", saved);
  await rewindTurn(stepCtx(h, saved, [user("b")]).ctx);
  await request(h, 0, "c", [user("b")]);
  await uiEnv(h).writeFile(unattendedPath("s1"), JSON.stringify({ by: "@thetis/workflows" }));
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s1", sessions: ["s1"] }, { cwd: h }), { items: [{ id: "edits", label: "Earlier versions of edited messages" }] });
  const out = await forgetSession({ phase: "forget", session: "s1", sessions: ["s1"] }, { cwd: h });
  assert.deepEqual(out, { removed: ["Earlier versions of 1 message."] });
  for (const rel of [editsPath("s1"), rewindRequestPath("s1"), unattendedPath("s1")]) assert.ok(!existsSync(join(h, rel)), rel);
  assert.deepEqual(await forgetSession({ phase: "forget", session: "s1", sessions: ["s1"] }, { cwd: h }), { removed: [] });
});
