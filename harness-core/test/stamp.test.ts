import { textContent } from "@thetis/runtime/lib/content";
// What each turn ran with: the stamp `callModel` fires before the first request, the snapshots it keeps once
// per conversation, the guide's working notes, and the forget hook over both. Over temporary homes and a fake
// provider; nothing here reaches a model.
import { test, after } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { HarnessState, Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, SessionInfo, ToolSpec } from "@thetis/runtime/contracts";
import { callModel, forgetSession, GUIDE_NOTE_MAX, GUIDE_NOTES_MAX, guideNotesOf, harnessStamps, systemPrompt, type HarnessStamp } from "../src/index.js";

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "thetis-stamp-test-"));
  homes.push(h);
  return h;
}

const pkg = (name: string, version: string) => ({ name, version, type: "tool", description: "", root: "", thetis: { type: "tool" } }) as unknown as PackageInfo;
const tool = (name: string, pkgName = "@a/tools"): ToolSpec => ({ name, description: `The ${name} tool.`, parameters: { type: "object", properties: { x: { type: "string" } } }, package: pkgName, export: name, ...(name === "zeta" ? { concurrent: true } : {}) });
const user = (text: string): Message => ({ role: "user", content: textContent(text) });

interface Over {
  cwd?: string;
  session?: SessionInfo;
  system?: string;
  tools?: ToolSpec[];
  harness?: HarnessState;
  packages?: PackageInfo[];
  conversation?: Message[];
  input?: Message[];
  onCall?: () => void;
}

/** One turn, answered by a provider that says "done", in `cwd`. */
function turnCtx(over: Over = {}): PackageStepContext {
  const list = over.packages ?? [pkg("@thetis/harness-core", "0.8.0")];
  const conversation = over.conversation ?? [user("go")];
  return {
    emit: () => {},
    signal: new AbortController().signal,
    session: over.session ?? { id: "s1", user: "alice" },
    turn: { id: `t_${Math.random().toString(16).slice(2, 10)}`, input: over.input ?? conversation.slice(-1) },
    conversation,
    call: { model: "vendor/model", system: over.system ?? "You are Thetis.", messages: [], tools: over.tools ?? [tool("alpha")], params: {} },
    harness: over.harness ?? {},
    config: {},
    packages: { has: (n: string) => list.some((p) => p.name === n), get: (n: string) => list.find((p) => p.name === n), list: () => list },
    env: {
      cwd: over.cwd ?? home(),
      invokeTool: async () => "ran",
      kernel: {
        providers: {
          call: async (_call: ProviderCall, onEvent: (e: ProviderEvent) => void) => {
            over.onCall?.();
            onEvent({ type: "text", delta: "done" });
          },
        },
        config: { effective: async () => ({}) },
      },
    },
  } as unknown as PackageStepContext;
}

/** The stamps, once `n` of them are on disk: the write is fired, not awaited, so it may land just after the turn. */
async function stampsOf(cwd: string, session: string, n: number): Promise<HarnessStamp[]> {
  for (let i = 0; i < 400; i++) {
    const got = await harnessStamps(cwd, session);
    if (got.length >= n) return got;
    await new Promise((r) => setTimeout(r, 5));
  }
  return harnessStamps(cwd, session);
}

const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

