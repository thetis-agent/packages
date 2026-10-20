// The library: an entry from a proposal (owner, path, before, versions), reinforces, the states, a trial's
// start and cancel, adopt and retire for every kind, the before-mismatch refusal, and the re-check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptEntry, cancelTrial, getEntry, listEntries, readLibrary, recheckAdopted, recordProposal, rejectEntry, retireEntry, startTrial, writeLibrary } from "../lib/library.js";
import { guard, parseAnswer } from "../lib/prompt.js";
import { settingsOf } from "../lib/records.js";
import { GOOD_ANSWER, SKILL, fakeKernel, fakePackages, finishTrial, get, guardContext, put, sampleSession, tempHome } from "./helpers.js";

const S = "s_aaaa1111";
const SHIPPED = `---\nname: thetis-packages\ndescription: "How packages work. Use when you install one."\n---\n# Packages\n\nOld text.\n`;
const EDITED = SHIPPED.replace("Old text.", "New text.");

async function fence({ packages, stamps } = {}) {
  const { home, done } = await tempHome();
  const pack = `${home}/pack`;
  await put(pack, "skills/thetis-packages/SKILL.md", SHIPPED);
  const pkgs = packages ?? fakePackages([{ name: "@thetis/skills-thetis", version: "0.10.0", type: "skill-pack", description: "", root: pack, thetis: { skills: "skills" } }]);
  const sess = sampleSession(S);
  sess.record.harness["@thetis/harness-core"] = { lastCall: { model: "anthropic/last-model" } };
  const kernel = fakeKernel({ sessions: [sess], packages: pkgs, home: `${home}/h` });
  const h = `${home}/h`;
  await put(h, "projects/p_0a1b2c3d.json", { id: "p_0a1b2c3d", name: "Nova" });
  if (stamps) await put(h, `harness-core/turns/${S}.jsonl`, stamps.map((x) => JSON.stringify(x)).join("\n"));
  return { home: h, kernel, env: { home: h, kernel }, pack, done };
}

/** A guarded proposal of `kind` on `target` with `change`. */
function proposalOf(kind, target, change) {
  const answer = GOOD_ANSWER.replace(/kind: skill\ntarget: generated-files/, `kind: ${kind}\ntarget: ${target}`).replace(/~~~\n[\s\S]*~~~/, `~~~\n${change}\n~~~`);
  const out = guard(parseAnswer(answer), guardContext({ skills: new Map([["thetis-packages", { package: "@thetis/skills-thetis" }]]) }));
  assert.equal(out.refused, null, out.refused);
  return out;
}

const conversation = { session: S, title: "Header", project: null };
const record = async (t, kind, target, change) => {
  const g = proposalOf(kind, target, change);
  return (await recordProposal(t.env, { proposal: g.proposal, conversation, rows: g.rows })).id;
};
const settings = settingsOf({});
const entry = async (home, id) => (await readLibrary(home)).entries.find((e) => e.id === id);

/** Runs a trial to `trialled` by hand, the way the service would. */
async function trialled(t, id) {
  const { trial } = await startTrial(t.env, settings, id);
  const lib = await readLibrary(t.home);
  const e = lib.entries.find((x) => x.id === id);
  Object.assign(e, { state: "trialled", verdict: { result: "helped", why: "w", trial } });
  await writeLibrary(t.home, lib);
  return trial;
}

test("a new skill: path in the home, no owner, before null, versions of the cited rows' packages", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    const e = await entry(t.home, id);
    assert.match(id, /^L-[0-9a-f]{6}$/);
    assert.equal(e.state, "proposed");
    assert.equal(e.path, "skills/generated-files/SKILL.md");
    assert.equal(e.owner, null);
    assert.equal(e.skillSource, "new");
    assert.equal(e.before, null);
    assert.equal(e.change, SKILL);
    assert.equal(e.trialRequest, "opening request");
    assert.deepEqual(e.versions, { "@thetis/tools-files": "0.4.0" }, "row 2 names @thetis/tools-files");
    assert.deepEqual(e.from.map((f) => [f.session, f.title, f.rows]), [[S, "Header", [1, 2]]]);
    assert.deepEqual([e.trials, e.verdict, e.applied, e.recheck], [[], null, null, null]);
    assert.deepEqual((await listEntries(t.home)).map((x) => x.id), [id]);
  } finally {
    await t.done();
  }
});

