// The session hooks: what an archive writes and why, what a restore cancels, and the two phases of a
// forget: the reflection, the proposals that came only from it (with their trials), adopted changes kept,
// shared entries and findings losing only this conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideArchive, forgetSession, onArchive } from "../lib/hooks.js";
import { readFindings, readLibrary, writeLibrary } from "../lib/library.js";
import { fakeKernel, get, put, sampleSession, tempHome } from "./helpers.js";

const S = "s_aaaa1111";

async function fence({ turns = 3, config = {}, parent } = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(S, { turns, ...(parent ? { parent } : {}) })], home, admin: true });
  // The shape the gateway gives a hook: a tool env, whose session is `{ id, user }`.
  const env = { cwd: home, kernel, config, session: { id: S, user: "u1" } };
  return { home, done, env };
}

test("decideArchive: queued, or skipped with the reason, or left as it is", () => {
  const base = { record: null, turns: 5, enabled: true, minTurns: 3, projectOff: false };
  assert.deepEqual(decideArchive(base), { state: "queued" });
  assert.deepEqual(decideArchive({ ...base, turns: 2 }), { state: "skipped", reason: "too short (2 turns)" });
  assert.deepEqual(decideArchive({ ...base, turns: 1 }), { state: "skipped", reason: "too short (1 turn)" });
  assert.deepEqual(decideArchive({ ...base, projectOff: true }), { state: "skipped", reason: "switched off for this project" });
  assert.deepEqual(decideArchive({ ...base, enabled: false }), { state: "skipped", reason: "switched off in the Reflections settings" });
  for (const state of ["queued", "running", "done"]) assert.equal(decideArchive({ ...base, record: { state } }), null);
  for (const state of ["cancelled", "failed", "skipped"]) assert.deepEqual(decideArchive({ ...base, record: { state } }), { state: "queued" });
});

test("archive writes a queued record with the title and project", async () => {
  const { home, done, env } = await fence();
  try {
    await put(home, `gateway-web/sessions/u1/${S}.json`, { title: "Header fix", archived: true });
    await put(home, "projects/sessions.json", { [S]: "p_0a1b2c3d" });
    await onArchive({ session: S, archived: true, archivedAt: "2026-10-19T12:00:00.000Z" }, env);
    const r = await get(home, `reflections/${S}.json`);
    assert.equal(r.state, "queued");
    assert.equal(r.title, "Header fix");
    assert.equal(r.project, "p_0a1b2c3d");
    assert.equal(r.archivedAt, "2026-10-19T12:00:00.000Z");
    assert.ok(r.queuedAt);
  } finally {
    await done();
  }
});

test("archive skips a short conversation and one in a switched-off project, saying why", async () => {
  const short = await fence({ turns: 2 });
  try {
    await onArchive({ session: S, archived: true }, short.env);
    const r = await get(short.home, `reflections/${S}.json`);
    assert.equal(r.state, "skipped");
    assert.equal(r.reason, "too short (2 turns)");
    assert.equal(r.title, "Fix the header colour", "with no name, the first message is the title");
  } finally {
    await short.done();
  }
  const off = await fence();
  try {
    await put(off.home, "projects/sessions.json", { [S]: "p_0a1b2c3d" });
    await put(off.home, "reflections/projects.json", { p_0a1b2c3d: false });
    await onArchive({ session: S, archived: true }, off.env);
    assert.equal((await get(off.home, `reflections/${S}.json`)).reason, "switched off for this project");
  } finally {
    await off.done();
  }
});

test("a subagent is never reflected alone", async () => {
  const { home, done, env } = await fence({ parent: "s_ffff0000" });
  try {
    await onArchive({ session: S, archived: true }, env);
    assert.equal(await get(home, `reflections/${S}.json`), null);
  } finally {
    await done();
  }
});

test("restore cancels a queued or running reflection and keeps a done one", async () => {
  const { home, done, env } = await fence();
  try {
    for (const state of ["queued", "running"]) {
      await put(home, `reflections/${S}.json`, { session: S, state });
      await onArchive({ session: S, archived: false, archivedAt: null }, env);
      const r = await get(home, `reflections/${S}.json`);
      assert.equal(r.state, "cancelled");
      assert.equal(r.reason, "restored before it ran");
    }
    await put(home, `reflections/${S}.json`, { session: S, state: "done", proposal: "L-aaaaaa", findings: [] });
    await onArchive({ session: S, archived: false }, env);
    assert.equal((await get(home, `reflections/${S}.json`)).state, "done");
    // Archived again, a cancelled one is queued again, from scratch.
    await put(home, `reflections/${S}.json`, { session: S, state: "cancelled", reason: "restored before it ran", error: "old" });
    await onArchive({ session: S, archived: true }, env);
    const again = await get(home, `reflections/${S}.json`);
    assert.equal(again.state, "queued");
    assert.equal(again.reason, undefined);
    assert.equal(again.error, undefined);
  } finally {
    await done();
  }
});

const entry = (id, sessions, extra = {}) => ({ id, kind: "guide-note", target: "-", cue: "c", lesson: "l", change: "n", from: sessions.map((session) => ({ session, title: "t", at: "x", rows: [1] })), state: "proposed", trials: [], applied: null, ...extra });
const finding = (id, sessions) => ({ id, package: "@thetis/tools-files", component: "read_file", what: "w", state: "open", seen: sessions.map((session) => ({ session, at: "x", version: "0.4.0", events: [], rows: [] })) });

