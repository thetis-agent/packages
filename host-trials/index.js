// Trials: one request run with and without one harness change, on the real Thetis, with every write going
// to RAM. A host package the daemon loads per call as `host.trials.<export>`. The kernel admits an admin
// or the operator to any export and a person to the ones the manifest lists in `thetis.host.self` -- all
// four -- pinning such a call to the caller with `args.self` set; here a self call is refused anything
// about anyone else, and an admin names the person with `args.user`.
//
// `start` checks the request, writes the trial (state `queued`) and starts a detached outer runner
// (lib/outer.js), which queues behind any other trial on the host and runs each run in its own namespace
// (lib/inner.js). `status` and `list` answer from the host's copy of trial.json, which no fence can write;
// `cancel` marks the trial and signals its runner.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/error.js";
import { hasBwrap, jail, userspaceRoot } from "./lib/jail.js";
import { newTrial, newTrialId, parseStart, RUN_TERMINAL, TERMINAL, TRIAL_ID } from "./lib/spec.js";
import { dequeue, enqueue, hostDir, liveQueue, personDir, personRel, readPid, readSpec, readTrial, runnerAlive, saveTrial, trialIds, unlock, writeJsonAtomic } from "./lib/store.js";

const OUTER = resolve(dirname(fileURLToPath(import.meta.url)), "lib/outer.js");
const SYSTEM_USER = "_system";
/** At most this many trials of one person queued or running, and this many on the host. */
const MAX_ACTIVE = { perUser: 3, host: 20 };
const LIST_MAX = 50;
/** How long `forget` waits for a running trial's runner to stop: the runner's own stop grace and some. */
const FORGET_WAIT_MS = 40_000;
/** How long a trial whose runner has not written its pid yet counts as starting rather than lost. */
const STARTING_MS = 60_000;

const isSelf = (args) => args.self !== undefined && args.self !== false && args.self !== "false";

/** The person a call is about: the pinned caller for a self call, else the user an admin names. */
function userOf(args, env, { required = true } = {}) {
  if (isSelf(args)) {
    assert(args.user, "a call about oneself names its caller as the user, and this one names nobody", "unauthorized");
    return String(args.user);
  }
  if (!args.user) {
    assert(!required, "name the person the trial is for (user)");
    return null;
  }
  const user = String(args.user);
  const rec = env.users.get(user);
  assert(rec, `unknown user: ${user}`, "not-found");
  assert(rec.role !== "system" && user !== SYSTEM_USER, "the system userspace runs no trials", "invalid");
  return user;
}

/** The trial `args.trial`, as the host holds it, when the caller may see it. Another person's is not-found. */
function ownTrial(args, env) {
  const t = String(args.trial ?? "");
  assert(TRIAL_ID.test(t), `trial must be a trial id (t_ and 8 hex digits): ${t}`);
  const spec = readSpec(env.home, t);
  const user = userOf(args, env, { required: false });
  assert(spec && (!user || spec.user === user), `no trial ${t}`, "not-found");
  const trial = reconcile(env, readTrial(env.home, t));
  assert(trial, `no trial ${t}`, "not-found");
  // The same sweep `list` makes: a finished trial the person forgot is gone from the host too.
  if (TERMINAL.has(trial.state) && forgotten(env, trial)) {
    rmSync(hostDir(env.home, t), { recursive: true, force: true });
    assert(false, `no trial ${t}`, "not-found");
  }
  return trial;
}

let preflight;
/** Whether this host can run a trial at all: bubblewrap, and user namespaces with mounts in them. */
function canRun() {
  if (preflight === undefined) {
    const userns = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--", "true"], { stdio: "ignore" }).status === 0;
    preflight = !hasBwrap() ? "trials need bubblewrap on this host" : !userns ? "trials need unprivileged user namespaces (unshare --user --mount) on this host" : null;
  }
  return preflight;
}

/** The configured sandbox, read from the file: a trial needs bwrap. */
function sandboxOf(home) {
  try {
    return JSON.parse(readFileSync(resolve(home, "thetis.config.json"), "utf8"))?.fence?.sandbox ?? "auto";
  } catch {
    return "auto";
  }
}

