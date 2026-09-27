// The exports against real repositories: two bare origins, a runtime whose packages submodule pins one
// commit of the packages repository, and a clone of that runtime standing in for an installation, with a
// data directory in which two people have workspaces. Then the origins move on, and the checks and the
// update job are held to what git says. npm is a shell script that records its arguments and fails on cue;
// the smoke check is the real one, a child node importing the entries this fake installation runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as update from "../index.js";
import { NO_RESTART, readState, stateFile } from "../lib/job.js";
import { LOCK_STALE_MS, lockFile, readLock, takeLock } from "../lib/lock.js";
import { staleDaemon } from "../lib/stale.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const put = (dir, file, text) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const commitFiles = (dir, files, message) => {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) git(dir, "rm", "-q", file);
    else {
      put(dir, file, text);
      git(dir, "add", file);
    }
  }
  git(dir, "commit", "-q", "-m", message);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const GREET = JSON.stringify({ name: "@t/greet", version: "1.0.0", type: "module", main: "index.js", thetis: { type: "tool" } });

/**
 * An installation: a clone of a runtime origin whose packages submodule pins the packages origin, the two
 * working clones the maintainer pushes from, a built entry for the smoke check, a fake npm, and a home in
 * which `u1` and `u2` have `@t/greet` installed from the shipped packages and `u3` has nothing.
 */
