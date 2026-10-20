// Following a trial and judging it: the blind ids, the judge's request and the parse of its answer, the
// aggregation of every verdict, whether the change was seen, and what a finished, failed or cut-short
// trial does to the entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readLibrary, recordProposal, startTrial } from "../lib/library.js";
import { guard, parseAnswer } from "../lib/prompt.js";
import { settingsOf, today } from "../lib/records.js";
import { aggregate, anonId, assignIds, followTrials, judgeRequest, parseJudge } from "../lib/trials.js";
import { GOOD_ANSWER, assistant, call, fakeKernel, finishTrial, get, guardContext, sampleSession, tempHome, user } from "./helpers.js";

const S = "s_aaaa1111";
const settings = settingsOf({});

test("anonymous ids: A..Z then AA; a stable permutation for a seed", () => {
  assert.deepEqual([0, 1, 25, 26, 27, 52].map(anonId), ["A", "B", "Z", "AA", "AB", "BA"]);
  const labels = ["base-1", "change-1", "base-2", "change-2"];
  const a = assignIds(labels, "t_00000001|4|judge");
  assert.deepEqual(a, assignIds([...labels].reverse(), "t_00000001|4|judge"), "the input order does not matter");
  assert.deepEqual(Object.keys(a), ["A", "B", "C", "D"]);
  assert.deepEqual(Object.values(a).sort(), [...labels].sort());
  const others = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(assignIds(labels, `t_${i}|4|judge`))));
  assert.ok(others.size > 1, "the seed shuffles");
});

test("the judge's request is blind and tool-less; its answer parses", () => {
  const r = judgeRequest({ model: "fable", request: "Fix it", cue: "a generated file", runs: [{ id: "A", text: "[1] [USER] Fix it" }, { id: "B", text: "[1] [USER] Fix it" }] });
  assert.deepEqual(r.tools, []);
  assert.match(r.system, /differ in one change to the assistant's harness/);
  assert.match(r.system, /never how it sounds/);
  assert.match(r.messages[0].content[0].data.text, /<file path="context\/runs\/B\.md">/);
  const parsed = parseJudge("<runs>\nrun: A\nsituation: yes [3], [4]\ngrade: 4\nreason: Did it.\nrun: **B**\nsituation: No.\ngrade: 2/5\nreason: Did not.\nrun: Q\ngrade: 5\n</runs>\n<choice>\nbest: A\nrunner-up: B\nwhy: A finished.\n</choice>", ["A", "B"]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.runs.A, { situation: "yes", cited: [3, 4], grade: 4, reason: "Did it." });
  assert.deepEqual([parsed.runs.B.situation, parsed.runs.B.grade], ["no", 2]);
  assert.equal(parsed.runs.Q, undefined, "an id that is not a run is ignored");
  assert.deepEqual([parsed.best, parsed.runnerUp, parsed.why], ["A", "B", "A finished."]);
  assert.equal(parseJudge("<runs>\nrun: A\ngrade: 9\n</runs>", ["A"]).ok, false, "a grade out of range is none");
  assert.equal(parseJudge("no blocks", ["A"]).ok, false);
});

const run = (arm, n, state = "done") => ({ label: `${arm}-${n}`, arm, n, state });
const two = [run("base", 1), run("change", 1), run("base", 2), run("change", 2)];
const g = (pairs) => Object.fromEntries(Object.entries(pairs).map(([label, [situation, grade]]) => [label, { situation, grade }]));

test("aggregation: helped, hurt, no difference, not reached, inconclusive, weak", () => {
  assert.deepEqual(aggregate(two, g({ "base-1": ["yes", 2], "base-2": ["yes", 3], "change-1": ["yes", 4], "change-2": ["yes", 4] })), { result: "helped", why: "change runs graded 4, base runs 2.5, where the situation arose" });
  assert.equal(aggregate(two, g({ "base-1": ["yes", 4], "base-2": ["yes", 4], "change-1": ["yes", 3], "change-2": ["yes", 3.5] })).result, "hurt");
  assert.equal(aggregate(two, g({ "base-1": ["yes", 4], "base-2": ["yes", 3], "change-1": ["yes", 4], "change-2": ["yes", 3.5] })).result, "no difference");
  assert.deepEqual(aggregate(two, g({ "base-1": ["no", 4], "base-2": ["no", 3], "change-1": ["unclear", 4], "change-2": ["no", 3] })), { result: "not reached", why: "the situation arose in no run (the judge could not tell in 1)" });
  // Runs where it did not arise are left out of the means.
  assert.equal(aggregate(two, g({ "base-1": ["yes", 2], "base-2": ["no", 5], "change-1": ["yes", 4], "change-2": ["no", 1] })).result, "helped");
  // Arising in one arm only: every run is compared, and the why says so.
  const one = aggregate(two, g({ "base-1": ["yes", 2], "base-2": ["yes", 2], "change-1": ["no", 5], "change-2": ["no", 5] }));
  assert.deepEqual(one, { result: "helped", why: "change runs graded 5, base runs 2, over every run, since the situation arose only in the base runs" });
  assert.deepEqual(aggregate([run("base", 1), run("change", 1)], g({ "base-1": ["yes", 2], "change-1": ["yes", 4] })), { result: "helped", why: "change runs graded 4, base runs 2, where the situation arose (one run each: weak)", weak: true });
  assert.deepEqual(aggregate([run("base", 1), run("change", 1, "timeout"), run("base", 2, "budget")], null), { result: "inconclusive", why: "change-1 ran out of time; base-2 hit the trial's cost cap" });
  assert.deepEqual(aggregate([{ ...run("base", 1, "failed"), error: "provider error" }], null), { result: "inconclusive", why: "base-1 failed: provider error" });
  assert.deepEqual(aggregate(two, null), { result: "inconclusive", why: "the judge's answer could not be read" });
});

/** A judge that grades a run by what its trajectory says: the generator found is a 4, the edit of dist a 2. */
function judgeScript({ situation = "yes [2]", cost = 0.02 } = {}) {
  return (request) => {
    const text = request.messages[0].content[0].data.text;
    const ids = [...text.matchAll(/<file path="context\/runs\/([A-Z]+)\.md">\n([\s\S]*?)<\/file>/g)];
    const rows = ids.map(([, id, body]) => `run: ${id}\nsituation: ${situation}\ngrade: ${/Found the generator/.test(body) ? 4 : 2}\nreason: It ${/Found the generator/.test(body) ? "changed the source" : "edited the output"}.`);
    return [{ type: "text", delta: `<runs>\n${rows.join("\n")}\n</runs>\n<choice>\nbest: ${ids.find(([, , b]) => /Found/.test(b))[1]}\nrunner-up: ${ids.find(([, , b]) => !/Found/.test(b))[1]}\nwhy: The source change lasts.\n</choice>` }, { type: "usage", usage: { cost } }];
  };
}

async function trialling({ script = judgeScript(), runs = 2 } = {}) {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(S)], script, home });
  const g = guard(parseAnswer(GOOD_ANSWER), guardContext());
  const { id } = await recordProposal({ home, kernel }, { proposal: g.proposal, conversation: { session: S, title: "Header" }, rows: g.rows });
  const { trial } = await startTrial({ home, kernel }, settingsOf({ trialRuns: runs }), id);
  return { home, kernel, id, trial, done, entry: async () => (await readLibrary(home)).entries.find((e) => e.id === id) };
}

