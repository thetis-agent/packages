// The service against a fake kernel: a queued record becomes a reflection and a lesson, one at a time,
// oldest first; the daily cap skips an automatic one and lets a person's through; a running record left
// by a stop is queued again on start; a cancel while it runs drops everything it would have written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createService } from "../lib/service.js";
import { today } from "../lib/records.js";
import { GOOD_ANSWER, fakeKernel, get, put, sampleSession, tempHome, until, wait } from "./helpers.js";

const A = "s_aaaa1111";
const B = "s_bbbb2222";

async function setup({ sessions = [sampleSession(A), sampleSession(B)], script, config = {} } = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions, script, config });
  const logs = [];
  const service = createService({ cwd: home, kernel, config, log: (l) => logs.push(l) }, { sweepMs: 60_000 });
  return { home, kernel, service, logs, done: async () => { await service.stop(); await done(); } };
}

const queued = (session, extra = {}) => ({ session, title: `T ${session}`, project: null, state: "queued", queuedAt: new Date().toISOString(), ...extra });

test("a queued record becomes a reflection, a lesson and a cost", async () => {
  const t = await setup();
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.model, "fable", "unset means the server's default model");
    assert.equal(r.costUsd, 0.04);
    assert.equal(r.events, 10);
    assert.equal(r.rows, 2);
    assert.equal(r.lesson, "lessons/general/editing-generated-file-find-generator-change");
    assert.ok(r.startedAt && r.finishedAt);
    assert.ok(await get(t.home, `skills/${r.lesson}/SKILL.md`));
    assert.match(await get(t.home, `reflections/${A}.md`), /## What was tried\n\n1\. \*\*hurt\*\* · Edited the generated file/);
    for (const f of ["MISSION.md", "task.md", "trajectory.md"]) assert.ok(await get(t.home, `reflections/${A}/context/${f}`), f);
    const req = t.kernel.calls[0];
    assert.deepEqual(req.tools, []);
    assert.equal(req.params.max_tokens, 8000);
    assert.equal(req.system, await get(t.home, `reflections/${A}/context/MISSION.md`));
    assert.match(req.messages[0].content[0].data.text, /\[9\] \[USER\] That worked, thanks/);
    assert.deepEqual(await get(t.home, "reflections/spend.json"), { day: today(), usd: 0.04, unknown: 0 });
  } finally {
    await t.done();
  }
});

test("the configured model is read when the reflection starts", async () => {
  const t = await setup({ config: { model: "opus", maxTokens: 12000 } });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.model, "opus");
    assert.equal(t.kernel.calls[0].model, "opus");
    assert.equal(t.kernel.calls[0].params.max_tokens, 12000);
  } finally {
    await t.done();
  }
});

test("NO_ENTRY keeps the rows and says there is no lesson", async () => {
  const t = await setup({ script: () => [{ type: "text", delta: "<rows>\nrow: 1\napproach: a\nobserved: b [2]\nverdict: confounded\n</rows>\nNO_ENTRY" }] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.reason, "no lesson: the record showed no contrast that transfers (NO_ENTRY)");
    assert.equal(r.lesson, undefined);
    assert.equal(r.costUsd, undefined, "a provider that reports no cost leaves it unknown");
    assert.equal((await get(t.home, "reflections/spend.json")).unknown, 1);
    assert.equal(await get(t.home, "reflections/lessons.json"), null);
  } finally {
    await t.done();
  }
});

test("a provider error, or an answer with none of the blocks, is a failure that says so", async () => {
  const t = await setup({ script: (_r, n) => (n === 1 ? [{ type: "error", message: "overloaded" }] : [{ type: "text", delta: "It went fine." }]) });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A, { queuedAt: "2026-10-19T10:00:00.000Z" }));
    await put(t.home, `reflections/${B}.json`, queued(B, { queuedAt: "2026-10-19T10:00:01.000Z" }));
    await t.service.start();
    const a = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "failed" && x; });
    assert.equal(a.error, "overloaded");
    const b = await until(async () => { const x = await get(t.home, `reflections/${B}.json`); return x?.state === "failed" && x; });
    assert.match(b.error, /none of the blocks/);
    assert.match(await get(t.home, `reflections/${B}.md`), /## The model's answer, as it came\n\n```\nIt went fine\.\n```/);
  } finally {
    await t.done();
  }
});

test("one at a time, oldest first", async () => {
  let inFlight = 0;
  let most = 0;
  const order = [];
  const t = await setup({
    script: async (req) => {
      inFlight++;
      most = Math.max(most, inFlight);
      order.push(/s_[a-f0-9]+/.exec(req.messages[0].content[0].data.text)[0]);
      await wait(30);
      inFlight--;
      return [{ type: "text", delta: GOOD_ANSWER }];
    },
  });
  try {
    await put(t.home, `reflections/${B}.json`, queued(B, { queuedAt: "2026-10-19T10:00:00.000Z" }));
    await put(t.home, `reflections/${A}.json`, queued(A, { queuedAt: "2026-10-19T10:00:05.000Z" }));
    await t.service.start();
    await until(async () => (await get(t.home, `reflections/${A}.json`))?.state === "done");
    assert.equal(most, 1);
    assert.deepEqual(order, [B, A]);
    const index = await get(t.home, "reflections/lessons.json");
    assert.deepEqual(Object.keys(index).sort(), ["lessons/general/editing-generated-file-find-generator-change", "lessons/general/editing-generated-file-find-generator-change-2"]);
  } finally {
    await t.done();
  }
});

