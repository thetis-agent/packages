// The outer runner against a fake inner (fixtures/fake-inner.js): the order of the runs, cost and the cap,
// timeouts, cancel, the isolation check, the files it writes, and the queue between two trials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTrialDir, runTrial } from "../lib/outer.js";
import { hostDir, lockPath, readTrial } from "../lib/store.js";
import { FAST, fakeCommand, scratchHome, writeTrial } from "./helpers.js";

const seen = (home, t, tag) => JSON.parse(readFileSync(join(hostDir(home, t), `${tag}.seen.json`), "utf8"));

test("parseTrialDir takes a person's trial directory apart and refuses anything else", () => {
  assert.deepEqual(parseTrialDir("/opt/zero/data/userspaces/ann/home/trials/t_0123abcd"), { home: "/opt/zero/data", user: "ann", t: "t_0123abcd" });
  for (const bad of ["/opt/zero/data/userspaces/ann/home/trials/x", "/opt/x/ann/home/trials/t_0123abcd", "/opt/zero/data/userspaces/ann/work/trials/t_0123abcd"]) {
    assert.throws(() => parseTrialDir(bad));
  }
});

test("the runs go base-1, change-1, base-2, change-2, each told the change and what is left of the cap", async () => {
  const home = scratchHome();
  try {
    const { t, dir } = writeTrial(home, "ann");
    const order = [];
    const trial = await runTrial(dir, { ...FAST, command: (p) => (order.push(p), fakeCommand({ default: { costs: [0.1] } })(p)) });
    assert.equal(trial.state, "done");
    assert.deepEqual(trial.runs.map((r) => `${r.arm}-${r.n}:${r.state}`), ["base-1:done", "change-1:done", "base-2:done", "change-2:done"]);
    assert.deepEqual(order.map((p) => p.split("/").pop()), ["base-1.run.json", "change-1.run.json", "base-2.run.json", "change-2.run.json"]);
    assert.equal(seen(home, t, "base-1").change, null);
    assert.deepEqual(seen(home, t, "change-1").change, { kind: "guide-note", note: "Check the tests first." });
    assert.deepEqual([1, 0.9, 0.8, 0.7], ["base-1", "change-1", "base-2", "change-2"].map((tag) => seen(home, t, tag).budgetUsd));
    assert.equal(trial.costUsd, 0.4);
    assert.deepEqual(trial.runs.map((r) => r.session), ["s_0a1", "s_0b1", "s_0a2", "s_0b2"]);
    // Both copies say the same; the run specs and scratch directories are gone; the lock is released.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "trial.json"), "utf8")), readTrial(home, t));
    assert.ok(!existsSync(join(hostDir(home, t), "base-1.run.json")) && !existsSync(join(hostDir(home, t), "ns-base-1")));
    assert.ok(!existsSync(lockPath(home)));
    const log = readFileSync(join(dir, "log.txt"), "utf8");
    assert.match(log, /base-1: a stray line on stdout/);
    assert.match(log, /trial t_[0-9a-f]{8}: done/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the files a run hands over land under <arm>-<n>/, and a path that climbs out is refused", async () => {
  const home = scratchHome();
  try {
    const { dir } = writeTrial(home, "ann", { runs: 1 });
    const files = { "record.json": "{}\n", "children/s_0c.json": "{}\n", "harness/turns/s_0a1.jsonl": "{}\n", "../escape.txt": "no", "/etc/x": "no" };
    await runTrial(dir, { ...FAST, command: fakeCommand({ default: { files } }) });
    for (const p of ["record.json", "children/s_0c.json", "harness/turns/s_0a1.jsonl", "isolation.json"]) assert.ok(existsSync(join(dir, "base-1", p)), p);
    assert.ok(!existsSync(join(dir, "escape.txt")) && !existsSync(resolve(dir, "../escape.txt")));
    assert.match(readFileSync(join(dir, "log.txt"), "utf8"), /refused a file from the run/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the cap: a run that spends past it is stopped as budget, and later runs do not start", async () => {
  const home = scratchHome();
  try {
    const { dir } = writeTrial(home, "ann", { costUsd: 0.5 });
    const trial = await runTrial(dir, { ...FAST, command: fakeCommand({ "base-1": { costs: [0.2] }, "change-1": { costs: [0.1, 0.2, 0.3, 0.4, 0.5], hang: true } }) });
    assert.deepEqual(trial.runs.map((r) => r.state), ["done", "budget", "budget", "budget"]);
    assert.ok(trial.runs[1].costUsd >= 0.3, String(trial.runs[1].costUsd));
    assert.ok(trial.costUsd >= 0.5);
    assert.match(trial.runs[2].error, /cost cap was spent/);
    assert.equal(trial.state, "done");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a run past its minutes and the grace is killed and counts as timeout; the next run still runs", async () => {
  const home = scratchHome();
  try {
    const { dir } = writeTrial(home, "ann", { runs: 1 });
    const trial = await runTrial(dir, { ...FAST, minuteMs: 100, graceMs: 100, stopGraceMs: 200, command: fakeCommand({ "base-1": { hang: true, ignoreCancel: true } }) });
    assert.deepEqual(trial.runs.map((r) => r.state), ["timeout", "done"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an inner that ends as timeout or failed is recorded as it said", async () => {
  const home = scratchHome();
  try {
    const { dir } = writeTrial(home, "ann", { runs: 1 });
    const trial = await runTrial(dir, { ...FAST, command: fakeCommand({ "base-1": { end: "timeout" }, "change-1": { end: "failed" } }) });
    assert.deepEqual(trial.runs.map((r) => r.state), ["timeout", "failed"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a sentinel visible outside fails the run and the trial, removes the sentinel, and runs nothing more", async () => {
  const home = scratchHome();
  try {
    const { t, dir } = writeTrial(home, "ann");
    const trial = await runTrial(dir, { ...FAST, command: fakeCommand({ default: { leak: true } }) });
    assert.equal(trial.state, "failed");
    assert.match(trial.error, /isolation check failed/);
    assert.deepEqual(trial.runs.map((r) => r.state), ["failed", "cancelled", "cancelled", "cancelled"]);
    assert.ok(!existsSync(join(hostDir(home, t), "ns-base-1", ".thetis-trial-sentinel-0123456789ab")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an isolation the inner could not make fails the trial with its sentence", async () => {
  const home = scratchHome();
  try {
    const { dir } = writeTrial(home, "ann");
    const trial = await runTrial(dir, { ...FAST, command: fakeCommand({ default: { failIsolation: "the trial could not isolate itself: mount failed" } }) });
    assert.equal(trial.state, "failed");
    assert.equal(trial.error, "the trial could not isolate itself: mount failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a cancel mark stops the running run and cancels the rest", async () => {
  const home = scratchHome();
  try {
    const { t, dir } = writeTrial(home, "ann");
    const running = runTrial(dir, { ...FAST, command: fakeCommand({ default: { costs: [0.01], hang: true } }) });
    for (let i = 0; i < 200 && readTrial(home, t)?.runs[0].state !== "running"; i++) await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(hostDir(home, t), "cancel"), "now\n");
    const trial = await running;
    assert.equal(trial.state, "cancelled");
    assert.deepEqual(trial.runs.map((r) => r.state), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a trial whose directory the person removed stops, writes nothing back, and leaves no host copy", async () => {
  const home = scratchHome();
  try {
    const { t, dir } = writeTrial(home, "ann");
    const running = runTrial(dir, { ...FAST, command: fakeCommand({ default: { hang: true } }) });
    for (let i = 0; i < 200 && readTrial(home, t)?.runs[0].state !== "running"; i++) await new Promise((r) => setTimeout(r, 20));
    rmSync(dir, { recursive: true, force: true });
    await running;
    assert.ok(!existsSync(dir), "nothing recreated the forgotten directory");
    assert.ok(!existsSync(hostDir(home, t)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the queue: a second trial waits for the first to finish, then runs", async () => {
  const home = scratchHome();
  try {
    const a = writeTrial(home, "ann", { runs: 1 }, { queue: true });
    const b = writeTrial(home, "bob", { runs: 1 }, { queue: true });
    const opts = { ...FAST, skipEnqueue: true, alive: () => true };
    const first = runTrial(a.dir, { ...opts, command: fakeCommand({ default: { costs: [0.01, 0.01, 0.01, 0.01, 0.01] } }) });
    const second = runTrial(b.dir, { ...opts, command: fakeCommand({}) });
    const [ta, tb] = await Promise.all([first, second]);
    assert.equal(ta.state, "done");
    assert.equal(tb.state, "done");
    assert.ok(tb.startedAt >= ta.finishedAt, `the second started ${tb.startedAt}, after the first finished ${ta.finishedAt}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