test("a shipped skill is overridden in the home, owned by its package; before is the shipped text", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "thetis-packages", EDITED.trimEnd());
    const e = await entry(t.home, id);
    assert.equal(e.path, "skills/thetis-packages/SKILL.md");
    assert.equal(e.owner, "@thetis/skills-thetis");
    assert.equal(e.skillSource, "shipped");
    assert.equal(e.before, SHIPPED);
    assert.equal(e.versions["@thetis/skills-thetis"], "0.10.0");
  } finally {
    await t.done();
  }
});

test("a home skill keeps its path; owner null; before is its text", async () => {
  const t = await fence();
  try {
    await put(t.home, "skills/mine/thetis-packages/SKILL.md", SHIPPED);
    await put(t.home, "skills/mine/SKILL.md", `---\nname: mine\ndescription: "Mine. Use when ever."\n---\nMine.\n`);
    await put(t.home, "skills/thetis-packages/SKILL.md", SHIPPED.replace("Old", "Home"));
    const id = await record(t, "skill", "thetis-packages", EDITED.trimEnd());
    const e = await entry(t.home, id);
    assert.equal(e.skillSource, "home");
    assert.equal(e.path, "skills/thetis-packages/SKILL.md");
    assert.equal(e.owner, null);
    assert.match(e.before, /Home text\./, "the home wins over the shipped pack");
  } finally {
    await t.done();
  }
});

test("owner and before for guide-note, config and project-instructions", async () => {
  const t = await fence();
  try {
    await t.kernel.config.set("@thetis/harness-core", "guideNotes", ["Be brief."]);
    const note = await entry(t.home, await record(t, "guide-note", "-", "Ask before deleting."));
    assert.deepEqual([note.owner, note.target, note.before, note.versions["@thetis/harness-core"]], ["@thetis/harness-core", "-", '["Be brief."]', "0.8.0"]);
    const cfg = await entry(t.home, await record(t, "config", "@thetis/harness-core maxRounds", "60"));
    assert.deepEqual([cfg.owner, cfg.before, cfg.change], ["@thetis/harness-core", null, "60"], "a key the user layer does not set has no before");
    await put(t.home, "projects/p_0a1b2c3d.md", "Old rules.\n");
    const pi = await entry(t.home, await record(t, "project-instructions", "p_0a1b2c3d", "New rules."));
    assert.deepEqual([pi.owner, pi.before, pi.change], ["@thetis/projects", "Old rules.\n", "New rules.\n"]);
  } finally {
    await t.done();
  }
});

test("reinforces appends from and evidence and nothing else; a rejected entry stays rejected", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    const before = await entry(t.home, id);
    const g = guard(parseAnswer(GOOD_ANSWER.replace("reinforces: none", `reinforces: ${id}`)), guardContext({ entries: new Set([id]) }));
    const res = await recordProposal(t.env, { proposal: g.proposal, conversation: { session: "s_bbbb2222", title: "Other" }, rows: g.rows });
    assert.deepEqual(res, { id, reinforced: true });
    const after = await entry(t.home, id);
    assert.equal((await readLibrary(t.home)).entries.length, 1, "no new entry");
    assert.deepEqual(after.from.map((f) => f.session), [S, "s_bbbb2222"]);
    assert.match(after.evidence, /\ns_bbbb2222: rows 1, 2; \[4\], \[5\], \[8\], \[9\]$/);
    for (const k of ["change", "cue", "lesson", "state", "before", "versions"]) assert.deepEqual(after[k], before[k], k);
    await rejectEntry(t.home, id);
    const again = await recordProposal(t.env, { proposal: g.proposal, conversation: { session: "s_cccc3333", title: "Third" }, rows: g.rows });
    assert.deepEqual(again, { id, reinforced: true, rejected: true });
    assert.equal((await entry(t.home, id)).state, "rejected");
  } finally {
    await t.done();
  }
});