test("the daily cap skips an automatic reflection and lets a person's through", async () => {
  const t = await setup({ config: { dailyCostUsd: 1 } });
  try {
    await put(t.home, "reflections/spend.json", { day: today(), usd: 1.2, unknown: 0 });
    await put(t.home, `reflections/${A}.json`, queued(A));
    await put(t.home, `reflections/${B}.json`, queued(B, { manual: true }));
    await t.service.start();
    const a = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "skipped" && x; });
    assert.equal(a.reason, "daily cost cap reached");
    assert.match(a.detail, /^\$1\.20 spent today of the \$1\.00 cap/);
    const b = await until(async () => { const x = await get(t.home, `reflections/${B}.json`); return x?.state === "done" && x; });
    assert.equal(b.costUsd, 0.04);
    assert.equal(t.kernel.calls.length, 1);
    assert.equal((await get(t.home, "reflections/spend.json")).usd, 1.24);
  } finally {
    await t.done();
  }
});

test("yesterday's spend does not count today", async () => {
  const t = await setup({ config: { dailyCostUsd: 1 } });
  try {
    await put(t.home, "reflections/spend.json", { day: "2000-01-01", usd: 99, unknown: 0 });
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    await until(async () => (await get(t.home, `reflections/${A}.json`))?.state === "done");
  } finally {
    await t.done();
  }
});

test("a record left running by a stopped service is queued again on start, and runs", async () => {
  const t = await setup();
  try {
    await put(t.home, `reflections/${A}.json`, { ...queued(A), state: "running", startedAt: "2026-10-19T09:00:00.000Z" });
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.note, "queued again: the service stopped while it ran");
    assert.ok(t.logs.some((l) => l.includes("was running when the service stopped")));
  } finally {
    await t.done();
  }
});

test("a stop leaves the running record running, for the next start", async () => {
  const t = await setup({ script: () => [{ hang: true }] });
  await put(t.home, `reflections/${A}.json`, queued(A));
  await t.service.start();
  await until(async () => (await get(t.home, `reflections/${A}.json`))?.state === "running");
  await t.service.stop();
  assert.equal((await get(t.home, `reflections/${A}.json`)).state, "running");
  await t.done();
});

test("a cancel while it runs stops the call, and nothing it would write is written", async () => {
  const t = await setup({ script: () => [{ hang: true }] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const running = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "running" && x.model && x; });
    await until(async () => t.kernel.calls.length === 1);
    await put(t.home, `reflections/${A}.json`, { ...running, state: "cancelled", reason: "restored before it ran" });
    await t.service.sweep();
    await t.service.idle();
    const r = await get(t.home, `reflections/${A}.json`);
    assert.equal(r.state, "cancelled");
    assert.equal(await get(t.home, `reflections/${A}.md`), null);
    assert.equal(await get(t.home, "reflections/lessons.json"), null);
  } finally {
    await t.done();
  }
});

test("a conversation that is gone fails with that sentence", async () => {
  const t = await setup({ sessions: [] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "failed" && x; });
    assert.equal(r.error, "the conversation is gone");
    assert.equal(t.kernel.calls.length, 0);
  } finally {
    await t.done();
  }
});

test("a forget while it runs stops the call and leaves none of the evidence behind", async () => {
  const t = await setup({ script: () => [{ hang: true }] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    await until(async () => (await get(t.home, `reflections/${A}/context/trajectory.md`)) && t.kernel.calls.length === 1);
    const { forgetSession } = await import("../lib/hooks.js");
    await forgetSession({ phase: "forget", session: A, sessions: [A], options: { lessons: true } }, { cwd: t.home, kernel: t.kernel, config: {}, session: { id: A, user: "u1" } });
    await t.service.sweep();
    await t.service.idle();
    assert.equal(await get(t.home, `reflections/${A}.json`), null);
    assert.equal(await get(t.home, `reflections/${A}/context/trajectory.md`), null);
    assert.equal(await get(t.home, `reflections/${A}.md`), null);
  } finally {
    await t.done();
  }
});

const LONG = "Before editing any file in a project with a build step, first find out whether a generator produces it, and if one does, change that generator's source and rebuild instead of editing";
const longAnswer = GOOD_ANSWER.replace(/^lesson: .*$/m, `lesson: ${LONG}`);

test("a lesson too long is sent back once to be said shorter, and both costs count", async () => {
  const t = await setup({
    script: (req, n) =>
      n === 1
        ? [{ type: "text", delta: longAnswer }, { type: "usage", usage: { cost: 0.04 } }]
        : [{ type: "text", delta: "\"Before editing a generated file, change its generator's source and rebuild\"" }, { type: "usage", usage: { cost: 0.001 } }],
  });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(t.kernel.calls.length, 2);
    assert.match(t.kernel.calls[1].messages[0].content[0].data.text, /^Lesson: Before editing any file/);
    assert.equal(t.kernel.calls[1].tools.length, 0);
    assert.ok(r.lesson, "the shortened lesson is written");
    assert.equal(Math.round(r.costUsd * 1000), 41);
    const skill = await get(t.home, `skills/${r.lesson}/SKILL.md`);
    assert.match(skill, /Before editing a generated file, change its generator's source and rebuild\. Use when/);
    assert.match(await get(t.home, `reflections/${A}.md`), /a second, short request said it in fewer words/);
  } finally {
    await t.done();
  }
});

test("a lesson still too long after the second request is refused, and its text stays readable", async () => {
  const t = await setup({ script: (req, n) => [{ type: "text", delta: n === 1 ? longAnswer : LONG }, { type: "usage", usage: { cost: 0.01 } }] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.lesson, undefined);
    assert.match(r.reason, /^no lesson: the lesson is \d+ characters/);
    const md = await get(t.home, `reflections/${A}.md`);
    assert.match(md, /The refused lesson, as the model wrote it:/);
    assert.ok(md.includes(`> ${LONG}`));
  } finally {
    await t.done();
  }
});
