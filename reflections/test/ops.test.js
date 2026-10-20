// The UI command: the list with archived conversations that have no record, Reflect and Cancel, Forget
// lesson, and the settings written at the person's layer. Also the chip's words, which are pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uiCall } from "../index.js";
import { writeLesson } from "../lib/lessons.js";
import { guard, parseAnswer } from "../lib/prompt.js";
import { chipVisible, describe, explain, shortReason } from "../ui/state.js";
import { GOOD_ANSWER, fakeKernel, get, put, sampleSession, tempHome } from "./helpers.js";

const A = "s_aaaa1111";
const B = "s_bbbb2222";
const C = "s_cccc3333";

async function setup(config = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(A), sampleSession(B), sampleSession(C), { summary: { id: "s_dddd4444", parent: A }, record: {} }], config });
  const env = { cwd: home, kernel, user: "u1", role: "user", config };
  const call = async (op, args = {}) => (await uiCall({ op, ...args }, env)).data;
  return { home, kernel, env, call, done };
}

test("an unknown op is refused with the list of ops", async () => {
  const t = await setup();
  try {
    await assert.rejects(() => uiCall({ op: "nope" }, t.env), /There is no op named "nope"; the ops are list, get, reflect, cancel, forget-lesson, settings, set-setting, project-switch\./);
    await assert.rejects(() => uiCall({}, t.env), /op is required/);
  } finally {
    await t.done();
  }
});

test("list: records, and archived conversations without one as Not reflected", async () => {
  const t = await setup();
  try {
    await put(t.home, "reflections/installed.json", { at: "2026-10-19T00:00:00.000Z" });
    await put(t.home, `gateway-web/sessions/u1/${A}.json`, { archived: true, title: "Done one" });
    await put(t.home, `gateway-web/sessions/u1/${B}.json`, { archived: true, archivedAt: "2026-10-01T00:00:00.000Z" });
    await put(t.home, `gateway-web/sessions/u1/${C}.json`, { archived: true, archivedAt: "2026-10-19T09:00:00.000Z" });
    await put(t.home, `reflections/${A}.json`, { session: A, title: "old", state: "done", costUsd: 0.04, finishedAt: "2026-10-19T10:00:00.000Z" });
    const out = await t.call("list");
    const by = Object.fromEntries(out.items.map((i) => [i.session, i]));
    assert.equal(by[A].state, "done");
    assert.equal(by[A].title, "Done one", "the gateway's name wins over the one recorded");
    assert.equal(by[B].state, "none");
    assert.equal(by[B].reason, "archived before Reflections was installed");
    assert.equal(by[C].reason, "not reflected");
    assert.equal(by["s_dddd4444"], undefined, "subagents are not listed");
    assert.equal(out.cap, 5);
    assert.deepEqual(out.spend.usd, 0);
  } finally {
    await t.done();
  }
});

test("reflect queues a person's request; cancel cancels it; a second reflect is refused while queued", async () => {
  const t = await setup();
  try {
    const r = await t.call("reflect", { session: A });
    assert.equal(r.state, "queued");
    assert.equal(r.manual, true);
    await assert.rejects(() => t.call("reflect", { session: A }), /already queued/);
    const c = await t.call("cancel", { session: A });
    assert.equal(c.state, "cancelled");
    assert.equal(c.reason, "cancelled by you");
    await assert.rejects(() => t.call("cancel", { session: A }), /Nothing is queued or running/);
    await assert.rejects(() => t.call("reflect", { session: "s_dddd4444" }), /subagent/);
    await assert.rejects(() => t.call("reflect", { session: "s_eeee5555" }), /gone/);
    await assert.rejects(() => t.call("reflect", { session: "../x" }), /not a conversation id/);
  } finally {
    await t.done();
  }
});