const pinned = (arm) => ({ turn: 1, model: "m", skills: { loader: "@thetis/skills-hybrid", pinned: arm === "change" ? [{ id: "generated-files", contentHash: "h" }] : [], universal: [] } });

test("a done trial is judged: run files, judge.md, the verdict, the cost, the state", async () => {
  const t = await trialling();
  try {
    assert.equal(await followTrials({ home: t.home, kernel: t.kernel }, settings), 0, "a queued trial is left");
    assert.equal(t.kernel.calls.length, 0);
    await finishTrial(t.home, t.trial, { runs: 2, stamp: pinned });
    assert.equal(await followTrials({ home: t.home, kernel: t.kernel }, settings), 1);
    assert.equal(t.kernel.calls.length, 1, "one judge call");
    const req = t.kernel.calls[0];
    assert.deepEqual(req.tools, []);
    assert.equal(req.model, "fable", "the reflection model, unset: the server's default");
    const text = req.messages[0].content[0].data.text;
    assert.doesNotMatch(text, /base-\d|change-\d/, "the judge never sees an arm");
    assert.match(text, /<file path="context\/request\.md">\nFix the header colour\n<\/file>/);
    assert.match(text, /<file path="context\/cue\.md">\na file you are about to edit is produced by a build or a generator/);
    const e = await t.entry();
    assert.equal(e.state, "trialled");
    assert.equal(e.previousState, undefined);
    const v = e.verdict;
    assert.equal(v.result, "helped");
    assert.equal(v.why, "change runs graded 4, base runs 2, where the situation arose");
    assert.equal(v.seen, true);
    assert.equal(v.trial, t.trial);
    assert.equal(v.costUsd, 0.32, "the trial's runs and the judge");
    assert.equal(v.judgeCostUsd, 0.02);
    assert.equal(v.best.startsWith("change-"), true);
    assert.deepEqual(v.runs.map((r) => [r.label, r.grade, r.situation, r.seen]), [["base-1", 2, "yes", undefined], ["change-1", 4, "yes", true], ["base-2", 2, "yes", undefined], ["change-2", 4, "yes", true]]);
    assert.ok(v.runs.every((r) => /^[A-D]$/.test(r.id)));
    for (const label of ["base-1", "change-1", "base-2", "change-2"]) assert.match(await get(t.home, `reflections/trials/${t.trial}/${label}.md`), new RegExp(`^# Trial ${t.trial}, run ${label}\\n\\n# Conversation`));
    const md = await get(t.home, `reflections/trials/${t.trial}/judge.md`);
    assert.match(md, /\| Run \| Situation \| Grade \| Reason \|/);
    assert.match(md, /## The map\n\n- A = /);
    assert.match(md, /\*\*helped\*\*: change runs graded 4/);
    assert.match(md, /Seen in the change runs: yes\./);
    assert.equal((await get(t.home, "reflections/spend.json")).usd, 0.02, "the judge's cost is in the day's spend");
    assert.equal((await get(t.home, "reflections/spend.json")).day, today());
    assert.equal(await followTrials({ home: t.home, kernel: t.kernel }, settings), 0, "judged once");
  } finally {
    await t.done();
  }
});

test("seen: a skill neither pinned nor fetched is not seen and the why says so; skill_fetch counts", async () => {
  const t = await trialling({ runs: 1 });
  try {
    await finishTrial(t.home, t.trial, { runs: 1 });
    await followTrials({ home: t.home, kernel: t.kernel }, settings);
    const v = (await t.entry()).verdict;
    assert.equal(v.seen, false);
    assert.equal(v.why, "change runs graded 4, base runs 2, where the situation arose (one run each: weak); the change was not seen in every change run");
    assert.equal(v.weak, true);
  } finally {
    await t.done();
  }
  const f = await trialling({ runs: 1 });
  try {
    await finishTrial(f.home, f.trial, { runs: 1, conversation: (arm) => [user("Fix the header colour"), assistant(arm === "change" ? "Found the generator." : "Edited dist/app.js.", arm === "change" ? [call("k", "skill_fetch", { id: "generated-files" })] : undefined)] });
    await followTrials({ home: f.home, kernel: f.kernel }, settings);
    assert.equal((await f.entry()).verdict.seen, true);
  } finally {
    await f.done();
  }
});

test("the situation arose nowhere: not reached", async () => {
  const t = await trialling({ script: judgeScript({ situation: "no" }), runs: 1 });
  try {
    await finishTrial(t.home, t.trial, { runs: 1, stamp: pinned });
    await followTrials({ home: t.home, kernel: t.kernel }, settings);
    const e = await t.entry();
    assert.deepEqual([e.state, e.verdict.result, e.verdict.why], ["trialled", "not reached", "the situation arose in no run"]);
  } finally {
    await t.done();
  }
});

test("a run cut short: inconclusive, and the judge is not asked", async () => {
  const t = await trialling({ runs: 1 });
  try {
    await finishTrial(t.home, t.trial, { runs: 1, runState: (arm) => (arm === "change" ? "budget" : "done") });
    await followTrials({ home: t.home, kernel: t.kernel }, settings);
    const e = await t.entry();
    assert.equal(t.kernel.calls.length, 0);
    assert.deepEqual([e.state, e.verdict.result, e.verdict.why], ["trialled", "inconclusive", "change-1 hit the trial's cost cap"]);
    assert.match(await get(t.home, `reflections/trials/${t.trial}/judge.md`), /The judge was not asked/);
  } finally {
    await t.done();
  }
});

test("an unreadable judgement or a judge that fails is inconclusive", async () => {
  const t = await trialling({ script: () => [{ type: "text", delta: "They both seem fine." }], runs: 1 });
  try {
    await finishTrial(t.home, t.trial, { runs: 1 });
    await followTrials({ home: t.home, kernel: t.kernel }, settings);
    assert.equal((await t.entry()).verdict.why, "the judge's answer could not be read");
    assert.match(await get(t.home, `reflections/trials/${t.trial}/judge.md`), /## The judge's answer, as it came\n\n```\nThey both seem fine\./);
  } finally {
    await t.done();
  }
  const f = await trialling({ script: () => [{ type: "error", message: "overloaded" }], runs: 1 });
  try {
    await finishTrial(f.home, f.trial, { runs: 1 });
    await followTrials({ home: f.home, kernel: f.kernel }, settings);
    assert.equal((await f.entry()).verdict.why, "the judge failed: overloaded");
  } finally {
    await f.done();
  }
});

test("a failed or cancelled trial puts the entry back where it was, with the error", async () => {
  const t = await trialling({ runs: 1 });
  try {
    await finishTrial(t.home, t.trial, { runs: 1, state: "failed", error: "trials need the bwrap sandbox" });
    await followTrials({ home: t.home, kernel: t.kernel }, settings);
    const e = await t.entry();
    assert.equal(t.kernel.calls.length, 0);
    assert.equal(e.state, "proposed");
    assert.deepEqual([e.verdict.result, e.verdict.why, e.verdict.error], ["inconclusive", "the trial failed: trials need the bwrap sandbox", "trials need the bwrap sandbox"]);
    // Tried again, then cancelled from outside: back again.
    const { trial } = await startTrial({ home: t.home, kernel: t.kernel }, settings, t.id);
    await t.kernel.operator.call("host.trials.cancel", { trial });
    await followTrials({ home: t.home, kernel: t.kernel }, settings);
    assert.deepEqual([(await t.entry()).state, (await t.entry()).verdict.why], ["proposed", "the trial was cancelled"]);
  } finally {
    await t.done();
  }
});