function installation() {
  const base = mkdtempSync(join(tmpdir(), "thetis-host-update-"));
  const originPackages = join(base, "packages.git");
  const originRuntime = join(base, "runtime.git");
  git(base, "init", "-q", "--bare", "-b", "main", originPackages);
  git(base, "init", "-q", "--bare", "-b", "main", originRuntime);
  const packagesWork = join(base, "packages-work");
  git(base, "init", "-q", "-b", "main", packagesWork);
  commitFiles(packagesWork, { "hello.txt": "1\n", "greet/package.json": GREET, "greet/index.js": "export const hi = 1;\n" }, "packages: hello 1");
  git(packagesWork, "push", "-q", "-u", originPackages, "main");
  git(packagesWork, "remote", "add", "origin", originPackages);
  const runtimeWork = join(base, "runtime-work");
  git(base, "init", "-q", "-b", "main", runtimeWork);
  git(runtimeWork, "submodule", "add", "-q", originPackages, "packages");
  commitFiles(runtimeWork, { "runtime.txt": "1\n", "src/a.ts": "export const a = 1;\n", ".gitignore": "dist/\n" }, "runtime 1");
  git(runtimeWork, "push", "-q", "-u", originRuntime, "main");
  git(runtimeWork, "remote", "add", "origin", originRuntime);
  const root = join(base, "installed", "runtime");
  mkdirSync(join(base, "installed"));
  git(base, "clone", "-q", "--recurse-submodules", originRuntime, root);
  put(root, "dist/src/index.js", "export const runtime = true;\n");
  const home = join(base, "data");
  for (const user of ["u1", "u2", "u3"]) mkdirSync(join(home, "userspaces", user, "store", "node_modules", "@t"), { recursive: true });
  for (const user of ["u1", "u2"]) symlinkSync(join(root, "packages", "greet"), join(home, "userspaces", user, "store", "node_modules", "@t", "greet"));
  const npmLog = join(base, "npm.log");
  const npm = join(base, "npm");
  writeFileSync(npm, `#!/bin/sh\necho "$*" >> ${npmLog}\nif [ "$1" = run ] && { [ -f "$PWD/FAIL_BUILD" ] || [ -f "$PWD/.fail-always" ]; }; then echo "build broke" >&2; exit 2; fi\nexit 0\n`);
  chmodSync(npm, 0o755);
  const journal = [];
  const reloads = [];
  const restarts = [];
  const env = {
    home,
    root,
    users: { get: () => undefined, list: () => [] },
    records: {},
    journal: (row) => void journal.push(row),
    reloadFence: async (user, opts) => void reloads.push([user, opts?.drain ? "drain" : "idle"]),
    restart: async (reason, by) => {
      restarts.push({ reason, by });
      return { state: "armed", message: `A restart is armed: ${reason} (asked by ${by}).` };
    },
    log: () => {},
  };
  const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n") : []);
  return { base, root, home, env, journal, reloads, restarts, npm, npmCalls, packagesWork, runtimeWork, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** The maintainer changes packages, pins the new commit in the runtime, and pushes both. `runtimeFiles` go into the pinning commit too. */
function upstreamMoves({ packagesWork, runtimeWork }, packageFiles = { "hello.txt": "2\n" }, runtimeFiles = {}) {
  commitFiles(packagesWork, packageFiles, "packages: change");
  git(packagesWork, "push", "-q", "origin", "main");
  git(join(runtimeWork, "packages"), "pull", "-q", "--ff-only", "origin", "main");
  git(runtimeWork, "add", "packages");
  git(runtimeWork, "commit", "-q", "-m", "packages: pin");
  if (Object.keys(runtimeFiles).length) commitFiles(runtimeWork, runtimeFiles, "runtime: change");
  git(runtimeWork, "push", "-q", "origin", "main");
}

/** Only the runtime moves. */
function runtimeMoves({ runtimeWork }, files) {
  commitFiles(runtimeWork, files, "runtime: change");
  git(runtimeWork, "push", "-q", "origin", "main");
}

async function finished(home) {
  for (let i = 0; i < 400; i++) {
    const state = readState(home);
    if (state && state.state !== "running") return state;
    await sleep(50);
  }
  throw new Error("the update did not finish");
}

const head = (dir) => git(dir, "rev-parse", "HEAD");

test("check: where the two checkouts stand, what an update needs, and who it reaches", async () => {
  const t = installation();
  try {
    const fresh = await update.check({}, t.env);
    assert.deepEqual([fresh.runtime.branch, fresh.runtime.upstream, fresh.runtime.behind, fresh.runtime.dirty, fresh.behind, fresh.dirty, fresh.updating], ["main", "origin/main", 0, false, false, false, false]);
    assert.deepEqual(fresh.needs, { restart: false, reload: [], why: [] });
    assert.deepEqual(fresh.incoming, []);
    assert.equal(fresh.last, null, "nothing has been updated here yet");
    assert.equal(fresh.fetchedAt, undefined, "nothing has been fetched from here yet");
    assert.match(fresh.beyond, /install\.sh/);
    // Only a shipped package that u1 and u2 run changes: no restart, those two reload.
    upstreamMoves(t, { "greet/index.js": "export const hi = 2;\n" });
    assert.equal((await update.check({}, t.env)).behind, false, "without a fetch the answer is the last fetch's");
    const seen = await update.check({ fetch: true }, t.env);
    assert.equal(seen.behind, true);
    assert.deepEqual(seen.incoming.map((c) => [c.repo, c.subject]), [["runtime", "packages: pin"], ["packages", "packages: change"]]);
    assert.deepEqual(seen.needs, { restart: false, reload: ["u1", "u2"], why: [] });
    assert.ok(seen.fetchedAt, "a real fetch is recorded");
    // A change to the runtime's own code needs a restart, and says which file.
    runtimeMoves(t, { "src/a.ts": "export const a = 2;\n" });
    const code = await update.check({ fetch: true }, t.env);
    assert.equal(code.needs.restart, true);
    assert.deepEqual(code.needs.why, ["src/a.ts"]);
    assert.deepEqual(code.needs.reload, ["u1", "u2"], "the reload list is still computed, so the page can say who is affected");
    // Local changes are named, the submodule's under packages/.
    writeFileSync(join(t.root, "runtime.txt"), "edited\n");
    writeFileSync(join(t.root, "packages", "hello.txt"), "edited\n");
    const dirty = await update.check({}, t.env);
    assert.equal(dirty.dirty, true);
    assert.deepEqual(dirty.dirtyFiles.sort(), ["packages", "packages/hello.txt", "runtime.txt"]);
  } finally {
    t.cleanup();
  }
});

test("check: fetch 'stale' reaches the remotes at most once per half hour for the whole installation", async () => {
  const t = installation();
  try {
    const first = await update.check({ fetch: "stale" }, t.env);
    assert.ok(first.fetchedAt, "the first stale check fetches");
    upstreamMoves(t);
    const second = await update.check({ fetch: "stale" }, t.env);
    assert.equal(second.behind, false, "inside the half hour nothing is fetched, so the new commits are not seen");
    assert.equal(second.fetchedAt, first.fetchedAt);
    const file = join(t.home, "update", "fetched.json");
    writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - update.FETCH_EVERY_MS - 1000).toISOString(), ok: true }));
    const third = await update.check({ fetch: "stale" }, t.env);
    assert.equal(third.behind, true, "once the last fetch is older than half an hour, a stale check fetches");
    assert.notEqual(third.fetchedAt, first.fetchedAt);
    // A failed fetch is tried again after five minutes, not thirty.
    writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - update.FETCH_RETRY_MS - 1000).toISOString(), ok: false, error: "no network" }));
    assert.notEqual((await update.check({ fetch: "stale" }, t.env)).fetchedAt, undefined);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).ok, true);
  } finally {
    t.cleanup();
  }
});

