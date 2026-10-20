// The UI command: the list with archived conversations that have no record, Reflect and Cancel, the
// proposals and their trials, Adopt, Reject and Retire, the findings, and the settings written at the
// person's layer. Also the words of the chip and the place, which are pure, and the line diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uiCall } from "../index.js";
import { OPS } from "../lib/ops.js";
import { lineDiff, folded } from "../ui/diff.js";
import { adoptButton, canTrial, chipVisible, describe, explain, findingChip, groupFindings, proposalChip, seenLine, shortReason, trialLabel } from "../ui/state.js";
import { fakeKernel, get, put, sampleSession, tempHome } from "./helpers.js";

const A = "s_aaaa1111";
const B = "s_bbbb2222";
const C = "s_cccc3333";
const T = "t_0a0b0c0d";
const P = "p_0a1b2c3d";

const SKILL = `---
name: check-the-generator
description: Use when a file you are about to edit is produced by a build or a generator.
---
# Check the generator

Before you edit a generated file, find its generator and change the source.
`;

/** A library entry in the contract's shape; `extra` overrides. */
function entry(id, extra = {}) {
  return {
    id,
    kind: "skill",
    target: "check-the-generator",
    path: "skills/check-the-generator/SKILL.md",
    cue: "a file you are about to edit is produced by a build or a generator",
    lesson: "Before editing a generated file, find its generator and change the source instead.",
    change: SKILL,
    before: null,
    evidence: "rows 1, 2; [4], [5], [8], [9]",
    confidence: "medium, one conversation but a clear before and after",
    trialRequest: "opening request",
    from: [{ session: A, title: "Header fix", at: "2026-10-19T11:00:00.000Z", rows: [1, 2] }],
    versions: {},
    owner: null,
    state: "proposed",
    trials: [],
    verdict: null,
    applied: null,
    recheck: null,
    createdAt: "2026-10-19T11:00:00.000Z",
    updatedAt: "2026-10-19T11:00:00.000Z",
    ...extra,
  };
}

/** A verdict the service would write after a trial. */
const verdict = (result = "helped", extra = {}) => ({ result, why: "The change arm checked the generator first.", seen: [true, true], runs: 4, costUsd: 0.5, at: "2026-10-20T10:00:00.000Z", trial: T, ...extra });

/** A finding in the contract's shape. */
const finding = (id, extra = {}) => ({
  id,
  package: "@thetis/tools-files",
  component: "read_file",
  what: "read_file cut a long line without saying so.",
  seen: [{ session: A, title: "Header fix", at: "2026-10-19T11:00:00.000Z", version: "0.4.0", events: [4], rows: [1] }],
  state: "open",
  since: null,
  closedAt: null,
  ...extra,
});

/**
 * The trials host as `kernel.operator.call` reaches it: `host.trials.start` answers a new trial id and
 * writes its `trial.json` queued, `status` reads it back. Defined here so these tests do not depend on the
 * shared helper's fake.
 */
function fakeOperator(home, ids = [T]) {
  const calls = [];
  let next = 0;
  return {
    calls,
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "host.trials.start") {
        const trial = ids[next++ % ids.length];
        const runs = [];
        for (let n = 1; n <= (args.runs ?? 1); n++) for (const arm of ["base", "change"]) runs.push({ arm, n, state: "queued", tokens: 0 });
        await put(home, `trials/${trial}/trial.json`, { id: trial, user: "u1", session: args.session, state: "queued", model: args.model, project: args.project ?? null, request: args.request, arms: args.arms, runs, costUsd: 0, createdAt: new Date().toISOString() });
        return { trial };
      }
      if (name === "host.trials.status") return get(home, `trials/${args.trial}/trial.json`);
      if (name === "host.trials.list") return [];
      if (name === "host.trials.cancel") return { ok: true };
      throw new Error(`no operator call ${name}`);
    },
  };
}