test("a turn is stamped with its model, versions, prompt and tool hashes, skills, groups and project; the tools snapshot is sorted by name", async () => {
  const cwd = home();
  mkdirSync(join(cwd, "projects"), { recursive: true });
  writeFileSync(join(cwd, "projects/sessions.json"), JSON.stringify({ s1: "p_1234abcd", s2: "p_00000000" }));
  const ctx = turnCtx({
    cwd,
    system: "You are Thetis.\n\nThe guide.",
    tools: [tool("zeta", "@z/z"), tool("alpha"), tool("mid", "@m/m")],
    packages: [pkg("@thetis/zz", "2.0.0"), pkg("@thetis/harness-core", "0.8.0"), pkg("@thetis/aa", "1.0.0")],
    harness: {
      "@thetis/skills": { loader: "@thetis/skills-hybrid", universal: ["thetis", 7], pinned: [{ id: "a/b", contentHash: "abc", score: 0.9, how: "bm25" }, { nope: 1 }], ranked: [{ id: "x" }], notes: ["n"] },
      "@thetis/tool-groups": { active: ["files", "web"], why: {} },
    },
    conversation: [user("one"), { role: "assistant", content: textContent("a") }, user("two"), { role: "assistant", content: textContent("b") }, user("three")],
  });
  const out = await callModel(ctx);
  assert.ok(out.conversation!.length > 0);
  const [stamp] = await stampsOf(cwd, "s1", 1);
  const { at, turnId, ...rest } = stamp;
  assert.equal(new Date(at).toISOString(), at);
  assert.equal(turnId, ctx.turn.id);
  const snapshot = [tool("alpha"), tool("mid", "@m/m"), tool("zeta", "@z/z")].map((t) => ({ name: t.name, package: t.package, description: t.description, parameters: t.parameters }));
  assert.deepEqual(rest, {
    turn: 3,
    model: "vendor/model",
    versions: { "@thetis/aa": "1.0.0", "@thetis/harness-core": "0.8.0", "@thetis/zz": "2.0.0" },
    system: sha16("You are Thetis.\n\nThe guide."),
    tools: sha16(JSON.stringify(snapshot)),
    skills: { loader: "@thetis/skills-hybrid", pinned: [{ id: "a/b", contentHash: "abc" }], universal: ["thetis"] },
    groups: ["files", "web"],
    project: "p_1234abcd",
  });
  const dir = join(cwd, "harness-core/snapshots/s1");
  assert.equal(readFileSync(join(dir, `${stamp.system}.md`), "utf8"), "You are Thetis.\n\nThe guide.", "the system text exactly");
  const toolsFile = readFileSync(join(dir, `${stamp.tools}.json`), "utf8");
  assert.deepEqual(JSON.parse(toolsFile), snapshot, "name, package, description and parameters, sorted by name; nothing else (no concurrent, no export)");
  assert.equal(sha16(toolsFile), stamp.tools, "a snapshot's name is the hash of its own bytes");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temporary file is left behind");
});

test("snapshots are written once per conversation: the same prompt and tools on later turns add a line and no file", async () => {
  const cwd = home();
  const conversation = [user("one")];
  await callModel(turnCtx({ cwd, conversation }));
  await stampsOf(cwd, "s1", 1);
  await callModel(turnCtx({ cwd, conversation: [...conversation, { role: "assistant", content: textContent("done") }, user("two")] }));
  const two = await stampsOf(cwd, "s1", 2);
  assert.deepEqual(two.map((s) => s.turn), [1, 2]);
  assert.equal(two[0].system, two[1].system);
  assert.equal(two[0].tools, two[1].tools);
  assert.equal(readdirSync(join(cwd, "harness-core/snapshots/s1")).length, 2, "one prompt file and one tools file for both turns");
  await callModel(turnCtx({ cwd, system: "A different prompt.", conversation: [user("one"), user("two"), user("three")] }));
  const three = await stampsOf(cwd, "s1", 3);
  assert.notEqual(three[2].system, three[0].system);
  assert.equal(three[2].tools, three[0].tools);
  assert.equal(readdirSync(join(cwd, "harness-core/snapshots/s1")).length, 3, "only the new prompt is a new file");
  assert.equal(three[2].skills, null, "no skills loader, no skills");
  assert.equal(three[2].groups, null, "no tool groups, no groups");
  assert.equal(three[2].project, null, "no projects file, no project");
});

test("a stamp that cannot be written is logged once and never fails the turn", async () => {
  const parent = home();
  const cwd = join(parent, "not-a-directory");
  writeFileSync(cwd, "a file where the home should be");
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    let calls = 0;
    for (let i = 0; i < 2; i++) {
      const out = await callModel(turnCtx({ cwd, onCall: () => calls++ }));
      assert.equal(out.conversation!.at(-1)!.role, "assistant", "the turn completed");
    }
    assert.equal(calls, 2, "every request was sent");
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.filter((w) => w.includes("could not record what a turn ran with")).length, 1, "two failed stamps are one line in the log");
});

test("a stamp stuck on the disk does not hold up the turn: the request is sent and the turn ends while it waits", async () => {
  const cwd = home();
  mkdirSync(join(cwd, "projects"), { recursive: true });
  const fifo = join(cwd, "projects/sessions.json");
  execFileSync("mkfifo", [fifo]); // a read of it waits until something writes
  let calls = 0;
  const out = await callModel(turnCtx({ cwd, onCall: () => calls++ }));
  assert.equal(calls, 1);
  assert.equal(out.conversation!.at(-1)!.role, "assistant");
  assert.deepEqual(await harnessStamps(cwd, "s1"), [], "the stamp is still waiting on the projects file");
  writeFileSync(fifo, JSON.stringify({ s1: "p_1234abcd" })); // let it go, so the test process can end
  const [stamp] = await stampsOf(cwd, "s1", 1);
  assert.equal(stamp.project, "p_1234abcd", "it lands afterwards, whole");
});

