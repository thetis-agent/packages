// The four exports and the queue, without starting a runner: who may see which trial, what start refuses
// before writing anything, a lost runner, cancel, and the lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { cancel, forget, list, start, status } from "../index.js";
import { enqueue, hostDir, liveQueue, lockPath, readTrial, tryLock, unlock } from "../lib/store.js";
import { FAKE_INNER, START, code, fakeEnv, scratchHome, writeTrial } from "./helpers.js";

const self = (user, extra = {}) => ({ ...extra, user, actor: user, self: true });
/** A pid file naming this process, which the liveness check takes for a live runner only when told to. */
const claim = (home, t) => writeFileSync(join(hostDir(home, t), "pid"), `${process.pid}\n`);

test("status and list are pinned to the caller; another person's trial is not-found", async () => {
  const home = scratchHome();
  const { env } = fakeEnv(home);
  try {
    const a = writeTrial(home, "ann", {}, { createdAt: "2026-10-20T00:00:01.000Z" });
    const a2 = writeTrial(home, "ann", {}, { createdAt: "2026-10-20T00:00:02.000Z" });
    const b = writeTrial(home, "bob");
    assert.equal((await status(self("ann", { trial: a.t }), env)).id, a.t);
    await assert.rejects(status(self("bob", { trial: a.t }), env), code("not-found"));
    await assert.rejects(status(self("ann", { trial: "t_00000000" }), env), code("not-found"));
    await assert.rejects(status(self("ann", { trial: "../x" }), env), code("invalid"));
    assert.deepEqual((await list(self("ann"), env)).map((t) => t.id), [a2.t, a.t], "newest first");
    assert.deepEqual((await list(self("bob"), env)).map((t) => t.id), [b.t]);
    // A self call always names its caller; one that does not is refused, never answered for everyone.
    await assert.rejects(list({ self: true }, env), code("unauthorized"));
    // An admin may name anyone, or see everyone.
    assert.equal((await status({ trial: b.t, actor: "root" }, env)).user, "bob");
    assert.equal((await list({}, env)).length, 3);
    assert.deepEqual((await list({ user: "bob" }, env)).map((t) => t.id), [b.t]);
    await assert.rejects(status({ trial: b.t, user: "ann" }, env), code("not-found"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("start refuses a bad request before writing anything", async () => {
  const home = scratchHome();
  const { env, journal } = fakeEnv(home);
  try {
    await assert.rejects(start({ ...START, runs: 9, user: "ann" }, env), code("invalid"));
    await assert.rejects(start({ ...START }, env), code("invalid"), "an admin names the person");
    await assert.rejects(start({ ...START, user: "nobody" }, env), code("not-found"));
    await assert.rejects(start({ ...START, user: "_system" }, env), code("invalid"));
    await assert.rejects(start({ ...START, ...self("ann"), project: "p_0123abcd" }, env), code("not-found"), "the project must exist");
    const change = { kind: "project-instructions", project: "p_0123abcd", content: null };
    await assert.rejects(start({ ...START, ...self("ann"), arms: [{ id: "base", change }, { id: "change", change: null }] }, env), code("not-found"));
    writeFileSync(join(home, "thetis.config.json"), JSON.stringify({ fence: { sandbox: "none" } }));
    await assert.rejects(start({ ...START, ...self("ann") }, env), /bwrap sandbox/);
    assert.ok(!existsSync(join(home, "trials")) || !readdirSync(join(home, "trials")).some((n) => n.startsWith("t_")));
    assert.deepEqual(journal, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("start refuses a fourth trial of one person while three are waiting", async () => {
  const home = scratchHome();
  const { env } = fakeEnv(home);
  try {
    for (let i = 0; i < 3; i++) writeTrial(home, "ann");
    await assert.rejects(start({ ...START, ...self("ann") }, env), code("busy"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a trial whose runner is gone is failed when somebody looks", async () => {
  const home = scratchHome();
  const { env } = fakeEnv(home);
  try {
    const { t } = writeTrial(home, "ann");
    writeFileSync(join(hostDir(home, t), "pid"), "999999999\n");
    const trial = await status(self("ann", { trial: t }), env);
    assert.equal(trial.state, "failed");
    assert.match(trial.error, /runner stopped/);
    assert.ok(trial.runs.every((r) => r.state === "cancelled"));
    assert.equal(readTrial(home, t).state, "failed", "and the host's copy says so");
    // One that was just started and has not written its pid yet is left alone.
    const fresh = writeTrial(home, "ann");
    assert.equal((await status(self("ann", { trial: fresh.t }), env)).state, "queued");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cancel without a runner marks the trial and its runs cancelled; a finished trial is left as it is", async () => {
  const home = scratchHome();
  const { env, journal } = fakeEnv(home);
  try {
    const { t } = writeTrial(home, "ann");
    await assert.rejects(cancel(self("bob", { trial: t }), env), code("not-found"));
    const trial = await cancel(self("ann", { trial: t }), env);
    assert.equal(trial.state, "cancelled");
    assert.ok(trial.runs.every((r) => r.state === "cancelled"));
    assert.ok(existsSync(join(hostDir(home, t), "cancel")));
    assert.equal(journal[0].kind, "trial.cancel");
    assert.equal((await cancel(self("ann", { trial: t }), env)).state, "cancelled");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a finished trial the person forgot is dropped from the host as well", async () => {
  const home = scratchHome();
  const { env } = fakeEnv(home);
  try {
    const { t, dir } = writeTrial(home, "ann");
    await cancel(self("ann", { trial: t }), env);
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await list(self("ann"), env), []);
    assert.ok(!existsSync(hostDir(home, t)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the queue: first come first served, abandoned entries dropped, a dead holder's lock taken over", () => {
  const home = scratchHome();
  try {
    const a = writeTrial(home, "ann").t;
    const b = writeTrial(home, "bob").t;
    enqueue(home, a, Date.now() - 10);
    enqueue(home, b);
    const alive = () => true;
    assert.deepEqual(liveQueue(home, { alive }), [a, b]);
    assert.ok(!tryLock(home, b, 111, { alive }), "b is not first");
    assert.ok(tryLock(home, a, 111, { alive }));
    assert.ok(tryLock(home, a, 111, { alive }), "holding it already");
    // a's runner wrote its pid and died: its entry goes, and its lock is taken over by b.
    claim(home, a);
    const dead = (pid, t) => t !== a;
    assert.deepEqual(liveQueue(home, { alive: dead }), [b]);
    assert.ok(tryLock(home, b, 222, { alive: dead }));
    unlock(home, a);
    assert.ok(existsSync(lockPath(home)), "unlock releases only one's own lock");
    unlock(home, b);
    assert.ok(!existsSync(lockPath(home)));
    // An entry nobody claimed for a minute is abandoned.
    const c = writeTrial(home, "ann").t;
    enqueue(home, c, Date.now() - 61_000);
    assert.ok(!liveQueue(home, { alive }).includes(c));
    assert.ok(!readdirSync(resolve(home, "trials/queue")).some((n) => n.endsWith(c)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status drops a finished trial the person forgot, as list does", async () => {
  const home = scratchHome();
  const { env } = fakeEnv(home);
  try {
    const { t, dir } = writeTrial(home, "ann");
    await cancel(self("ann", { trial: t }), env);
    rmSync(dir, { recursive: true, force: true });
    await assert.rejects(status(self("ann", { trial: t }), env), code("not-found"));
    assert.ok(!existsSync(hostDir(home, t)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("forget removes both copies, only the caller's, and is idempotent", async () => {
  const home = scratchHome();
  const { env, journal } = fakeEnv(home);
  try {
    const { t, dir } = writeTrial(home, "ann", {}, { queue: true });
    await assert.rejects(forget(self("ann", { trial: "nope" }), env), code("invalid"));
    assert.deepEqual(await forget(self("bob", { trial: t }), env), { trial: t, removed: false });
    assert.ok(existsSync(hostDir(home, t)) && existsSync(dir), "another person's trial is untouched");
    assert.deepEqual(await forget(self("ann", { trial: t }), env), { trial: t, removed: true });
    assert.ok(!existsSync(hostDir(home, t)) && !existsSync(dir));
    assert.ok(!readdirSync(resolve(home, "trials/queue")).some((n) => n.endsWith(t)), "and its queue entry");
    assert.equal(journal.at(-1).kind, "trial.forget");
    assert.deepEqual(await forget(self("ann", { trial: t }), env), { trial: t, removed: false });
    assert.deepEqual(await forget({ trial: "t_00000000", actor: "root" }, env), { trial: "t_00000000", removed: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("forget of a running trial cancels it, waits for its runner, then removes it", async () => {
  const home = scratchHome();
  const { env } = fakeEnv(home);
  try {
    const { t, dir } = writeTrial(home, "ann", {}, { queue: true });
    const runner = spawn(process.execPath, [resolve(FAKE_INNER, "../fake-outer.js"), dir, JSON.stringify({ default: { hang: true } })], { stdio: "ignore" });
    writeFileSync(join(hostDir(home, t), "pid"), `${runner.pid}\n`);
    const exited = new Promise((r) => runner.once("exit", r));
    for (let i = 0; i < 300 && readTrial(home, t)?.runs[0].state !== "running"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(readTrial(home, t).runs[0].state, "running");
    assert.deepEqual(await forget(self("ann", { trial: t }), env), { trial: t, removed: true });
    await exited;
    assert.ok(!existsSync(hostDir(home, t)), "the host copy is gone");
    assert.ok(!existsSync(dir), "and the person's copy");
    assert.ok(!existsSync(lockPath(home)), "and the lock");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