async function setup(config = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(A), sampleSession(B), sampleSession(C), { summary: { id: "s_dddd4444", parent: A }, record: {} }], config });
  kernel.operator = fakeOperator(home);
  kernel.packages ??= { list: async () => [] };
  const env = { cwd: home, kernel, user: "u1", role: "user", config };
  const call = async (op, args = {}) => (await uiCall({ op, ...args }, env)).data;
  return { home, kernel, env, call, done };
}

const library = (home, entries) => put(home, "reflections/library.json", { entries });
const stateOf = async (home, id) => (await get(home, "reflections/library.json")).entries.find((e) => e.id === id)?.state;

test("the ops: forget-lesson is gone, the proposal and finding ops are there, and index.js allows each", async () => {
  assert.deepEqual([...OPS], ["list", "get", "reflect", "cancel", "settings", "set-setting", "project-switch", "proposals", "proposal", "trial", "trial-cancel", "adopt", "reject", "retire", "findings", "finding-close"]);
  const t = await setup();
  try {
    await assert.rejects(() => uiCall({ op: "forget-lesson", id: "x" }, t.env), /There is no op named "forget-lesson"/);
    await assert.rejects(() => uiCall({ op: "nope" }, t.env), new RegExp(`the ops are ${OPS.join(", ")}\\.`));
    await assert.rejects(() => uiCall({}, t.env), /op is required/);
  } finally {
    await t.done();
  }
});