test("startTrial: the opening request without its turn-context line, the model, the change, the settings", async () => {
  const t = await fence({ stamps: [{ turn: 1, model: "anthropic/stamped-model" }] });
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    const { trial } = await startTrial(t.env, settingsOf({ trialRuns: 3, trialCostUsd: 2, trialMinutes: 10, trialScratchMb: 1024 }), id);
    assert.match(trial, /^t_[0-9a-f]{8}$/);
    const args = t.kernel.operator.calls.find((c) => c.method === "host.trials.start").args;
    assert.deepEqual(args.request, { text: "Fix the header colour" });
    assert.equal(args.model, "anthropic/stamped-model", "turn 1's model from the stamp");
    assert.equal(args.session, S);
    assert.equal(args.project, undefined, "no project, no project field");
    assert.deepEqual(args.arms, [{ id: "base", change: null }, { id: "change", change: { kind: "skill", id: "generated-files", path: "skills/generated-files/SKILL.md", content: SKILL } }]);
    assert.deepEqual([args.runs, args.costUsd, args.minutes, args.scratchMb], [3, 2, 10, 1024]);
    const e = await getEntry(t.home, id);
    assert.equal(e.state, "trialling");
    assert.equal(e.previousState, "proposed");
    assert.deepEqual(e.trials, [trial]);
    assert.deepEqual(e.trialFiles, [{ trial, dir: `reflections/trials/${trial}`, judge: null, runs: [], status: `trials/${trial}/trial.json` }]);
    await assert.rejects(startTrial(t.env, settings, id), /^Error: Its trial is still running\.$/);
  } finally {
    await t.done();
  }
});

test("startTrial: a request given wins, the trial model setting wins, then lastCall, then the server's", async () => {
  const t = await fence();
  try {
    const id = await record(t, "project-instructions", "p_0a1b2c3d", "Rules.");
    await startTrial(t.env, settingsOf({ trialModel: "opus" }), id, { request: "  Do it this way.  " });
    let args = t.kernel.operator.calls.at(-1).args;
    assert.deepEqual([args.request.text, args.model, args.project], ["Do it this way.", "opus", "p_0a1b2c3d"], "instructions are trialled in their project");
    assert.deepEqual(args.arms[1].change, { kind: "project-instructions", project: "p_0a1b2c3d", content: "Rules.\n" });
    await cancelTrial(t.env, id);
    await startTrial(t.env, settings, id);
    args = t.kernel.operator.calls.at(-1).args;
    assert.equal(args.model, "anthropic/last-model", "no stamp: the conversation's last model");
    await cancelTrial(t.env, id);
    t.kernel.remove(S);
    await assert.rejects(startTrial(t.env, settings, id), /The conversation it came from is gone; write the request the trial should send\./);
    await startTrial(t.env, settings, id, { request: "Again." });
    assert.equal(t.kernel.operator.calls.at(-1).args.model, "fable", "the server's default");
  } finally {
    await t.done();
  }
});

test("a guide-note and a config change go to the trial as their Change kinds", async () => {
  const t = await fence();
  try {
    const n = await record(t, "guide-note", "-", "Ask before deleting.");
    await startTrial(t.env, settings, n);
    assert.deepEqual(t.kernel.operator.calls.at(-1).args.arms[1].change, { kind: "guide-note", note: "Ask before deleting." });
    const c = await record(t, "config", "@thetis/harness-core maxRounds", "60");
    await startTrial(t.env, settings, c);
    assert.deepEqual(t.kernel.operator.calls.at(-1).args.arms[1].change, { kind: "config", package: "@thetis/harness-core", key: "maxRounds", value: 60 });
  } finally {
    await t.done();
  }
});

test("cancelTrial: the host is asked, the entry goes back with the verdict; a finished trial is not an error", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    await assert.rejects(cancelTrial(t.env, id), /^Error: No trial of it is running\.$/);
    const { trial } = await startTrial(t.env, settings, id);
    const e = await cancelTrial(t.env, id);
    assert.equal((await get(t.home, `trials/${trial}/trial.json`)).state, "cancelled");
    assert.equal(e.state, "proposed");
    assert.equal(e.previousState, undefined);
    assert.equal(e.verdict.result, "inconclusive");
    assert.equal(e.verdict.why, "cancelled by you");
    assert.equal(e.verdict.trial, trial);
    const second = await startTrial(t.env, settings, id);
    await finishTrial(t.home, second.trial);
    assert.equal((await cancelTrial(t.env, id)).state, "proposed", "the host refused, the trial had finished, and the entry still went back");
  } finally {
    await t.done();
  }
});

