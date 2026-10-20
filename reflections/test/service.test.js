// The service against a fake kernel: a queued record becomes a reflection, findings and a proposal, one at
// a time, oldest first; the daily cap skips an automatic one and lets a person's through; a running record
// left by a stop is queued again on start; a cancel while it runs drops everything it would have written.
// The same sweep follows trials, marks findings possibly fixed and adopted entries for a re-check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createService } from "../lib/service.js";
import { today } from "../lib/records.js";
import { readLibrary, writeLibrary } from "../lib/library.js";
import { GOOD_ANSWER, SKILL, fakeKernel, fakePackages, finishTrial, get, put, sampleSession, tempHome, until, wait } from "./helpers.js";

const A = "s_aaaa1111";
const B = "s_bbbb2222";

async function setup({ sessions = [sampleSession(A), sampleSession(B)], script, config = {}, packages } = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions, script, config, home, ...(packages ? { packages } : {}) });
  const logs = [];
  const service = createService({ cwd: home, kernel, config, log: (l) => logs.push(l) }, { sweepMs: 60_000 });
  return { home, kernel, service, logs, done: async () => { await service.stop(); await done(); } };
}

const queued = (session, extra = {}) => ({ session, title: `T ${session}`, project: null, state: "queued", queuedAt: new Date().toISOString(), ...extra });

test("a queued record becomes a reflection, a finding, a proposal and a cost", async () => {
  const t = await setup();
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.model, "fable", "unset means the server's default model");
    assert.equal(r.costUsd, 0.04);
    assert.equal(r.events, 10);
    assert.equal(r.rows, 2);
    assert.match(r.proposal, /^L-[0-9a-f]{6}$/);
    assert.equal(r.findings.length, 1);
    assert.equal(r.lesson, undefined, "there are no lessons in v2");
    assert.equal(r.reason, undefined);
    assert.ok(r.startedAt && r.finishedAt);
    const lib = await get(t.home, "reflections/library.json");
    assert.deepEqual(lib.entries.map((e) => [e.id, e.state, e.kind, e.target]), [[r.proposal, "proposed", "skill", "generated-files"]]);
    assert.equal(await get(t.home, "skills/generated-files/SKILL.md"), null, "nothing reaches a conversation before it is adopted");
    const findings = await get(t.home, "reflections/findings.json");
    assert.deepEqual(findings.findings.map((f) => [f.id, f.package, f.component, f.seen[0].version]), [[r.findings[0], "@thetis/tools-files", "edit_path", "0.4.0"]]);
    const md = await get(t.home, `reflections/${A}.md`);
    assert.match(md, /## What was tried\n\n1\. \*\*hurt\*\* · Edited the generated file dist\/app\.js directly\. \(judgement\)/);
    assert.match(md, /## Findings\n\n- F-[0-9a-f]{6} · \*\*@thetis\/tools-files edit_path\*\* \(0\.4\.0\)/);
    assert.match(md, new RegExp(`## Proposal\\n\\n${r.proposal} · skill generated-files`));
    assert.match(md, /This conversation ran before turns were recorded/);
    for (const f of ["MISSION.md", "task.md", "trajectory.md", "harness/NONE.md", "library/INDEX.md"]) assert.ok(await get(t.home, `reflections/${A}/context/${f}`), f);
    const req = t.kernel.calls[0];
    assert.deepEqual(req.tools, []);
    assert.equal(req.params.max_tokens, 16000);
    assert.equal(req.system, await get(t.home, `reflections/${A}/context/MISSION.md`));
    const evidence = req.messages[0].content[0].data.text;
    assert.match(evidence, /\[9\] \[USER\] That worked, thanks/);
    assert.match(evidence, /<file path="context\/harness\/NONE\.md">/);
    assert.match(evidence, /<file path="context\/library\/INDEX\.md">/);
    assert.deepEqual(await get(t.home, "reflections/spend.json"), { day: today(), usd: 0.04, unknown: 0 });
  } finally {
    await t.done();
  }
});