test("apply then:'restart' with only packages changed: installs, checks, and reloads the affected workspaces with drain, the admin's own last", async () => {
  const t = installation();
  try {
    upstreamMoves(t, { "greet/index.js": "export const hi = 2;\n" });
    const started = await update.apply({ then: "restart", actor: "u1" }, t.env, { npm: t.npm });
    assert.equal(started.state, "started");
    assert.equal(started.last.state, "running");
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.phase, done.ok, done.error, done.by, done.then], ["done", "done", true, null, "u1", "restart"]);
    assert.deepEqual(done.steps.map((s) => [s.name, s.ok]), [["download", true], ["pull the runtime", true], ["move packages to the pinned commit", true], ["install dependencies", true], ["build", true], ["check the new version loads", true]]);
    assert.equal(done.steps[3].skipped, true, "no dependency changed, so npm ci did not run");
    assert.deepEqual(t.npmCalls(), ["run build"]);
    assert.match(done.steps[5].tail, /imported \d+ entries: .*@thetis\/runtime.*@t\/greet/);
    assert.ok(done.steps.every((s) => typeof s.ms === "number"));
    assert.deepEqual(done.needs, { restart: false, reload: ["u1", "u2"], why: [] });
    assert.deepEqual(t.reloads, [["u2", "drain"], ["u1", "drain"]], "the admin who pressed the button is reloaded last");
    assert.deepEqual(done.reloaded, [{ user: "u2", ok: true }, { user: "u1", ok: true }]);
    assert.deepEqual(t.restarts, [], "no restart when the daemon's code did not change");
    assert.equal(readFileSync(join(t.root, "packages", "greet", "index.js"), "utf8"), "export const hi = 2;\n");
    assert.equal(existsSync(lockFile(t.home)), false, "the lock goes with the job");
    assert.deepEqual(t.journal.map((r) => [r.kind, r.actor]), [["update.start", "u1"], ["update.done", "u1"]]);
    assert.deepEqual(await update.progress({}, t.env), readState(t.home));
  } finally {
    t.cleanup();
  }
});

