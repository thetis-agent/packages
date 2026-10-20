// The session hooks: what an archive writes and why, what a restore cancels, and the two phases of a
// forget, with and without the lessons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideArchive, forgetSession, onArchive } from "../lib/hooks.js";
import { writeLesson } from "../lib/lessons.js";
import { guard, parseAnswer } from "../lib/prompt.js";
import { GOOD_ANSWER, fakeKernel, get, put, sampleSession, tempHome } from "./helpers.js";

const S = "s_aaaa1111";

async function fence({ turns = 3, config = {}, parent } = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(S, { turns, ...(parent ? { parent } : {}) })] });
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
    await put(home, `reflections/${S}.json`, { session: S, state: "done", lesson: "lessons/general/x" });
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

test("forget: the preview lists the reflection and the lessons, the forget removes them", async () => {
  const { home, done, env } = await fence();
  try {
    assert.deepEqual(await forgetSession({ phase: "preview", session: S, sessions: [S], options: {} }, env), { items: [] }, "nothing held, nothing listed");
    await put(home, `reflections/${S}.json`, { session: S, state: "done" });
    await put(home, `reflections/${S}.md`, "# Reflection");
    await put(home, `reflections/${S}/context/trajectory.md`, "[1] [USER] hi");
    const parsed = parseAnswer(GOOD_ANSWER);
    const { lesson } = guard(parsed, new Set([4, 5, 8, 9]));
    const id = await writeLesson(home, { lesson, rows: parsed.rows, conversation: { id: S, title: "t", project: null } });
    const other = await writeLesson(home, { lesson, rows: parsed.rows, conversation: { id: "s_bbbb2222", title: "u", project: null } });

    const preview = await forgetSession({ phase: "preview", session: S, sessions: [S, "s_cccc3333"], options: {} }, env);
    assert.deepEqual(preview.items, [
      { id: "reflection", label: "Its reflection and the evidence exported for it", optional: false },
      { id: "lessons", label: "1 lesson came from this conversation", optional: true, default: true },
    ]);

    const kept = await forgetSession({ phase: "forget", session: S, sessions: [S], options: { lessons: false } }, env);
    assert.deepEqual(kept, { removed: ["its reflection"], kept: ["1 lesson it taught stays in your skills"] });
    assert.equal(await get(home, `reflections/${S}.json`), null);
    assert.equal(await get(home, `reflections/${S}.md`), null);
    assert.equal(await get(home, `reflections/${S}/context/trajectory.md`), null);
    assert.ok(await get(home, `skills/${id}/SKILL.md`), "the lesson stays when the box was unticked");

    const gone = await forgetSession({ phase: "forget", session: S, sessions: [S], options: { lessons: true } }, env);
    assert.deepEqual(gone, { removed: ["1 lesson it taught"], kept: [] });
    assert.equal(await get(home, `skills/${id}/SKILL.md`), null);
    assert.ok(await get(home, `skills/${other}/SKILL.md`), "another conversation's lesson stays");
    assert.deepEqual(Object.keys(await get(home, "reflections/lessons.json")), [other]);

    assert.deepEqual(await forgetSession({ phase: "forget", session: S, sessions: [S], options: { lessons: true } }, env), { removed: [], kept: [] }, "idempotent");
  } finally {
    await done();
  }
});