test("adopt needs a trial; then writes the change and records before and after; retire restores", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    await assert.rejects(adoptEntry(t.env, id), /^Error: Run a trial first\.$/);
    await trialled(t, id);
    const e = await adoptEntry(t.env, id);
    assert.equal(e.state, "adopted");
    assert.equal(await get(t.home, "skills/generated-files/SKILL.md"), SKILL);
    assert.deepEqual([e.applied.before, e.applied.after, e.recheck], [null, SKILL, null]);
    await assert.rejects(adoptEntry(t.env, id), /^Error: It is already adopted\.$/);
    await assert.rejects(rejectEntry(t.home, id), /retire it first/);
    const r = await retireEntry(t.env, id);
    assert.equal(r.state, "retired");
    assert.equal(await get(t.home, "skills/generated-files/SKILL.md"), null);
    assert.equal(await get(t.home, "skills/generated-files"), null, "the empty directory goes too");
    await assert.rejects(retireEntry(t.env, id), /^Error: It is already retired\.$/);
    await assert.rejects(startTrial(t.env, settings, id), /^Error: It was retired\.$/);
  } finally {
    await t.done();
  }
});

test("a shipped-skill override: adopt writes the override, retire removes it and the shipped one wins again", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "thetis-packages", EDITED.trimEnd());
    await trialled(t, id);
    await adoptEntry(t.env, id);
    assert.equal(await get(t.home, "skills/thetis-packages/SKILL.md"), EDITED);
    await retireEntry(t.env, id);
    assert.equal(await get(t.home, "skills/thetis-packages/SKILL.md"), null);
  } finally {
    await t.done();
  }
});

test("adopt refuses when what is there changed since the proposal", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "thetis-packages", EDITED.trimEnd());
    await trialled(t, id);
    await put(t.pack, "skills/thetis-packages/SKILL.md", SHIPPED.replace("Old", "Shipped anew"));
    await assert.rejects(adoptEntry(t.env, id), /^Error: skills\/thetis-packages\/SKILL\.md changed since the proposal; run the trial again\.$/);
    const pi = await record(t, "project-instructions", "p_0a1b2c3d", "New.");
    await trialled(t, pi);
    await put(t.home, "projects/p_0a1b2c3d.md", "Someone wrote this.\n");
    await assert.rejects(adoptEntry(t.env, pi), /^Error: projects\/p_0a1b2c3d\.md changed since the proposal; run the trial again\.$/);
    const n = await record(t, "guide-note", "-", "Ask first.");
    await trialled(t, n);
    await t.kernel.config.set("@thetis/harness-core", "guideNotes", ["Other."]);
    await assert.rejects(adoptEntry(t.env, n), /^Error: The guide notes changed since the proposal; run the trial again\.$/);
  } finally {
    await t.done();
  }
});

test("guide-note: adopt appends the note at the user's layer; retire removes only it", async () => {
  const t = await fence();
  try {
    await t.kernel.config.set("@thetis/harness-core", "guideNotes", ["Be brief."]);
    const id = await record(t, "guide-note", "-", "Ask first.");
    await trialled(t, id);
    await adoptEntry(t.env, id);
    assert.deepEqual(t.kernel.layers["@thetis/harness-core"].guideNotes, ["Be brief.", "Ask first."]);
    await retireEntry(t.env, id);
    assert.deepEqual(t.kernel.layers["@thetis/harness-core"].guideNotes, ["Be brief."]);
    await t.kernel.config.unset("@thetis/harness-core", "guideNotes");
    const lone = await record(t, "guide-note", "-", "Alone.");
    await trialled(t, lone);
    await adoptEntry(t.env, lone);
    await retireEntry(t.env, lone);
    assert.equal("guideNotes" in t.kernel.layers["@thetis/harness-core"], false, "the last note unsets the key");
  } finally {
    await t.done();
  }
});