test("a stamped conversation: harness/turns.md, the system text, and the finding at the version it ran with", async () => {
  const t = await setup();
  try {
    const stamp = { turn: 1, at: "2026-10-19T10:00:00.000Z", model: "anthropic/x", versions: { "@thetis/tools-files": "0.3.7", "@thetis/harness-core": "0.8.0" }, system: "aaaa1111aaaa1111", tools: "bbbb2222bbbb2222", skills: null, groups: null, project: null };
    await put(t.home, `harness-core/turns/${A}.jsonl`, `${JSON.stringify(stamp)}\n`);
    await put(t.home, `harness-core/snapshots/${A}/aaaa1111aaaa1111.md`, "THE GUIDE TEXT");
    await put(t.home, `harness-core/snapshots/${A}/bbbb2222bbbb2222.json`, [{ name: "edit_path", package: "@thetis/tools-files", description: "Edits a file.", parameters: {} }]);
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.match(await get(t.home, `reflections/${A}/context/harness/turns.md`), /model: anthropic\/x/);
    assert.match(t.kernel.calls[0].messages[0].content[0].data.text, /<file path="context\/harness\/system-1\.md">[\s\S]*THE GUIDE TEXT/);
    assert.equal(await get(t.home, `reflections/${A}/context/harness/NONE.md`), null);
    assert.equal((await get(t.home, "reflections/findings.json")).findings[0].seen[0].version, "0.3.7", "the stamped version, not the model's");
    assert.doesNotMatch(await get(t.home, `reflections/${A}.md`), /ran before turns were recorded/);
    void r;
  } finally {
    await t.done();
  }
});

test("reflecting again replaces the untouched proposal it made before", async () => {
  const t = await setup();
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const first = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    await put(t.home, `reflections/${A}.json`, queued(A, { manual: true }));
    await t.service.sweep();
    const second = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x.proposal !== first.proposal && x; });
    const lib = await get(t.home, "reflections/library.json");
    assert.deepEqual(lib.entries.map((e) => e.id), [second.proposal]);
    assert.equal((await get(t.home, "reflections/findings.json")).findings.length, 1, "the finding is not counted twice");
  } finally {
    await t.done();
  }
});

test("a refused proposal: the reason, and the block as it came", async () => {
  const t = await setup({ script: () => [{ type: "text", delta: GOOD_ANSWER.replace("kind: skill", "kind: recipe") }] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.proposal, null);
    assert.equal(r.reason, 'no proposal: the kind "recipe" is not one of skill, project-instructions, guide-note, config');
    assert.equal(r.findings.length, 1, "findings are kept on their own");
    const md = await get(t.home, `reflections/${A}.md`);
    assert.match(md, /No proposal: the kind "recipe"/);
    assert.match(md, /The refused proposal, as the model wrote it:\n\n```\nkind: recipe/);
    assert.equal(await get(t.home, "reflections/library.json"), null);
  } finally {
    await t.done();
  }
});

test("an edit of a shipped skill shows as a diff against what is there", async () => {
  const pack = await tempHome();
  const SHIPPED = SKILL.replace("Find the generator first", "Old advice");
  await put(pack.home, "skills/generated-files/SKILL.md", SHIPPED);
  const t = await setup({ packages: fakePackages([{ name: "@thetis/skills-thetis", version: "0.10.0", type: "skill-pack", description: "", root: pack.home, thetis: { skills: "skills" } }]) });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    await until(async () => (await get(t.home, `reflections/${A}.json`))?.state === "done");
    const md = await get(t.home, `reflections/${A}.md`);
    assert.match(md, /```diff\n[\s\S]*- Old advice: search[\s\S]*\+ Find the generator first: search/);
    assert.equal((await get(t.home, "reflections/library.json")).entries[0].owner, "@thetis/skills-thetis");
  } finally {
    await t.done();
    await pack.done();
  }
});