test("a subagent is stamped under its own session id", async () => {
  const cwd = home();
  await callModel(turnCtx({ cwd, session: { id: "s_child", user: "alice", parent: "s1" } as SessionInfo }));
  assert.equal((await stampsOf(cwd, "s_child", 1)).length, 1);
  assert.deepEqual(await harnessStamps(cwd, "s1"), [], "nothing is written for the parent");
  assert.ok(existsSync(join(cwd, "harness-core/snapshots/s_child")));
});

test("harnessStamps skips a torn line and answers [] for a missing file or an id that cannot be a session", async () => {
  const cwd = home();
  mkdirSync(join(cwd, "harness-core/turns"), { recursive: true });
  writeFileSync(join(cwd, "harness-core/turns/s1.jsonl"), `${JSON.stringify({ turn: 1 })}\n{"turn": 2, "at`);
  assert.deepEqual(await harnessStamps(cwd, "s1"), [{ turn: 1 }]);
  assert.deepEqual(await harnessStamps(cwd, "s2"), []);
  assert.deepEqual(await harnessStamps(cwd, "../s1"), []);
});

// ---- guideNotes ----

const promptOf = async (config: Record<string, unknown>) => (await systemPrompt({ ...turnCtx({ cwd: "/home/alice" }), config })).call!.system!;

test("guideNotes: an empty or missing list leaves the guide byte-identical", async () => {
  const bare = await promptOf({});
  assert.equal(await promptOf({ guideNotes: [] }), bare);
  assert.equal(await promptOf({ guideNotes: "not a list" }), bare);
  assert.doesNotMatch(bare, /Working notes/);
});

test("guideNotes: notes are appended after the guide as a Working notes list", async () => {
  const bare = await promptOf({});
  const noted = await promptOf({ guideNotes: ["Run the tests before you say done.", "  Prefer  rg\nover grep.  "] });
  assert.equal(noted, `${bare}\n\nWorking notes:\n- Run the tests before you say done.\n- Prefer rg over grep.`);
});

test("guideNotes: a note over 300 characters, a non-string and anything past 20 are left out, and that is logged once", () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    const long = "x".repeat(GUIDE_NOTE_MAX + 1);
    const exact = "y".repeat(GUIDE_NOTE_MAX);
    const many = Array.from({ length: 25 }, (_, i) => `note ${i}`);
    const config = { guideNotes: [long, 42, exact, ...many] };
    const kept = guideNotesOf(config);
    assert.equal(kept.length, GUIDE_NOTES_MAX);
    assert.equal(kept[0], exact, "exactly 300 characters fits");
    assert.deepEqual(kept.slice(1), many.slice(0, GUIDE_NOTES_MAX - 1));
    guideNotesOf(config);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1, "the same drop on every turn is logged once");
  assert.match(warned[0], /guideNotes: 8 notes were left out/);
});

// ---- forget ----

test("forget: the preview names what each turn ran with when there is some, and the forget removes the stamps and snapshots", async () => {
  const cwd = home();
  await callModel(turnCtx({ cwd }));
  await callModel(turnCtx({ cwd, session: { id: "s_child", user: "alice", parent: "s1" } as SessionInfo }));
  await callModel(turnCtx({ cwd, session: { id: "s_keep", user: "alice" } }));
  await stampsOf(cwd, "s1", 1);
  await stampsOf(cwd, "s_child", 1);
  await stampsOf(cwd, "s_keep", 1);
  const sessions = ["s1", "s_child"];
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s1", sessions }, { cwd }), { items: [{ id: "turns", label: "What each turn ran with (versions, prompt and tools)" }] });
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s_none", sessions: ["s_none"] }, { cwd }), {}, "nothing to name when nothing was kept");
  const out = (await forgetSession({ phase: "forget", session: "s1", sessions }, { cwd })) as { removed: string[] };
  assert.ok(out.removed.includes("What each turn ran with (versions, prompt and tools) in 2 conversations."), JSON.stringify(out));
  for (const s of sessions) {
    assert.ok(!existsSync(join(cwd, `harness-core/turns/${s}.jsonl`)));
    assert.ok(!existsSync(join(cwd, `harness-core/snapshots/${s}`)));
  }
  assert.equal((await harnessStamps(cwd, "s_keep")).length, 1, "another conversation's stamps stay");
  assert.ok(existsSync(join(cwd, "harness-core/snapshots/s_keep")));
  const again = (await forgetSession({ phase: "forget", session: "s1", sessions }, { cwd })) as { removed: string[] };
  assert.ok(!again.removed.some((r) => r.startsWith("What each turn")), "a second forget removes nothing");
});
