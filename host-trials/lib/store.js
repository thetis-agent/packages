// Where a trial's state lives. Two copies of `trial.json`:
// - the host's, under `<THETIS_HOME>/trials/<t>/`, which no fence can see. `status` and `list` answer from
//   it, so nothing a person's fence writes can change what the host believes about a trial; beside it are
//   the spec the runners read (`spec.json`), the outer runner's pid, its raw output, and the cancel mark.
// - the person's, under `<THETIS_HOME>/userspaces/<user>/home/trials/<t>/`, with every run's files, where
//   @thetis/reflections reads them from inside the fence. Written only through the jail (jail.js).
//
// And the host-wide queue: one trial runs at a time. `queue/<ms>-<t>` holds each trial waiting, in the
// order they were started; `lock` names the one running. An entry whose runner is gone is dropped by
// whoever looks next, and a lock whose holder is gone is taken over, so a daemon restart that killed a
// runner never wedges the queue.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { TRIAL_ID } from "./spec.js";
import { jail, userspaceRoot } from "./jail.js";

export const trialsRoot = (home) => resolve(home, "trials");
export const hostDir = (home, t) => resolve(trialsRoot(home), t);
export const queueDir = (home) => resolve(trialsRoot(home), "queue");
export const lockPath = (home) => resolve(trialsRoot(home), "lock");
/** The trial's directory in the person's home, relative to their userspace root (what the jail takes). */
export const personRel = (t) => `home/trials/${t}`;
/** The same directory as an absolute path, for the record and for a reader on the host. */
export const personDir = (home, user, t) => resolve(home, "userspaces", user, "home", "trials", t);

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export const readSpec = (home, t) => (TRIAL_ID.test(t) ? readJson(resolve(hostDir(home, t), "spec.json")) : null);
export const readTrial = (home, t) => (TRIAL_ID.test(t) ? readJson(resolve(hostDir(home, t), "trial.json")) : null);

/** Both copies of trial.json. The host's first: it is the one `status` trusts. */
export function saveTrial(home, trial) {
  writeJsonAtomic(resolve(hostDir(home, trial.id), "trial.json"), trial);
  savePersonFiles(home, trial.user, trial.id, [{ path: "trial.json", content: JSON.stringify(trial, null, 2) + "\n" }]);
}

/** Files into the person's trial directory, through the jail. `files` are `{path, content, append?}` relative to it. */
export function savePersonFiles(home, user, t, files) {
  if (!files.length) return [];
  const root = userspaceRoot(home, user);
  const ops = files.map((f) => ({ op: f.append ? "append" : "write", path: `${personRel(t)}/${f.path}`, content: f.content }));
  return jail(root, ops);
}

/** Every trial id the host knows. */
export function trialIds(home) {
  try {
    return readdirSync(trialsRoot(home)).filter((n) => TRIAL_ID.test(n));
  } catch {
    return [];
  }
}

// ---- runners ----

/** Whether `pid` is a live outer runner of trial `t`: alive, and its command line says so (a reused pid does not count). */
export function runnerAlive(pid, t) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e?.code !== "EPERM") return false;
  }
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmd.some((a) => a.endsWith("outer.js")) && cmd.some((a) => a.includes(t));
  } catch {
    return false;
  }
}

export const readPid = (home, t) => {
  try {
    return Number(readFileSync(resolve(hostDir(home, t), "pid"), "utf8").trim());
  } catch {
    return NaN;
  }
};

// ---- the queue ----

const ENTRY = /^(\d{13})-(t_[0-9a-f]{8})$/;
/** How long an entry may wait for its runner to write its pid before it counts as abandoned. */
const UNCLAIMED_MS = 60_000;

export function enqueue(home, t, now = Date.now()) {
  mkdirSync(queueDir(home), { recursive: true });
  const name = `${String(now).padStart(13, "0")}-${t}`;
  writeFileSync(resolve(queueDir(home), name), t + "\n");
  return name;
}

export function dequeue(home, t) {
  for (const name of queueNames(home)) if (ENTRY.exec(name)?.[2] === t) rmSync(resolve(queueDir(home), name), { force: true });
}

function queueNames(home) {
  try {
    return readdirSync(queueDir(home)).filter((n) => ENTRY.test(n)).sort();
  } catch {
    return [];
  }
}

/** The trials waiting or running, oldest first, after dropping every entry whose runner is gone. */
export function liveQueue(home, { alive = runnerAlive, now = Date.now() } = {}) {
  const live = [];
  for (const name of queueNames(home)) {
    const [, ms, t] = ENTRY.exec(name);
    const pid = readPid(home, t);
    const ok = Number.isNaN(pid) ? now - Number(ms) < UNCLAIMED_MS : alive(pid, t);
    if (ok) live.push(t);
    else rmSync(resolve(queueDir(home), name), { force: true });
  }
  return live;
}

/**
 * Takes the host-wide lock for `t` when `t` is first in the queue. True when held. A lock left by a runner
 * that is gone is taken over.
 */
export function tryLock(home, t, pid = process.pid, { alive = runnerAlive } = {}) {
  const live = liveQueue(home, { alive });
  if (live[0] !== t) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Written whole beside the lock, then linked into place: link fails when the lock exists, and a lock
    // that exists always has its holder in it, so nobody reads an empty one and takes it over as stale.
    const tmp = `${lockPath(home)}.${pid}.${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(tmp, JSON.stringify({ pid, trial: t }), { mode: 0o600 });
      linkSync(tmp, lockPath(home));
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const held = readJson(lockPath(home), {});
      if (held?.trial === t && held?.pid === pid) return true;
      if (held && alive(held.pid, held.trial)) return false;
      rmSync(lockPath(home), { force: true });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return false;
}

export function unlock(home, t) {
  const held = readJson(lockPath(home), null);
  if (held?.trial === t) rmSync(lockPath(home), { force: true });
}

export const cancelMarked = (home, t) => existsSync(resolve(hostDir(home, t), "cancel"));