test("the sweep follows a trial to its verdict, marks findings possibly fixed, and adopted entries for a re-check", async () => {
  const judge = (request) => {
    const ids = [...request.messages[0].content[0].data.text.matchAll(/context\/runs\/([A-Z])\.md/g)].map((m) => m[1]);
    return [{ type: "text", delta: `<runs>\n${ids.map((id) => `run: ${id}\nsituation: yes\ngrade: 3\nreason: r`).join("\n")}\n</runs>` }];
  };
  const t = await setup({ script: judge, packages: fakePackages().map((p) => (p.name === "@thetis/tools-files" ? { ...p, version: "0.5.0" } : p)) });
  try {
    const now = new Date().toISOString();
    const base = { kind: "guide-note", target: "-", cue: "c", lesson: "l", change: "n", before: "[]", evidence: "rows 1", confidence: "low", trialRequest: "Do it.", from: [{ session: A, title: "t", at: now, rows: [1] }], verdict: null, recheck: null, createdAt: now, updatedAt: now };
    await t.kernel.operator.call("host.trials.start", { session: A, request: { text: "Do it." }, model: "m", arms: [] });
    await finishTrial(t.home, "t_00000001", { runs: 1 });
    await writeLibrary(t.home, { entries: [
      { ...base, id: "L-000001", state: "trialling", previousState: "proposed", trials: ["t_00000001"], versions: {}, owner: "@thetis/harness-core", applied: null },
      { ...base, id: "L-000002", state: "adopted", trials: [], versions: { "@thetis/harness-core": "0.7.0" }, owner: "@thetis/harness-core", applied: { before: "[]", after: '["n"]', at: now } },
    ] });
    await put(t.home, "reflections/findings.json", { findings: [{ id: "F-000001", package: "@thetis/tools-files", component: "x", what: "w", state: "open", since: null, closedAt: null, seen: [{ session: A, at: now, version: "0.4.0", events: [], rows: [] }] }] });
    await t.service.start();
    // The verdict and the re-check land in separate writes of the same sweep: wait for both.
    const lib = await until(async () => {
      const l = await readLibrary(t.home);
      return l.entries.find((e) => e.id === "L-000001")?.state === "trialled" && l.entries.find((e) => e.id === "L-000002")?.recheck && l;
    });
    assert.equal(lib.entries[0].verdict.result, "no difference");
    assert.equal(lib.entries[1].recheck.reason, "@thetis/harness-core changed 0.7.0 → 0.8.0 since adoption");
    await until(async () => (await get(t.home, "reflections/findings.json")).findings[0].state === "possibly-fixed");
    assert.equal((await get(t.home, "reflections/findings.json")).findings[0].since, "0.5.0");
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

test("NO_PROPOSAL keeps the rows and says there is no proposal", async () => {
  const t = await setup({ script: () => [{ type: "text", delta: "<rows>\nrow: 1\napproach: a\nobserved: b [2]\nverdict: confounded\n</rows>\nNO_PROPOSAL" }] });
  try {
    await put(t.home, `reflections/${A}.json`, queued(A));
    await t.service.start();
    const r = await until(async () => { const x = await get(t.home, `reflections/${A}.json`); return x?.state === "done" && x; });
    assert.equal(r.reason, "no proposal: the record showed no contrast a change would act on (NO_PROPOSAL)");
    assert.equal(r.proposal, null);
    assert.deepEqual(r.findings, []);
    assert.equal(r.costUsd, undefined, "a provider that reports no cost leaves it unknown");
    assert.equal((await get(t.home, "reflections/spend.json")).unknown, 1);
    assert.equal(await get(t.home, "reflections/library.json"), null);
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
    assert.equal((await get(t.home, "reflections/library.json")).entries.length, 2);
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
    assert.equal(await get(t.home, "reflections/library.json"), null);
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
    await forgetSession({ phase: "forget", session: A, sessions: [A], options: { proposals: true } }, { cwd: t.home, kernel: t.kernel, config: {}, session: { id: A, user: "u1" } });
    await t.service.sweep();
    await t.service.idle();
    assert.equal(await get(t.home, `reflections/${A}.json`), null);
    assert.equal(await get(t.home, `reflections/${A}/context/trajectory.md`), null);
    assert.equal(await get(t.home, `reflections/${A}.md`), null);
  } finally {
    await t.done();
  }
});