test("forget: the preview lists the reflection, the proposals only from it, and its sightings", async () => {
  const { home, done, env } = await fence();
  try {
    assert.deepEqual(await forgetSession({ phase: "preview", session: S, sessions: [S], options: {} }, env), { items: [] }, "nothing held, nothing listed");
    await put(home, `reflections/${S}.json`, { session: S, state: "done" });
    await put(home, `reflections/${S}.md`, "# Reflection");
    await put(home, `reflections/${S}/context/trajectory.md`, "[1] [USER] hi");
    const O = "s_bbbb2222";
    await writeLibrary(home, { entries: [
      entry("L-000001", [S], { trials: ["t_00000001"], state: "trialled" }),
      entry("L-000002", [S, "s_cccc3333"]),
      entry("L-000003", [S, O]),
      entry("L-000004", [S], { state: "adopted", applied: { before: "[]", after: '["n"]', at: "x" } }),
      entry("L-000005", [O]),
    ] });
    await put(home, "reflections/trials/t_00000001/judge.md", "# Judgement");
    await put(home, "trials/t_00000001/trial.json", { id: "t_00000001" });
    await put(home, "reflections/findings.json", { findings: [finding("F-000001", [S]), finding("F-000002", [S, O]), finding("F-000003", [O])] });

    const preview = await forgetSession({ phase: "preview", session: S, sessions: [S, "s_cccc3333"], options: {} }, env);
    assert.deepEqual(preview.items, [
      { id: "reflection", label: "Its reflection and the evidence exported for it", optional: false },
      { id: "proposals", label: "2 proposals came only from this conversation", optional: true, default: true },
      { id: "findings", label: "Its sightings in 2 findings", optional: false },
    ]);

    const out = await forgetSession({ phase: "forget", session: S, sessions: [S], options: { proposals: true } }, env);
    assert.deepEqual(out, { removed: ["its reflection", "1 proposal it led to", "its sightings in 2 findings"], kept: ["1 adopted change it led to stays; retire it in Reflections"] });
    assert.equal(await get(home, `reflections/${S}.json`), null);
    assert.equal(await get(home, `reflections/${S}.md`), null);
    assert.equal(await get(home, `reflections/${S}/context/trajectory.md`), null);
    const lib = await readLibrary(home);
    assert.deepEqual(lib.entries.map((e) => e.id), ["L-000002", "L-000003", "L-000004", "L-000005"]);
    assert.deepEqual(lib.entries.find((e) => e.id === "L-000003").from.map((f) => f.session), [O], "a shared entry loses only this conversation");
    assert.deepEqual(lib.entries.find((e) => e.id === "L-000002").from.map((f) => f.session), ["s_cccc3333"]);
    assert.equal(await get(home, "reflections/trials/t_00000001/judge.md"), null, "the trial files go with the entry");
    assert.equal(await get(home, "trials/t_00000001/trial.json"), null);
    assert.deepEqual(env.kernel.operator.calls.filter((c) => c.method === "host.trials.forget").map((c) => c.args), [{ user: "u1", trial: "t_00000001" }], "the host is asked to drop its copy, for the person");
    const f = (await readFindings(home)).findings;
    assert.deepEqual(f.map((x) => [x.id, x.seen.map((s) => s.session)]), [["F-000002", [O]], ["F-000003", [O]]], "a finding left with no sightings goes");

    assert.deepEqual(await forgetSession({ phase: "forget", session: S, sessions: [S], options: { proposals: true } }, env), { removed: [], kept: ["1 adopted change it led to stays; retire it in Reflections"] }, "idempotent but for the adopted change, which stays");
  } finally {
    await done();
  }
});

test("forget goes on, and logs, when the trials host cannot forget", async () => {
  const { home, done, env } = await fence();
  try {
    const logs = [];
    env.log = (l) => logs.push(l);
    env.kernel.operator.call = async (method) => {
      throw new Error(`unknown method ${method}`);
    };
    await writeLibrary(home, { entries: [entry("L-000001", [S], { trials: ["t_00000001"] })] });
    await put(home, "trials/t_00000001/trial.json", { id: "t_00000001" });
    const out = await forgetSession({ phase: "forget", session: S, sessions: [S], options: { proposals: true } }, env);
    assert.deepEqual(out.removed, ["1 proposal it led to"]);
    assert.equal(await get(home, "trials/t_00000001/trial.json"), null);
    assert.deepEqual(logs, ["reflections: the trials host could not forget t_00000001: unknown method host.trials.forget"]);
  } finally {
    await done();
  }
});

test("forget with the proposals box unticked keeps them, and says so", async () => {
  const { home, done, env } = await fence();
  try {
    await writeLibrary(home, { entries: [entry("L-000001", [S])] });
    const out = await forgetSession({ phase: "forget", session: S, sessions: [S], options: { proposals: false } }, env);
    assert.deepEqual(out, { removed: [], kept: ["1 proposal it led to stays in Reflections"] });
    assert.equal((await readLibrary(home)).entries.length, 1);
  } finally {
    await done();
  }
});
