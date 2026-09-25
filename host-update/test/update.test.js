// The exports against real repositories: two bare origins, a runtime whose packages submodule pins one
// commit of the packages repository, and a clone of that runtime standing in for an installation. Then the
// origins move on, and the checks and the update are held to what git says. npm is never run here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as update from "../index.js";
import { STALE_AFTER_MS, readState, stateFile, updateSteps } from "../lib/job.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const commitFile = (dir, file, text, message) => {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** An installation: a clone of a runtime origin whose packages submodule pins the packages origin, with the two working clones the maintainer pushes from. */
function installation() {
  const base = mkdtempSync(join(tmpdir(), "thetis-host-update-"));
  const originPackages = join(base, "packages.git");
  const originRuntime = join(base, "runtime.git");
  git(base, "init", "-q", "--bare", "-b", "main", originPackages);
  git(base, "init", "-q", "--bare", "-b", "main", originRuntime);
  const packagesWork = join(base, "packages-work");
  git(base, "init", "-q", "-b", "main", packagesWork);
  commitFile(packagesWork, "hello.txt", "1\n", "packages: hello 1");
  git(packagesWork, "push", "-q", "-u", originPackages, "main");
  git(packagesWork, "remote", "add", "origin", originPackages);
  const runtimeWork = join(base, "runtime-work");
  git(base, "init", "-q", "-b", "main", runtimeWork);
  git(runtimeWork, "submodule", "add", "-q", originPackages, "packages");
  commitFile(runtimeWork, "runtime.txt", "1\n", "runtime 1");
  git(runtimeWork, "push", "-q", "-u", originRuntime, "main");
  git(runtimeWork, "remote", "add", "origin", originRuntime);
  const root = join(base, "installed", "runtime");
  mkdirSync(join(base, "installed"));
  git(base, "clone", "-q", "--recurse-submodules", originRuntime, root);
  const home = join(base, "data");
  mkdirSync(home);
  const journal = [];
  const env = { home, root, users: { get: () => undefined, list: () => [] }, records: {}, journal: (row) => void journal.push(row), reloadFence: async () => {}, log: () => {} };
  return { base, root, home, env, journal, packagesWork, runtimeWork, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** The maintainer moves both origins on: a new packages commit, then the runtime pins it and changes a file of its own. */
function upstreamMoves({ packagesWork, runtimeWork }) {
  commitFile(packagesWork, "hello.txt", "2\n", "packages: hello 2");
  git(packagesWork, "push", "-q", "origin", "main");
  git(join(runtimeWork, "packages"), "pull", "-q", "--ff-only", "origin", "main");
  git(runtimeWork, "add", "packages");
  git(runtimeWork, "commit", "-q", "-m", "packages: hello 2");
  commitFile(runtimeWork, "runtime.txt", "2\n", "runtime 2");
  git(runtimeWork, "push", "-q", "origin", "main");
}

async function finished(home) {
  for (let i = 0; i < 200; i++) {
    const state = readState(home);
    if (state && state.state !== "running") return state;
    await sleep(50);
  }
  throw new Error("the update did not finish");
}

test("check: where the two checkouts stand, without reaching the remote and then with", async () => {
  const t = installation();
  try {
    const fresh = await update.check({}, t.env);
    assert.deepEqual([fresh.runtime.branch, fresh.runtime.upstream, fresh.runtime.behind, fresh.runtime.ahead, fresh.runtime.dirty, fresh.runtime.fetched], ["main", "origin/main", 0, 0, false, false]);
    assert.deepEqual([fresh.packages.behind, fresh.packages.pinned, fresh.packages.dirty], [0, fresh.packages.commit, false], "the submodule sits at the pin");
    assert.equal(fresh.last, null, "nothing has been updated here yet");
    assert.match(fresh.beyond, /install\.sh/);
    upstreamMoves(t);
    const stale = await update.check({}, t.env);
    assert.equal(stale.runtime.behind, 0, "without a fetch the answer is the last fetch's");
    const seen = await update.check({ fetch: true }, t.env);
    assert.deepEqual([seen.runtime.behind, seen.runtime.fetched, seen.runtime.incoming.map((c) => c.subject)], [2, true, ["runtime 2", "packages: hello 2"]]);
    assert.deepEqual([seen.packages.behind, seen.packages.incoming.map((c) => c.subject)], [1, ["packages: hello 2"]], "measured against the commit the runtime's upstream pins");
    assert.notEqual(seen.packages.pinned, seen.packages.commit);
  } finally {
    t.cleanup();
  }
});

test("apply: pulls the runtime, moves packages to the pin, records every step, journals the start and the end, and refuses what it must", async () => {
  const t = installation();
  try {
    assert.deepEqual(await update.apply({ build: false }, t.env), { state: "current", from: { runtime: (await update.check({}, t.env)).runtime.commit, packages: (await update.check({}, t.env)).packages.commit, runtimeBehind: 0, packagesBehind: 0 }, last: null }, "nothing behind: nothing runs");
    upstreamMoves(t);
    const started = await update.apply({ build: false, actor: "root" }, t.env);
    assert.equal(started.state, "started");
    assert.equal(started.last.state, "running");
    assert.deepEqual(started.last.steps.map((s) => s.name), ["pull the runtime", "move packages to the pinned commit"]);
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.ok, done.by, done.error], ["done", true, "root", null]);
    assert.deepEqual(done.steps.map((s) => s.code), [0, 0]);
    assert.equal(readFileSync(join(t.root, "runtime.txt"), "utf8"), "2\n");
    assert.equal(readFileSync(join(t.root, "packages", "hello.txt"), "utf8"), "2\n", "the submodule moved to the pinned commit");
    assert.equal(done.to.runtimeBehind, 0);
    assert.equal(done.to.packagesBehind, 0);
    assert.notEqual(done.to.runtime, done.from.runtime);
    assert.deepEqual(t.journal.map((r) => [r.kind, r.actor]), [["update.start", "root"], ["update.done", "root"]]);
    assert.deepEqual((await update.progress({}, t.env)).last.state, "done");
    assert.equal((await update.check({}, t.env)).last.state, "done", "check carries the record too");
    // A dirty checkout is refused: an update by hand is the only safe one then.
    writeFileSync(join(t.root, "runtime.txt"), "edited\n");
    await assert.rejects(update.apply({ build: false }, t.env), (e) => e.code === "invalid" && /uncommitted changes/.test(e.message));
    git(t.root, "checkout", "--", "runtime.txt");
    // A step that fails ends the run there, and the record says which and why.
    const steps = updateSteps(t.root, { build: true, npm: join(t.base, "no-such-npm") });
    assert.deepEqual(steps.map((s) => s.name), ["pull the runtime", "move packages to the pinned commit", "install dependencies", "build"]);
    const failed = await update.runUpdate(t.home, steps.slice(2, 3), { from: {}, after: async () => ({}) });
    assert.deepEqual([failed.state, failed.ok, failed.steps[0].code], ["failed", false, 127]);
    assert.match(failed.error, /install dependencies failed/);
    assert.match(failed.steps[0].output, /no-such-npm/);
  } finally {
    t.cleanup();
  }
});

test("a running record refuses a second update, and one the daemon died under is answered as interrupted", async () => {
  const t = installation();
  try {
    mkdirSync(join(t.home, "update"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(stateFile(t.home), JSON.stringify({ state: "running", startedAt: now, updatedAt: now, steps: [] }));
    await assert.rejects(update.apply({ build: false }, t.env), (e) => e.code === "busy");
    const old = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
    writeFileSync(stateFile(t.home), JSON.stringify({ state: "running", startedAt: old, updatedAt: old, steps: [] }));
    const seen = (await update.progress({}, t.env)).last;
    assert.equal(seen.state, "interrupted");
    assert.match(seen.error, /daemon stopped/);
    assert.equal(readState(t.home, Date.parse(old) + 1000).state, "running", "young enough, it is still running");
    assert.ok(existsSync(stateFile(t.home)));
  } finally {
    t.cleanup();
  }
});