/**
 * A trial the host believes is queued or running whose runner is gone -- the daemon restarted, which ends
 * every process it started -- is failed here, where somebody is looking, rather than left running forever.
 */
function reconcile(env, trial) {
  if (!trial || TERMINAL.has(trial.state)) return trial;
  const pid = readPid(env.home, trial.id);
  const starting = Number.isNaN(pid) && Date.now() - Date.parse(trial.createdAt) < STARTING_MS;
  if (starting || runnerAlive(pid, trial.id)) return trial;
  trial.state = "failed";
  trial.error = "the trial runner stopped before the trial finished (was the daemon restarted?); start the trial again";
  for (const r of trial.runs) if (!RUN_TERMINAL.has(r.state)) r.state = r.state === "running" ? "failed" : "cancelled";
  trial.finishedAt = new Date().toISOString();
  try {
    saveTrial(env.home, trial);
  } catch (e) {
    env.log?.(`[trials] ${trial.id}: could not record that its runner is gone: ${e?.message ?? e}`);
  }
  return trial;
}

/** Whether the person removed the trial's directory from their home (forgetting the conversation it came from). */
function forgotten(env, trial) {
  try {
    lstatSync(personDir(env.home, trial.user, trial.id));
    return false;
  } catch (e) {
    return e?.code === "ENOENT";
  }
}