test("apply then:'restart' when the daemon's code changed: arms the restart through env.restart, reloads nothing", async () => {
  const t = installation();
  try {
    runtimeMoves(t, { "src/a.ts": "export const a = 2;\n", "package-lock.json": "{}\n" });
    await update.apply({ then: "restart", actor: "root" }, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.phase], ["done", "restarting"]);
    assert.deepEqual(done.needs.why, ["package-lock.json", "src/a.ts"]);
    assert.deepEqual(t.npmCalls(), ["ci --no-audit --no-fund --loglevel=error", "run build"], "the lock file changed, so npm ci ran");
    assert.equal(t.restarts.length, 1);
    assert.equal(t.restarts[0].by, "root");
    assert.match(t.restarts[0].reason, /^Update to [0-9a-f]{7} \(Thetis's own code changed: package-lock\.json, src\/a\.ts\)$/);
    assert.equal(done.restart.state, "armed");
    assert.deepEqual(t.reloads, [], "a restart reopens every fence; reloading first is wasted work");
    // Once a daemon started after the arming reads the record, the restart has happened.
    const later = readState(t.home, Date.now(), Date.now() + 1000);
    assert.deepEqual([later.phase, later.restart.fired], ["done", true]);
    // then: "none" leaves putting it into service to whoever asked.
    runtimeMoves(t, { "src/a.ts": "export const a = 3;\n" });
    await update.apply({}, t.env, { npm: t.npm });
    const quiet = await finished(t.home);
    assert.deepEqual([quiet.state, quiet.phase, quiet.then, quiet.needs.restart], ["done", "done", "none", true]);
    assert.equal(t.restarts.length, 1, "nothing restarted");
  } finally {
    t.cleanup();
  }
});

test("a daemon that cannot restart itself: the update is installed, and the record says the restart is by hand", async () => {
  const t = installation();
  try {
    delete t.env.restart;
    runtimeMoves(t, { "src/a.ts": "export const a = 2;\n" });
    await update.apply({ then: "restart" }, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.phase, done.restart.why], ["failed", "restarting", "unsupported"]);
    assert.match(done.error, /^The update is installed, but this Thetis version cannot restart itself from here yet/);
    assert.equal(readFileSync(join(t.root, "src", "a.ts"), "utf8"), "export const a = 2;\n", "the new code stays: it built and it loads");
    assert.deepEqual(await update.restart({ reason: "x" }, t.env), { state: "refused", why: "unsupported", message: NO_RESTART });
  } finally {
    t.cleanup();
  }
});

test("a failing build rolls the checkout back to where it was, and nothing restarts", async () => {
  const t = installation();
  try {
    const from = head(t.root);
    runtimeMoves(t, { "src/a.ts": "export const a = 2;\n", FAIL_BUILD: "1\n" });
    await update.apply({ then: "restart" }, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.phase, done.rollback], ["rolledback", "building", { ok: true }]);
    assert.match(done.error, /^build failed \(exit 2\)$/);
    assert.equal(done.rollingBack, undefined);
    assert.deepEqual(done.steps.map((s) => [s.name, s.ok]).slice(-4), [["build", false], ["roll back the runtime", true], ["roll back packages", true], ["rebuild the old version", true]]);
    assert.match(done.steps.find((s) => s.name === "build").tail, /build broke/);
    assert.equal(head(t.root), from, "the runtime is back at the commit it had");
    assert.equal(existsSync(join(t.root, "FAIL_BUILD")), false);
    assert.deepEqual(t.restarts, []);
    assert.deepEqual(t.journal.map((r) => r.kind), ["update.start", "update.rolledback"]);
    assert.equal(t.journal[1].data.error, done.error);
  } finally {
    t.cleanup();
  }
});

test("a new version that builds but does not load is caught by the smoke check and rolled back", async () => {
  const t = installation();
  try {
    const fromPackages = head(join(t.root, "packages"));
    upstreamMoves(t, { "greet/index.js": 'import "no-such-dependency";\nexport const hi = 2;\n' });
    await update.apply({ then: "restart" }, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.phase, done.rollback], ["rolledback", "checking", { ok: true }]);
    assert.match(done.error, /^the new version does not load: @t\/greet: Cannot find package 'no-such-dependency'/);
    assert.match(done.steps.find((s) => s.name === "check the new version loads").tail, /FAILS: @t\/greet/);
    assert.equal(head(join(t.root, "packages")), fromPackages, "the packages are back at the commit they had");
    assert.equal(readFileSync(join(t.root, "packages", "greet", "index.js"), "utf8"), "export const hi = 1;\n");
    assert.deepEqual(t.reloads, [], "nothing was put into service");
  } finally {
    t.cleanup();
  }
});