test("config: adopt sets the key, retire unsets it or puts the old value back", async () => {
  const t = await fence();
  try {
    const id = await record(t, "config", "@thetis/harness-core maxRounds", "60");
    await trialled(t, id);
    await adoptEntry(t.env, id);
    assert.equal(t.kernel.layers["@thetis/harness-core"].maxRounds, 60);
    await retireEntry(t.env, id);
    assert.equal("maxRounds" in t.kernel.layers["@thetis/harness-core"], false);
    await t.kernel.config.set("@thetis/harness-core", "maxRounds", 30);
    const two = await record(t, "config", "@thetis/harness-core maxRounds", "60");
    assert.equal((await entry(t.home, two)).before, "30");
    await trialled(t, two);
    await adoptEntry(t.env, two);
    await retireEntry(t.env, two);
    assert.equal(t.kernel.layers["@thetis/harness-core"].maxRounds, 30);
  } finally {
    await t.done();
  }
});

test("project-instructions: adopt writes the file whole; retire restores or removes it", async () => {
  const t = await fence();
  try {
    const id = await record(t, "project-instructions", "p_0a1b2c3d", "New rules.");
    await trialled(t, id);
    await adoptEntry(t.env, id);
    assert.equal(await get(t.home, "projects/p_0a1b2c3d.md"), "New rules.\n");
    await retireEntry(t.env, id);
    assert.equal(await get(t.home, "projects/p_0a1b2c3d.md"), null);
  } finally {
    await t.done();
  }
});

test("re-check: an adopted entry whose owner moved gets a reason; adopting again after a trial clears it", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "thetis-packages", EDITED.trimEnd());
    await trialled(t, id);
    await adoptEntry(t.env, id);
    assert.equal(await recheckAdopted(t.home, { "@thetis/skills-thetis": "0.10.0" }), 0, "unchanged, nothing to say");
    assert.equal(await recheckAdopted(t.home, { "@thetis/skills-thetis": "0.11.0" }), 1);
    let e = await entry(t.home, id);
    assert.equal(e.state, "adopted");
    assert.equal(e.recheck.reason, "@thetis/skills-thetis changed 0.10.0 → 0.11.0 since adoption");
    assert.equal(await recheckAdopted(t.home, { "@thetis/skills-thetis": "0.11.0" }), 0, "said once");
    assert.equal(await get(t.home, "skills/thetis-packages/SKILL.md"), EDITED, "nothing is undone");
    // A re-check is answered with another trial; adopting again compares against what was applied.
    await trialled(t, id);
    e = await adoptEntry(t.env, id);
    assert.equal(e.recheck, null);
    assert.equal(e.applied.before, SHIPPED, "the first before is kept");
    assert.equal(e.versions["@thetis/skills-thetis"], "0.10.0", "the version adopted against is today's installed one");
  } finally {
    await t.done();
  }
});

test("reject: only before adoption, and not while a trial runs; misuse says why", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    await assert.rejects(rejectEntry(t.home, "nope"), /is not a proposal id/);
    await assert.rejects(rejectEntry(t.home, "L-000000"), /^Error: There is no proposal L-000000\.$/);
    await startTrial(t.env, settings, id);
    await assert.rejects(rejectEntry(t.home, id), /Its trial is still running/);
    await cancelTrial(t.env, id);
    const r = await rejectEntry(t.home, id);
    assert.equal(r.state, "rejected");
    await assert.rejects(rejectEntry(t.home, id), /already rejected/);
    await assert.rejects(adoptEntry(t.env, id), /^Error: It was rejected\.$/);
  } finally {
    await t.done();
  }
});