/** Every trial the host holds, or one person's, newest first; a finished one the person forgot is dropped for good. */
function trialsOf(env, user) {
  const out = [];
  for (const t of trialIds(env.home)) {
    const trial = readTrial(env.home, t);
    if (!trial || (user && trial.user !== user)) continue;
    if (TERMINAL.has(trial.state) && forgotten(env, trial)) {
      rmSync(hostDir(env.home, t), { recursive: true, force: true });
      continue;
    }
    out.push(reconcile(env, trial));
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Starts a trial: `{user?, session, request: {text}, project?, model, arms, runs, costUsd, minutes,
 * scratchMb}`. Answers `{trial}` at once; the runs happen in the background, one trial on the host at a time.
 */
export async function start(args, env) {
  const user = userOf(args, env);
  const spec = parseStart(args);
  const root = userspaceRoot(env.home, user);
  const changes = spec.arms.map((a) => a.change).filter(Boolean);
  const projects = [spec.project, ...changes.filter((c) => c.kind === "project-instructions").map((c) => c.project)].filter(Boolean);
  if (projects.length) {
    const [found] = jail(root, [{ op: "list", path: "home/projects" }]);
    const names = new Set(found?.ok ? found.value.map((e) => e.name) : []);
    for (const p of projects) assert(names.has(`${p}.json`), `project ${p} does not exist`, "not-found");
  }
  const active = trialsOf(env, null).filter((t) => !TERMINAL.has(t.state));
  assert(active.filter((t) => t.user === user).length < MAX_ACTIVE.perUser, `${user} already has ${MAX_ACTIVE.perUser} trials queued or running; wait for one or cancel it`, "busy");
  assert(active.length < MAX_ACTIVE.host && liveQueue(env.home).length < MAX_ACTIVE.host, "the host already has too many trials waiting; try again later", "busy");
  // What the host can do comes after what the request says: a bad request is refused the same everywhere.
  assert(sandboxOf(env.home) !== "none", "trials need the bwrap sandbox, and fence.sandbox is none", "unavailable");
  const why = canRun();
  assert(!why, why, "unavailable");

  const t = newTrialId();
  const host = hostDir(env.home, t);
  mkdirSync(host, { recursive: true, mode: 0o700 });
  const rwMounts = env.records.mounts.get(user).filter((m) => m.mode === "rw").map((m) => m.path);
  writeJsonAtomic(resolve(host, "spec.json"), { id: t, user, home: env.home, root: env.root, uid: process.getuid?.(), rwMounts, ...spec });
  const trial = newTrial({ id: t, user, spec });
  saveTrial(env.home, trial);
  enqueue(env.home, t);

  const out = openSync(resolve(host, "outer.out"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [OUTER, personDir(env.home, user, t)], { detached: true, stdio: ["ignore", out, out], env: process.env, cwd: host });
    child.unref();
    writeFileSync(resolve(host, "pid"), `${child.pid}\n`);
  } finally {
    closeSync(out);
  }
  env.journal({ kind: "trial.start", target: user, data: { trial: t, session: spec.session, changes: spec.arms.map((a) => a.change?.kind ?? null), runs: spec.runs, costUsd: spec.costUsd }, ...(args.actor ? { actor: String(args.actor) } : {}) });
  return { trial: t };
}

/** `{trial}` answers its trial.json. */
export async function status(args, env) {
  return ownTrial(args, env);
}

/** `{}` answers the person's trials, newest first, at most 50; an admin without `user` gets everyone's. */
export async function list(args, env) {
  return trialsOf(env, userOf(args, env, { required: false })).slice(0, LIST_MAX);
}

/** `{trial}` cancels it: the runner stops the running run and marks the rest. Answers the trial as it stands. */
export async function cancel(args, env) {
  const trial = ownTrial(args, env);
  if (TERMINAL.has(trial.state)) return trial;
  const host = hostDir(env.home, trial.id);
  writeFileSync(resolve(host, "cancel"), new Date().toISOString() + "\n");
  env.journal({ kind: "trial.cancel", target: trial.user, data: { trial: trial.id }, ...(args.actor ? { actor: String(args.actor) } : {}) });
  const pid = readPid(env.home, trial.id);
  if (runnerAlive(pid, trial.id)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone meanwhile
    }
    for (let i = 0; i < 20; i++) {
      const now = readTrial(env.home, trial.id);
      if (now && TERMINAL.has(now.state)) return now;
      await new Promise((r) => setTimeout(r, 250));
    }
    return readTrial(env.home, trial.id) ?? trial;
  }
  // No runner to tell: the trial never started or its runner is gone.
  trial.state = "cancelled";
  for (const r of trial.runs) if (!RUN_TERMINAL.has(r.state)) r.state = "cancelled";
  trial.finishedAt = new Date().toISOString();
  saveTrial(env.home, trial);
  return trial;
}

/**
 * `{trial}` forgets it: a queued or running trial is cancelled first and its runner waited for, then the
 * host's copy (`<THETIS_HOME>/trials/<t>/`, whose spec holds the request text) and the person's trial
 * directory are removed. For when @thetis/reflections forgets the conversation the trial came from.
 * Idempotent: a trial that is not there, or is not the caller's, answers `{trial, removed: false}`.
 */
export async function forget(args, env) {
  const t = String(args.trial ?? "");
  assert(TRIAL_ID.test(t), `trial must be a trial id (t_ and 8 hex digits): ${t}`);
  const spec = readSpec(env.home, t);
  const user = userOf(args, env, { required: false });
  if (!spec || (user && spec.user !== user)) return { trial: t, removed: false };
  const pid = readPid(env.home, t);
  if (runnerAlive(pid, t)) {
    writeFileSync(resolve(hostDir(env.home, t), "cancel"), new Date().toISOString() + "\n");
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone meanwhile
    }
    // The runner gives a cancelled run its grace to stop, then kills it; past that, it is killed itself.
    for (let i = 0; i < FORGET_WAIT_MS / 250 && runnerAlive(pid, t); i++) await new Promise((r) => setTimeout(r, 250));
    if (runnerAlive(pid, t)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone meanwhile
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  unlock(env.home, t);
  dequeue(env.home, t);
  rmSync(hostDir(env.home, t), { recursive: true, force: true });
  try {
    jail(userspaceRoot(env.home, spec.user), [{ op: "remove", path: personRel(t) }]);
  } catch (e) {
    env.log?.(`[trials] ${t}: could not remove the person's copy: ${e?.message ?? e}`);
  }
  env.journal({ kind: "trial.forget", target: spec.user, data: { trial: t }, ...(args.actor ? { actor: String(args.actor) } : {}) });
  return { trial: t, removed: true };
}