test("an entry already broken before the update does not hold the update hostage", async () => {
  const t = installation();
  try {
    put(t.root, "dist/src/index.js", 'import "missing-before";\n');
    upstreamMoves(t, { "greet/index.js": "export const hi = 2;\n" });
    await update.apply({ then: "none" }, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.equal(done.state, "done");
    assert.match(done.steps.at(-1).tail, /already failing before the update: @thetis\/runtime/);
  } finally {
    t.cleanup();
  }
});

test("a rollback that fails too says so, with the exact command for the host", async () => {
  const t = installation();
  try {
    const from = head(t.root);
    writeFileSync(join(t.root, ".fail-always"), "1\n");
    runtimeMoves(t, { "src/a.ts": "export const a = 2;\n" });
    await update.apply({ then: "restart" }, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.rollback.ok], ["failed", false]);
    assert.match(done.error, /^build failed/);
    assert.match(done.rollback.error, /The rollback failed too \(rebuild the old version failed \(exit 2\)\)/);
    assert.ok(done.rollback.command.includes(`cd ${t.root} && git reset --hard ${from} && git submodule update --init --recursive`), done.rollback.command);
    assert.equal(head(t.root), from, "the reset itself still happened");
    assert.deepEqual(t.journal.map((r) => r.kind), ["update.start", "update.fail"]);
  } finally {
    t.cleanup();
  }
});

test("the lock: a second apply is refused while one runs, check and restart see it, and a dead lock is broken with a note", async () => {
  const t = installation();
  try {
    takeLock(t.home, "root");
    assert.equal(readLock(t.home).live, true);
    await assert.rejects(update.apply({ then: "restart" }, t.env, { npm: t.npm }), (e) => e.code === "busy" && /An update is installing; Thetis restarts by itself when it is done\. It was started .* by root\./.test(e.message));
    assert.equal((await update.check({}, t.env)).updating, true);
    assert.deepEqual(await update.restart({ reason: "x" }, t.env), { state: "refused", why: "updating", message: update.UPDATING });
    assert.deepEqual(t.restarts, []);
    // A lock whose heartbeat stopped long ago has no job behind it.
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(lockFile(t.home), old, old);
    assert.equal(readLock(t.home).live, false);
    assert.equal((await update.check({}, t.env)).updating, false);
    upstreamMoves(t);
    await update.apply({}, t.env, { npm: t.npm });
    const done = await finished(t.home);
    assert.equal(done.state, "done");
    assert.match(done.note, /^An earlier update's lock \(started .* by root, last heard from .*\) had nothing behind it any more and was broken\./);
    // A lock taken by a process that is gone is dead at once.
    writeFileSync(lockFile(t.home), JSON.stringify({ pid: 2 ** 22 + 12345, by: "x", startedAt: new Date().toISOString() }));
    assert.equal(readLock(t.home).live, false);
  } finally {
    t.cleanup();
  }
});

test("a running record with no lock behind it is interrupted; nothing to update is done at once; local changes are refused", async () => {
  const t = installation();
  try {
    mkdirSync(join(t.home, "update"), { recursive: true });
    const old = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(stateFile(t.home), JSON.stringify({ state: "running", phase: "building", startedAt: old, updatedAt: old, steps: [] }));
    const seen = await update.progress({}, t.env);
    assert.equal(seen.state, "interrupted");
    assert.match(seen.error, /Thetis stopped while the update was running/);
    await update.apply({ then: "restart" }, t.env, { npm: t.npm });
    const current = await finished(t.home);
    assert.deepEqual([current.state, current.phase, current.needs.restart], ["done", "done", false]);
    assert.match(current.note, /already up to date/);
    assert.deepEqual(current.steps.map((s) => s.name), ["download"]);
    writeFileSync(join(t.root, "runtime.txt"), "edited\n");
    await assert.rejects(update.apply({}, t.env), (e) => e.code === "invalid" && /^Can't update: the server's copy has local changes \(runtime\.txt\)\. Commit or discard them on the host, then try again\.$/.test(e.message));
  } finally {
    t.cleanup();
  }
});

test("stale.daemon: code on disk newer than the running daemon, named by what changed", async () => {
  const t = installation();
  try {
    const past = new Date(Date.now() - 3600_000);
    const age = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (entry === ".git") continue;
        if (statSync(path).isDirectory()) age(path);
        utimesSync(path, past, past);
      }
    };
    age(t.root);
    const startedAt = Date.now() - 60_000;
    assert.deepEqual(await staleDaemon(t.root, t.home, startedAt), { daemon: false });
    put(t.root, "dist/src/kernel.js", "export {};\n");
    assert.deepEqual(await staleDaemon(t.root, t.home, startedAt), { daemon: true, why: ["Thetis's own code was rebuilt"] });
    age(t.root);
    put(t.root, "packages/host-x/package.json", JSON.stringify({ name: "@t/host-x", main: "index.js", thetis: { type: "host", host: { name: "x" } } }));
    // A host package is imported fresh, whole module graph and all, so a changed one never needs a restart.
    assert.deepEqual(await staleDaemon(t.root, t.home, startedAt), { daemon: false });
    put(t.root, "packages/host-x/README.md", "docs are not code\n");
    put(t.root, "packages/host-x/test/x.test.js", "tests are not loaded\n");
    assert.deepEqual(await staleDaemon(t.root, t.home, startedAt), { daemon: false });
    // What check answers, on a checkout rebuilt after this test process started.
    put(t.root, "dist/src/kernel.js", "export const k = 1;\n");
    assert.equal((await update.check({}, t.env)).stale.daemon, true);
    // restart() with no reason gives the stale reason to the latch.
    await update.restart({ actor: "root" }, t.env);
    assert.deepEqual(t.restarts, [{ reason: "Restart to finish: Thetis's own code was rebuilt since Thetis started", by: "root" }]);
  } finally {
    t.cleanup();
  }
});