test("list: records, archived conversations without one as Not reflected, and how many trials run", async () => {
  const t = await setup();
  try {
    await put(t.home, "reflections/installed.json", { at: "2026-10-19T00:00:00.000Z" });
    await put(t.home, `gateway-web/sessions/u1/${A}.json`, { archived: true, title: "Done one" });
    await put(t.home, `gateway-web/sessions/u1/${B}.json`, { archived: true, archivedAt: "2026-10-01T00:00:00.000Z" });
    await put(t.home, `gateway-web/sessions/u1/${C}.json`, { archived: true, archivedAt: "2026-10-19T09:00:00.000Z" });
    await put(t.home, `reflections/${A}.json`, { session: A, title: "old", state: "done", costUsd: 0.04, proposal: "L-aa11bb", findings: [], finishedAt: "2026-10-19T10:00:00.000Z" });
    await library(t.home, [entry("L-aa11bb", { state: "trialling", trials: [T] }), entry("L-cc22dd")]);
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
    assert.equal(out.trialling, 1, "the place polls fast while a trial runs");
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

test("get answers the record, the reflection, its proposal and findings, and where the evidence is", async () => {
  const t = await setup();
  try {
    const none = await t.call("get", { session: A });
    assert.equal(none.record.state, "none");
    assert.equal(none.proposal, null);
    assert.deepEqual(none.findings, []);

    await library(t.home, [entry("L-aa11bb")]);
    await put(t.home, "reflections/findings.json", { findings: [finding("F-ff11ee")] });
    await put(t.home, `reflections/${A}.json`, { session: A, title: "t", state: "done", proposal: "L-aa11bb", findings: ["F-ff11ee", "F-0000aa"] });
    await put(t.home, `reflections/${A}.md`, "# Reflection");
    await put(t.home, `reflections/${A}/context/trajectory.md`, "x");
    const got = await t.call("get", { session: A });
    assert.equal(got.reflection, "# Reflection");
    assert.equal(got.evidence, `reflections/${A}/context/trajectory.md`);
    assert.equal(got.proposal.id, "L-aa11bb");
    assert.equal(got.proposal.lesson, entry("x").lesson);
    assert.deepEqual(got.findings.map((f) => f.id), ["F-ff11ee", "F-0000aa"]);
    assert.equal(got.findings[0].component, "read_file");
    assert.equal(got.findings[1].missing, true, "a finding no longer kept says so");
  } finally {
    await t.done();
  }
});

test("proposals: every entry, a project's name, forgotten sources, and what Run trial promises", async () => {
  const t = await setup({ trialRuns: 3, trialCostUsd: 2.5 });
  try {
    await put(t.home, `projects/${P}.json`, { id: P, name: "Nova" });
    await library(t.home, [
      entry("L-aa11bb"),
      entry("L-cc22dd", { kind: "project-instructions", target: P, path: null, change: "Build with npm run build.", from: [{ session: "s_9999aaaa", title: "Gone", at: "2026-10-18T00:00:00.000Z", rows: [1] }] }),
      entry("L-ee33ff", { kind: "guide-note", target: "-", change: "Say which file you changed.", state: "rejected" }),
    ]);
    const out = await t.call("proposals");
    assert.deepEqual(out.entries.map((e) => e.id).sort(), ["L-aa11bb", "L-cc22dd", "L-ee33ff"]);
    const by = Object.fromEntries(out.entries.map((e) => [e.id, e]));
    assert.equal(by["L-cc22dd"].targetName, "Nova");
    assert.equal(by["L-cc22dd"].from[0].gone, true);
    assert.equal(by["L-aa11bb"].from[0].gone, false);
    assert.deepEqual(out.trial, { runs: 3, costUsd: 2.5, minutes: 20 });
  } finally {
    await t.done();
  }
});

test("proposal: the entry, the opening request without its turn-context line, and the last trial's runs and files", async () => {
  const t = await setup();
  try {
    await library(t.home, [entry("L-aa11bb", { state: "trialled", trials: ["t_00000001", T], verdict: verdict("hurt") })]);
    await put(t.home, `trials/${T}/trial.json`, {
      id: T, state: "done", costUsd: 0.5,
      runs: [
        { arm: "base", n: 1, state: "done", costUsd: 0.2, tokens: 10 },
        { arm: "change", n: 1, state: "budget", costUsd: 0.3, tokens: 10, error: "over the cap" },
      ],
    });
    await put(t.home, `reflections/trials/${T}/base-1.md`, "[1] [USER] hi");
    await put(t.home, `reflections/trials/${T}/judge.md`, "# Judgement");
    const out = await t.call("proposal", { id: "L-aa11bb" });
    assert.equal(out.entry.id, "L-aa11bb");
    assert.equal(out.entry.verdict.result, "hurt");
    assert.deepEqual(out.request, { text: "Fix the header colour", source: "opening request" });
    assert.deepEqual(out.settings, { runs: 2, costUsd: 5, minutes: 20 });
    assert.equal(out.trial.id, T, "the last trial is the one shown");
    assert.equal(out.trial.state, "done");
    assert.equal(out.trial.judge, `reflections/trials/${T}/judge.md`);
    assert.deepEqual(out.trial.runs.map((r) => [r.arm, r.n, r.state, r.costUsd, r.file]), [
      ["base", 1, "done", 0.2, `reflections/trials/${T}/base-1.md`],
      ["change", 1, "budget", 0.3, null],
    ]);

    await library(t.home, [entry("L-cc22dd", { trialRequest: "Fix the colour of the header in dist/app.js" })]);
    const written = await t.call("proposal", { id: "L-cc22dd" });
    assert.deepEqual(written.request, { text: "Fix the colour of the header in dist/app.js", source: "proposal" });
    assert.equal(written.trial, null);

    await assert.rejects(() => t.call("proposal", { id: "../etc" }), /not a proposal id/);
    await assert.rejects(() => t.call("proposal", {}), /id is required/);
    await assert.rejects(() => t.call("proposal", { id: "L-0000aa" }));
  } finally {
    await t.done();
  }
});

test("trial starts a trial through the trials host, with the request the person edited", async () => {
  const t = await setup();
  try {
    await library(t.home, [entry("L-aa11bb")]);
    await assert.rejects(() => t.call("trial", { id: "L-aa11bb", request: "   " }), /request must be/);
    await assert.rejects(() => t.call("trial", { id: "L-aa11bb", request: "x".repeat(20001) }), /over 20000/);
    const out = await t.call("trial", { id: "L-aa11bb", request: "Fix the header colour in the source" });
    assert.equal(out.trial, T);
    const start = t.kernel.operator.calls.find((c) => c.name === "host.trials.start");
    assert.ok(start, "host.trials.start was called");
    assert.equal(start.args.request?.text ?? start.args.request, "Fix the header colour in the source");
    assert.equal(await stateOf(t.home, "L-aa11bb"), "trialling");
    assert.deepEqual((await get(t.home, "reflections/library.json")).entries[0].trials, [T]);
  } finally {
    await t.done();
  }
});

test("trial-cancel stops a running trial and the proposal goes back to where it was", async () => {
  const t = await setup();
  try {
    await library(t.home, [entry("L-aa11bb")]);
    await assert.rejects(() => t.call("trial-cancel", { id: "L-aa11bb" }), /No trial of it is running/);
    await assert.rejects(() => t.call("trial-cancel", { id: "../x" }), /not a proposal id/);
    await t.call("trial", { id: "L-aa11bb" });
    assert.equal(await stateOf(t.home, "L-aa11bb"), "trialling");
    await t.call("trial-cancel", { id: "L-aa11bb" });
    const stop = t.kernel.operator.calls.at(-1);
    assert.equal(stop.name, "host.trials.cancel");
    assert.equal(stop.args.trial, T);
    const after = (await get(t.home, "reflections/library.json")).entries[0];
    assert.equal(after.state, "proposed");
    assert.equal(after.verdict.result, "inconclusive");
    assert.deepEqual(adoptButton(after), { label: "Adopt", disabled: true, reason: "Run a trial first." }, "a cancelled trial judged nothing");
    await assert.rejects(() => t.call("adopt", { id: "L-aa11bb" }), /Run a trial first/);
  } finally {
    await t.done();
  }
});

test("adopt is refused before a trial; after one it writes the change, and retire takes it back", async () => {
  const t = await setup();
  try {
    await library(t.home, [entry("L-aa11bb")]);
    await assert.rejects(() => t.call("adopt", { id: "L-aa11bb" }), /Run a trial first/);

    await library(t.home, [entry("L-aa11bb", { state: "trialled", trials: [T], verdict: verdict() })]);
    await t.call("adopt", { id: "L-aa11bb" });
    assert.equal(await get(t.home, "skills/check-the-generator/SKILL.md"), SKILL);
    assert.equal(await stateOf(t.home, "L-aa11bb"), "adopted");

    await t.call("retire", { id: "L-aa11bb" });
    assert.equal(await get(t.home, "skills/check-the-generator/SKILL.md"), null, "a new skill is deleted again");
    assert.equal(await stateOf(t.home, "L-aa11bb"), "retired");
  } finally {
    await t.done();
  }
});

test("adopt is refused when the file changed since the proposal", async () => {
  const t = await setup();
  try {
    await library(t.home, [entry("L-aa11bb", { state: "trialled", trials: [T], verdict: verdict() })]);
    await put(t.home, "skills/check-the-generator/SKILL.md", "written by hand meanwhile");
    await assert.rejects(() => t.call("adopt", { id: "L-aa11bb" }), /changed since the proposal/);
    assert.equal(await get(t.home, "skills/check-the-generator/SKILL.md"), "written by hand meanwhile");
  } finally {
    await t.done();
  }
});

test("reject marks a proposal rejected", async () => {
  const t = await setup();
  try {
    await library(t.home, [entry("L-aa11bb")]);
    await t.call("reject", { id: "L-aa11bb" });
    assert.equal(await stateOf(t.home, "L-aa11bb"), "rejected");
    await assert.rejects(() => t.call("reject", { id: 7 }), /id is required/);
  } finally {
    await t.done();
  }
});

test("findings lists every finding with its sightings; finding-close closes one", async () => {
  const t = await setup();
  try {
    await put(t.home, "reflections/findings.json", {
      findings: [finding("F-ff11ee"), finding("F-ee22dd", { package: "@thetis/terminal", component: "run", state: "possibly-fixed", since: "0.5.0", seen: [{ session: "s_9999aaaa", title: "Gone", at: "2026-10-18T00:00:00.000Z", version: "0.4.0", events: [2], rows: [1] }] })],
    });
    const out = await t.call("findings");
    const by = Object.fromEntries(out.findings.map((f) => [f.id, f]));
    assert.equal(by["F-ff11ee"].seen[0].gone, false);
    assert.equal(by["F-ee22dd"].seen[0].gone, true);
    await t.call("finding-close", { id: "F-ff11ee" });
    const after = (await get(t.home, "reflections/findings.json")).findings.find((f) => f.id === "F-ff11ee");
    assert.equal(after.state, "closed");
    await assert.rejects(() => t.call("finding-close", { id: "L-aa11bb" }), /not a finding id/);
  } finally {
    await t.done();
  }
});

test("settings: the model list, the trial settings, and changes at the person's layer", async () => {
  const t = await setup();
  try {
    await put(t.home, `projects/${P}.json`, { id: P, name: "Nova" });
    const s = await t.call("settings");
    assert.equal(s.model, "");
    assert.equal(s.serverDefault, "fable");
    assert.deepEqual(s.models.map((m) => m.id), ["fable", "opus"]);
    assert.deepEqual(s.projects, [{ id: P, name: "Nova", enabled: true }]);
    assert.deepEqual([s.trialRuns, s.trialCostUsd, s.trialMinutes, s.trialScratchMb, s.trialModel], [2, 5, 20, 8192, ""]);

    const after = await t.call("set-setting", { key: "model", value: "opus" });
    assert.deepEqual(t.kernel.sets.at(-1), { name: "@thetis/reflections", key: "model", value: "opus" });
    assert.equal(after.model, "opus", "the answer reads the setting again");
    await t.call("set-setting", { key: "model", value: null });
    assert.deepEqual(t.kernel.sets.at(-1), { name: "@thetis/reflections", key: "model", value: undefined });
    await assert.rejects(() => t.call("set-setting", { key: "inputChars", value: 1 }), /key must be one of/);
    await assert.rejects(() => t.call("set-setting", { key: "dailyCostUsd", value: -1 }), /0 or more/);

    assert.equal((await t.call("set-setting", { key: "trialRuns", value: 4 })).trialRuns, 4);
    await assert.rejects(() => t.call("set-setting", { key: "trialRuns", value: 6 }), /1 to 5/);
    await assert.rejects(() => t.call("set-setting", { key: "trialRuns", value: 1.5 }), /1 to 5/);
    assert.equal((await t.call("set-setting", { key: "trialCostUsd", value: 2.5 })).trialCostUsd, 2.5);
    await assert.rejects(() => t.call("set-setting", { key: "trialCostUsd", value: 0 }), /above 0/);
    await assert.rejects(() => t.call("set-setting", { key: "trialMinutes", value: 0.5 }), /1 or more/);
    await assert.rejects(() => t.call("set-setting", { key: "trialScratchMb", value: 100 }), /256 or more/);
    assert.equal((await t.call("set-setting", { key: "trialModel", value: " opus " })).trialModel, "opus");

    const off = await t.call("project-switch", { project: P, enabled: false });
    assert.equal(off.projects[0].enabled, false);
    assert.deepEqual(await get(t.home, "reflections/projects.json"), { [P]: false });
    await t.call("project-switch", { project: P, enabled: true });
    assert.deepEqual(await get(t.home, "reflections/projects.json"), {});
  } finally {
    await t.done();
  }
});

test("the chip's words follow the state", () => {
  assert.equal(describe({ state: "done", costUsd: 0.04, proposal: "L-aa11bb", findings: [] }).label, "Reflected · 1 proposal · $0.04");
  assert.equal(describe({ state: "done", proposal: null, findings: ["F-1", "F-2"] }).label, "Reflected · 2 findings");
  assert.equal(describe({ state: "done", proposal: null, findings: [] }).label, "Reflected · nothing to propose");
  assert.equal(describe({ state: "done", proposal: "L-aa11bb", findings: ["F-1"] }).label, "Reflected · 1 proposal · 1 finding");
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
  assert.match(explain({ state: "done", reason: "no proposal: the note is over 300 characters" }), /^Reflected\. No proposal: the note is over 300 characters\.$/);
});

test("the proposal's words: the pill, the Adopt button, the Run trial label, what was seen", () => {
  assert.deepEqual(proposalChip(entry("L-1")), { label: "No trial yet", tone: "dim" });
  assert.equal(proposalChip(entry("L-1", { state: "trialling" })).label, "Trialling…");
  assert.deepEqual(proposalChip(entry("L-1", { state: "trialled", verdict: verdict("helped (one run each: weak)") })), { label: "Trial: helped (one run each: weak)", tone: "ok" });
  assert.equal(proposalChip(entry("L-1", { verdict: { error: "the sandbox failed" } })).label, "Trial failed");
  assert.equal(proposalChip(entry("L-1", { state: "retired", verdict: verdict() })).label, "Retired");

  assert.deepEqual(adoptButton(entry("L-1")), { label: "Adopt", disabled: true, reason: "Run a trial first." });
  assert.equal(adoptButton(entry("L-1", { state: "trialling" })).disabled, true);
  assert.deepEqual(adoptButton(entry("L-1", { state: "trialled", verdict: verdict() })), { label: "Adopt", disabled: false, reason: null });
  assert.equal(adoptButton(entry("L-1", { state: "trialled", verdict: verdict("no difference") })).label, "Adopt anyway");
  assert.equal(adoptButton(entry("L-1", { state: "adopted", verdict: verdict() })), null);
  assert.equal(adoptButton(entry("L-1", { state: "adopted", verdict: verdict(), recheck: { reason: "x" } })).label, "Adopt");
  assert.equal(adoptButton(entry("L-1", { state: "rejected" })), null);

  assert.equal(trialLabel(entry("L-1"), { runs: 2, costUsd: 5 }), "Run trial (2 runs each, up to $5)");
  assert.equal(trialLabel(entry("L-1", { trials: [T] }), { runs: 1, costUsd: 2.5 }), "Run trial again (1 run each, up to $2.50)");
  assert.equal(canTrial(entry("L-1", { state: "trialling" })).ok, false);
  assert.equal(canTrial(entry("L-1", { state: "rejected" })).ok, false);
  assert.equal(canTrial(entry("L-1", { state: "adopted" })).ok, true);

  assert.equal(seenLine([true, false]), "The change was seen in 1 of 2 runs with it.");
  assert.match(seenLine([false, false]), /not seen in any run/);
  assert.equal(seenLine(undefined), null);
});

test("the findings' words and groups", () => {
  assert.equal(findingChip(finding("F-1")).label, "Open");
  assert.equal(findingChip(finding("F-1", { state: "possibly-fixed", since: "0.5.0" })).label, "Possibly fixed in 0.5.0");
  assert.equal(findingChip(finding("F-1", { state: "closed" })).label, "Closed");
  const groups = groupFindings([finding("F-1", { state: "closed" }), finding("F-2", { package: "@thetis/browser" }), finding("F-3")]);
  assert.deepEqual(groups.map(([name, items]) => [name, items.map((f) => f.id)]), [["@thetis/browser", ["F-2"]], ["@thetis/tools-files", ["F-3", "F-1"]]]);
});

test("the line diff marks what was removed and added, and folds long unchanged runs", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc"), [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }]);
  assert.deepEqual(lineDiff("", "x\ny"), [{ op: "+", text: "x" }, { op: "+", text: "y" }], "an empty file has no lines, so nothing shows as context between the added ones");
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const out = folded(lineDiff(long.join("\n"), [...long.slice(0, 10), "new", ...long.slice(10)].join("\n")));
  assert.deepEqual(out[0], { op: "…", count: 7 });
  assert.equal(out.filter((l) => l.op === "+").length, 1);
  assert.deepEqual(out.at(-1), { op: "…", count: 7 });
});