test("an adopted entry is trialled with the arms turned around: the base arm takes the change out", async () => {
  const t = await fence();
  try {
    const arms = async (id) => {
      await startTrial(t.env, settings, id);
      const a = t.kernel.operator.calls.at(-1).args.arms;
      await cancelTrial(t.env, id);
      return a;
    };
    const adopt = async (kind, target, change) => {
      const id = await record(t, kind, target, change);
      await trialled(t, id);
      await adoptEntry(t.env, id);
      return id;
    };
    // A new skill: the base arm deletes it.
    const fresh = await adopt("skill", "generated-files", SKILL.trimEnd());
    assert.deepEqual(await arms(fresh), [{ id: "base", change: { kind: "skill", id: "generated-files", path: "skills/generated-files/SKILL.md", content: null } }, { id: "change", change: null }]);
    // A shipped skill's override: deleted too, so the shipped one wins again.
    const shipped = await adopt("skill", "thetis-packages", EDITED.trimEnd());
    assert.deepEqual((await arms(shipped))[0].change, { kind: "skill", id: "thetis-packages", path: "skills/thetis-packages/SKILL.md", content: null });
    await retireEntry(t.env, shipped);
    // A home skill: its old text comes back.
    await put(t.home, "skills/home-one/SKILL.md", SHIPPED.replace(/thetis-packages/g, "home-one"));
    const home = await adopt("skill", "home-one", SHIPPED.replace(/thetis-packages/g, "home-one").replace("Old", "New").trimEnd());
    assert.deepEqual((await arms(home))[0].change.content, SHIPPED.replace(/thetis-packages/g, "home-one"));
    // Project instructions: none before, so the file goes.
    const pi = await adopt("project-instructions", "p_0a1b2c3d", "Rules.");
    assert.deepEqual((await arms(pi))[0].change, { kind: "project-instructions", project: "p_0a1b2c3d", content: null });
    // A guide note: the notes without it, as config.
    await t.kernel.config.set("@thetis/harness-core", "guideNotes", ["Be brief."]);
    const note = await adopt("guide-note", "-", "Ask first.");
    assert.deepEqual((await arms(note))[0].change, { kind: "config", package: "@thetis/harness-core", key: "guideNotes", value: ["Be brief."] });
    // Config: unset when the layer had nothing, restored when it had a value.
    const cfg = await adopt("config", "@thetis/harness-core maxRounds", "60");
    assert.deepEqual((await arms(cfg))[0].change, { kind: "config", package: "@thetis/harness-core", key: "maxRounds", value: null });
    await retireEntry(t.env, cfg);
    await t.kernel.config.set("@thetis/harness-core", "maxRounds", 30);
    const cfg2 = await adopt("config", "@thetis/harness-core maxRounds", "60");
    assert.deepEqual(await arms(cfg2), [{ id: "base", change: { kind: "config", package: "@thetis/harness-core", key: "maxRounds", value: 30 } }, { id: "change", change: null }]);
    // Back from the cancelled re-check trial, the entry is adopted again.
    assert.equal((await entry(t.home, cfg2)).state, "adopted");
  } finally {
    await t.done();
  }
});

test("writers in flight together lose nothing, across two instances of the module", async () => {
  const t = await fence();
  try {
    const dup = await import(`../lib/library.js?instance=${Date.now()}`);
    assert.notEqual(dup.updateLibrary, (await import("../lib/library.js")).updateLibrary, "a second module instance");
    const adopted = await record(t, "config", "@thetis/harness-core maxRounds", "60");
    await trialled(t, adopted);
    await adoptEntry(t.env, adopted);
    const others = [];
    for (let i = 0; i < 6; i++) others.push(await record(t, "guide-note", "-", `Note ${i}.`));
    const g = proposalOf("guide-note", "-", "Concurrent.");
    // Rejections from the place, a re-check from the sweep, new proposals and findings from reflections, at once.
    const [, , ...rest] = await Promise.all([
      recheckAdopted(t.home, { "@thetis/harness-core": "0.9.0" }),
      dup.sweepFindings(t.home, { "@thetis/tools-files": "9.0.0" }),
      ...others.slice(0, 3).map((id) => rejectEntry(t.home, id)),
      ...others.slice(3).map((id) => dup.rejectEntry(t.home, id)),
      ...Array.from({ length: 4 }, (_, i) => recordProposal(t.env, { proposal: g.proposal, conversation: { session: `s_cccc000${i}`, title: "x" }, rows: g.rows })),
      ...Array.from({ length: 4 }, (_, i) => dup.recordFindings(t.home, [{ package: "@thetis/tools-files", component: `c${i}`, what: "w", version: "0.4.0", events: [3], rows: [1] }], { session: `s_dddd000${i}` })),
    ]);
    void rest;
    const lib = await readLibrary(t.home);
    assert.equal(lib.entries.length, 1 + 6 + 4, "every new proposal is there");
    assert.ok(others.every((id) => lib.entries.find((e) => e.id === id).state === "rejected"), "every rejection held");
    assert.equal(lib.entries.find((e) => e.id === adopted).recheck.reason, "@thetis/harness-core changed 0.8.0 → 0.9.0 since adoption", "the re-check held");
    const { readFindings } = await import("../lib/library.js");
    assert.equal((await readFindings(t.home)).findings.length, 4, "every finding is there");
  } finally {
    await t.done();
  }
});