test("get answers the record, the reflection, its lessons and where the evidence is", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call("get", { session: A })).record.state, "none");
    const parsed = parseAnswer(GOOD_ANSWER);
    const { lesson } = guard(parsed, new Set([4, 5, 8, 9]));
    const id = await writeLesson(t.home, { lesson, rows: parsed.rows, conversation: { id: A, title: "t", project: null } });
    await put(t.home, `reflections/${A}.json`, { session: A, title: "t", state: "done", lesson: id });
    await put(t.home, `reflections/${A}.md`, "# Reflection");
    await put(t.home, `reflections/${A}/context/trajectory.md`, "x");
    const got = await t.call("get", { session: A });
    assert.equal(got.reflection, "# Reflection");
    assert.equal(got.evidence, `~/reflections/${A}/context/trajectory.md`);
    assert.equal(got.lessons.length, 1);
    assert.equal(got.lessons[0].scopeName, "No project");

    await t.call("forget-lesson", { id });
    assert.equal(await get(t.home, `skills/${id}/SKILL.md`), null);
    assert.equal((await get(t.home, `reflections/${A}.json`)).lesson, null);
    await assert.rejects(() => t.call("forget-lesson", { id }), /no lesson/);
    await assert.rejects(() => t.call("forget-lesson", { id: "../../etc" }), /id is required/);
  } finally {
    await t.done();
  }
});

test("settings: the model list, and changes at the person's layer", async () => {
  const t = await setup();
  try {
    await put(t.home, "projects/p_0a1b2c3d.json", { id: "p_0a1b2c3d", name: "Nova" });
    const s = await t.call("settings");
    assert.equal(s.model, "");
    assert.equal(s.serverDefault, "fable");
    assert.deepEqual(s.models.map((m) => m.id), ["fable", "opus"]);
    assert.deepEqual(s.projects, [{ id: "p_0a1b2c3d", name: "Nova", enabled: true }]);

    const after = await t.call("set-setting", { key: "model", value: "opus" });
    assert.deepEqual(t.kernel.sets.at(-1), { name: "@thetis/reflections", key: "model", value: "opus" });
    assert.equal(after.model, "opus", "the answer reads the setting again");
    await t.call("set-setting", { key: "model", value: null });
    assert.deepEqual(t.kernel.sets.at(-1), { name: "@thetis/reflections", key: "model", value: undefined });
    await assert.rejects(() => t.call("set-setting", { key: "inputChars", value: 1 }), /key must be one of/);
    await assert.rejects(() => t.call("set-setting", { key: "dailyCostUsd", value: -1 }), /0 or more/);

    const off = await t.call("project-switch", { project: "p_0a1b2c3d", enabled: false });
    assert.equal(off.projects[0].enabled, false);
    assert.deepEqual(await get(t.home, "reflections/projects.json"), { p_0a1b2c3d: false });
    await t.call("project-switch", { project: "p_0a1b2c3d", enabled: true });
    assert.deepEqual(await get(t.home, "reflections/projects.json"), {});
  } finally {
    await t.done();
  }
});

test("the chip's words follow the state", () => {
  assert.equal(describe({ state: "done", costUsd: 0.04 }, { lessons: 1 }).label, "Reflected · 1 lesson · $0.04");
  assert.equal(describe({ state: "done" }, { lessons: 0 }).label, "Reflected · no lesson");
  assert.equal(describe({ state: "queued" }).label, "Queued");
  assert.equal(describe({ state: "running" }).label, "Reflecting…");
  assert.equal(describe({ state: "skipped", reason: "too short (2 turns)" }).label, "Skipped: too short");
  assert.equal(describe({ state: "failed" }).label, "Failed · Retry");
  assert.equal(describe({ state: "none" }).label, "Not reflected · Reflect");
  assert.equal(describe(null).action, "reflect");
  assert.equal(shortReason("daily cost cap reached"), "daily cap reached");
  assert.equal(chipVisible({ state: "none" }, true), true);
  assert.equal(chipVisible({ state: "none" }, false), false);
  assert.equal(chipVisible({ state: "cancelled" }, false), false, "a restore's cancel is no news");
  assert.equal(chipVisible({ state: "done" }, false), true);
  assert.match(explain({ state: "none", reason: "archived before Reflections was installed" }), /before Reflections was installed/);
});