test("a rollback's rebuild of the running code, or an update that touched no daemon code, is not 'Restart to finish'", async () => {
  const t = installation();
  try {
    // The installation as the daemon loaded it an hour ago; this test process stands in for that daemon.
    const past = new Date(Date.now() - 3600_000);
    const age = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (entry === ".git") continue;
        if (statSync(path).isDirectory()) age(path);
        utimesSync(path, past, past);
      }
    };
    age(t.root);
    // An npm whose build rewrites dist/, the way tsc does after a reset gives the sources new times.
    const npm = join(t.base, "npm-writes");
    writeFileSync(npm, `#!/bin/sh\nif [ "$1" = run ]; then mkdir -p "$PWD/dist/src" && echo "export const runtime = true;" > "$PWD/dist/src/index.js"; if [ -f "$PWD/FAIL_BUILD" ]; then echo "build broke" >&2; exit 2; fi; fi\nexit 0\n`);
    chmodSync(npm, 0o755);
    assert.equal((await update.check({}, t.env)).stale.daemon, false);
    runtimeMoves(t, { "src/a.ts": "export const a = 2;\n", FAIL_BUILD: "1\n" });
    await update.apply({ then: "restart" }, t.env, { npm });
    assert.equal((await finished(t.home)).state, "rolledback");
    assert.equal((await update.check({}, t.env)).stale.daemon, false, "the rebuilt files are the code the daemon runs");
    // An update of a shipped package only: the build rewrites dist/ with the same code, and nothing asks for a restart.
    upstreamMoves(t, { "greet/index.js": "export const hi = 2;\n" }, { "src/a.ts": "export const a = 1;\n", FAIL_BUILD: null });
    await update.apply({ then: "none" }, t.env, { npm });
    const done = await finished(t.home);
    assert.deepEqual([done.state, done.needs.restart, done.error], ["done", false, null]);
    assert.equal((await update.check({}, t.env)).stale.daemon, false);
    // A change by hand after that is newer than the mark, and is said.
    await sleep(20);
    put(t.root, "dist/src/kernel.js", "export const k = 2;\n");
    assert.deepEqual((await update.check({}, t.env)).stale, { daemon: true, why: ["Thetis's own code was rebuilt"] });
  } finally {
    t.cleanup();
  }
});
