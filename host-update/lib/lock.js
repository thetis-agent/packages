// The update lock: `<home>/update/lock` exists for exactly as long as an update job runs, so everything that
// would restart or reload under a half-installed checkout can ask one question and refuse. The file holds who
// took it and when; its modification time is the job's heartbeat, touched every few seconds while it runs.
// A lock whose process is gone, or whose heartbeat stopped more than LOCK_STALE_MS ago, has nothing behind
// it any more: the next update breaks it and says so in its record.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { HostError } from "./error.js";

/** A heartbeat older than this means the job that held the lock is gone. */
export const LOCK_STALE_MS = 30 * 60_000;

export const lockFile = (home) => join(home, "update", "lock");

/** Whether a process with this id still exists. `EPERM` means it does, under another user. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * The lock as it stands: null when there is none, else `{ pid, by, startedAt, beatAt, live }`. `live` is false
 * when the process that took it is gone or its heartbeat is older than LOCK_STALE_MS.
 */
export function readLock(home, now = Date.now()) {
  const file = lockFile(home);
  if (!existsSync(file)) return null;
  let held = {};
  try {
    held = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    held = {}; // Half-written, or not ours: the heartbeat still says whether anything is behind it.
  }
  let beat = 0;
  try {
    beat = statSync(file).mtimeMs;
  } catch {
    return null; // Released between the two calls.
  }
  const live = now - beat < LOCK_STALE_MS && (held.pid === process.pid || alive(held.pid));
  return { pid: held.pid ?? null, by: held.by ?? null, startedAt: held.startedAt ?? null, beatAt: new Date(beat).toISOString(), live };
}

/** True while an update job holds the lock. */
export function updating(home) {
  return readLock(home)?.live === true;
}

/** The refusal every restart and reload path gives while the lock is held. */
export const UPDATING = "An update is installing; Thetis restarts by itself when it is done.";

/**
 * Takes the lock for a job, atomically, so two admins pressing the button at once start one update. A live
 * lock refuses with `busy`; a dead one is broken and the answer says so, for the new job's record.
 */
export function takeLock(home, by) {
  const file = lockFile(home);
  mkdirSync(dirname(file), { recursive: true });
  let note = null;
  const held = readLock(home);
  if (held?.live) throw new HostError(`${UPDATING} It was started ${held.startedAt ?? "earlier"}${held.by ? ` by ${held.by}` : ""}.`, "busy");
  if (held) {
    note = `An earlier update's lock (started ${held.startedAt ?? "at an unknown time"}${held.by ? ` by ${held.by}` : ""}, last heard from ${held.beatAt}) had nothing behind it any more and was broken.`;
    try {
      unlinkSync(file);
    } catch {
      // Gone already: another caller broke it first, and `wx` below decides which of us runs.
    }
  }
  let fd;
  try {
    fd = openSync(file, "wx");
  } catch (err) {
    if (err?.code === "EEXIST") throw new HostError(`${UPDATING} Another update started a moment ago.`, "busy");
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, by, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return { note };
}

/** Moves the heartbeat on. A lock someone removed by hand is not put back: the job carries on without one. */
export function beat(home) {
  const now = new Date();
  try {
    utimesSync(lockFile(home), now, now);
  } catch {
    // Removed from outside; nothing to touch.
  }
}

export function releaseLock(home) {
  try {
    unlinkSync(lockFile(home));
  } catch {
    // Already gone.
  }
}