test("adopt refuses when the entry moved while the change was being applied", async () => {
  const t = await fence();
  try {
    const id = await record(t, "config", "@thetis/harness-core maxRounds", "60");
    await trialled(t, id);
    const set = t.kernel.config.set;
    let rejected;
    t.kernel.config.set = async (...args) => {
      rejected = rejectEntry(t.home, id);
      await rejected;
      return set(...args);
    };
    await assert.rejects(adoptEntry(t.env, id), /^Error: It became rejected while it was being adopted; the change was written to @thetis\/harness-core maxRounds all the same\. Look at it again\.$/);
    assert.equal((await entry(t.home, id)).state, "rejected");
  } finally {
    await t.done();
  }
});

test("an admin's trial names the person: from the caller, or from the userspace the home sits in", async () => {
  const { home: root, done } = await tempHome();
  try {
    const home = `${root}/userspaces/u1/home`;
    await put(home, "projects/p_0a1b2c3d.json", { id: "p_0a1b2c3d", name: "Nova" });
    const kernel = fakeKernel({ sessions: [sampleSession(S)], home, admin: true });
    const t = { home, kernel, env: { home, kernel } };
    const id = await record(t, "guide-note", "-", "Ask first.");
    // Through the place: uiCall's env carries the user, and the ops hand it on.
    const { uiCall } = await import("../index.js");
    const { data } = await uiCall({ op: "trial", id }, { cwd: home, kernel, user: "u1", config: {} });
    assert.match(data.trial, /^t_[0-9a-f]{8}$/);
    assert.equal(kernel.operator.calls.at(-1).args.user, "u1");
    await uiCall({ op: "trial-cancel", id }, { cwd: home, kernel, user: "u1", config: {} });
    assert.equal(kernel.operator.calls.at(-1).method, "host.trials.cancel");
    assert.equal(kernel.operator.calls.at(-1).args.user, "u1");
    // With no user on the env (the service, a hook), the userspace the home sits in names them.
    await startTrial({ home, kernel }, settings, id);
    assert.equal(kernel.operator.calls.at(-1).args.user, "u1");
    await cancelTrial({ home, kernel }, id);
    assert.equal(kernel.operator.calls.at(-1).args.user, "u1");
    // A home that names nobody, and a caller that does not either: the admin path refuses, as the kernel would.
    const lost = fakeKernel({ sessions: [sampleSession(S)], home: `${root}/elsewhere`, admin: true });
    const other = { home: `${root}/elsewhere`, kernel: lost, env: { home: `${root}/elsewhere`, kernel: lost } };
    const id2 = await record(other, "guide-note", "-", "Ask first.");
    await assert.rejects(startTrial(other.env, settings, id2), /name the person the trial is for \(user\)/);
  } finally {
    await done();
  }
});

test("trialUser: the caller's user wins, else the userspace in the home's path, else nobody", async () => {
  const { trialUser, forUser } = await import("../lib/library.js");
  assert.equal(trialUser({ home: "/opt/zero/data/userspaces/bit_muse/home" }), "bit_muse");
  assert.equal(trialUser({ home: "/x/userspaces/u1/home/", user: "u2" }), "u2");
  assert.equal(trialUser({ home: "/tmp/h" }), null);
  assert.deepEqual(forUser({ home: "/tmp/h" }, { trial: "t_00000001" }), { trial: "t_00000001" });
  assert.deepEqual(forUser({ home: "/x/userspaces/u1/home" }, { trial: "t_00000001" }), { user: "u1", trial: "t_00000001" });
});

test("a stopped re-trial keeps the verdict the last finished trial gave, with the stop beside it", async () => {
  const t = await fence();
  try {
    const id = await record(t, "skill", "generated-files", SKILL.trimEnd());
    const first = await trialled(t, id);
    const { trial: again } = await startTrial(t.env, settings, id);
    const e = await cancelTrial(t.env, id);
    assert.equal(e.state, "trialled");
    assert.equal(e.verdict.result, "helped", "the judged verdict stands");
    assert.equal(e.verdict.trial, first);
    assert.equal(e.lastTrial.why, "cancelled by you");
    assert.equal(e.lastTrial.trial, again);
  } finally {
    await t.done();
  }
});
