// The outer runner: `node lib/outer.js <trial dir>`, started detached by `start`, running as the daemon's
// user outside any namespace. It waits its turn in the host-wide queue, runs every run of the trial in
// order (base-1, change-1, base-2, ...), each as a fresh inner runner in its own namespaces, and writes
// what each run produced into the real trial directory. It trusts nothing from the person's home: what to
// run comes from the host's copy of the spec (`<THETIS_HOME>/trials/<t>/spec.json`), and everything it
// writes into the home goes through the jail.
//
// It holds the trial's limits: the cost cap across every run (each run is told what is left of it), and
// each run's minutes, with a grace for booting and copying out after which the inner's process group is
// killed. A cancel -- a mark from `cancel`, or SIGTERM -- asks the inner to stop, then kills it.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseLine } from "./protocol.js";
import { checkRelative } from "./safe-fs.js";
import { newTrial, TRIAL_ID } from "./spec.js";
import { cancelMarked, dequeue, enqueue, hostDir, personDir, readSpec, readTrial, savePersonFiles, saveTrial, tryLock, unlock, writeJsonAtomic } from "./store.js";

const LIB = dirname(fileURLToPath(import.meta.url));
const INNER = resolve(LIB, "inner.js");
const UNSET = ["SSH_AUTH_SOCK", "DOCKER_HOST", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
/** The most one run may write into the person's home, and the most the log may hold. */
const RUN_BYTES = 256 * 1024 * 1024;
const LOG_BYTES = 4 * 1024 * 1024;
const SENTINEL = /^\.thetis-trial-sentinel-[0-9a-f]{12}$/;
const round = (n) => Math.round(n * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULTS = Object.freeze({
  /** On top of a run's minutes: the trial kernel's boot and the copy out. */
  graceMs: 120_000,
  /** How long a cancelled inner gets to stop its turn and copy out before its process group is killed. */
  stopGraceMs: 30_000,
  pollMs: 1000,
  flushMs: 1000,
  /** A minute, for the hard limit; a test makes it short. */
  minuteMs: 60_000,
});

/** The inner runner's command for one run spec: a fresh user, mount and pid namespace around node. */
export function innerCommand(runSpecPath) {
  return ["unshare", "--user", "--map-root-user", "--mount", "--propagation", "private", "--pid", "--fork", "--kill-child", "--mount-proc", "--", process.execPath, INNER, runSpecPath];
}

/** `<home>/userspaces/<user>/home/trials/<t>` taken apart. */
export function parseTrialDir(dir) {
  const parts = resolve(dir).split("/");
  const n = parts.length;
  const [t, trials, homeSeg, user, spaces] = [parts[n - 1], parts[n - 2], parts[n - 3], parts[n - 4], parts[n - 5]];
  if (!TRIAL_ID.test(t) || trials !== "trials" || homeSeg !== "home" || spaces !== "userspaces" || !user) throw new Error(`not a trial directory: ${dir}`);
  return { home: parts.slice(0, n - 5).join("/") || "/", user, t };
}

/**
 * Runs the trial whose directory in the person's home is `trialDir`. `opts` replaces the inner command
 * (`command(runSpecPath) => argv`), the timings, and `alive` for the queue, for tests.
 */
export async function runTrial(trialDir, opts = {}) {
  const o = { ...DEFAULTS, command: innerCommand, ...opts };
  const { home, user, t } = parseTrialDir(trialDir);
  const spec = readSpec(home, t);
  if (!spec || spec.id !== t || spec.user !== user) throw new Error(`no spec for trial ${t} of ${user}`);
  const host = hostDir(home, t);
  const trial = readTrial(home, t) ?? newTrial({ id: t, user, spec });
  const person = personDir(home, user, t);

  let cancelled = false;
  let forgotten = false;
  let current = null; // the running inner: {stop(why)}
  const pendingFiles = [];
  let logBuf = "";
  let logBytes = 0;
  let lastFlush = 0;
  const log = (text) => {
    const stamped = `${new Date().toISOString()} ${text}\n`;
    if (logBytes > LOG_BYTES) return;
    logBytes += stamped.length;
    logBuf += logBytes > LOG_BYTES ? "(the log is full; later lines are dropped)\n" : stamped;
  };

  const flush = (force = false) => {
    if (forgotten) return;
    if (!force && Date.now() - lastFlush < o.flushMs) return;
    lastFlush = Date.now();
    // The person removed the trial's directory (forgetting the conversation it came from): stop, and write nothing back.
    if (!existsSync(person)) {
      forgotten = true;
      cancelled = true;
      current?.stop("cancelled");
      return;
    }
    trial.costUsd = round(trial.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0));
    writeJsonAtomic(resolve(host, "trial.json"), trial);
    const files = [...pendingFiles.splice(0), { path: "trial.json", content: JSON.stringify(trial, null, 2) + "\n" }];
    if (logBuf) files.push({ path: "log.txt", content: logBuf, append: true });
    logBuf = "";
    try {
      for (const r of savePersonFiles(home, user, t, files)) if (!r.ok) process.stderr.write(`[trial ${t}] a file was not written: ${r.error}\n`);
    } catch (e) {
      process.stderr.write(`[trial ${t}] writing into the person's home failed: ${e?.message ?? e}\n`);
    }
  };

  const onCancel = () => {
    cancelled = true;
    current?.stop("cancelled");
  };
  process.on("SIGTERM", onCancel);
  process.on("SIGINT", onCancel);
  const watch = setInterval(() => {
    if (!cancelled && cancelMarked(home, t)) onCancel();
  }, o.pollMs);

  try {
    // Waiting in the queue: one trial on this host at a time.
    if (!o.skipEnqueue) enqueue(home, t);
    log(`trial ${t}: queued`);
    flush(true);
    while (!cancelled && !tryLock(home, t, process.pid, o.alive ? { alive: o.alive } : undefined)) await sleep(o.pollMs);
    if (!cancelled) {
      trial.state = "running";
      trial.startedAt = new Date().toISOString();
      log(`trial ${t}: running ${trial.runs.length} runs`);
      flush(true);
    }
    let failed = null;
    for (const run of trial.runs) {
      if (cancelled || failed) {
        run.state = "cancelled";
        continue;
      }
      const left = round(trial.capUsd - trial.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0));
      if (left <= 0) {
        run.state = "budget";
        run.error = "the trial's cost cap was spent before this run started";
        continue;
      }
      const arm = trial.arms.find((a) => a.id === run.arm);
      const result = await runOne({ o, spec, trial, run, arm, left, host, log, flush, pendingFiles, setCurrent: (c) => (current = c), isCancelled: () => cancelled });
      if (result.isolation) failed = result.error;
    }
    trial.state = cancelled ? "cancelled" : failed ? "failed" : "done";
    if (failed) trial.error = failed;
  } catch (e) {
    trial.state = "failed";
    trial.error = `the trial runner failed: ${e?.message ?? e}`;
    for (const r of trial.runs) if (r.state === "queued" || r.state === "running") r.state = r.state === "running" ? "failed" : "cancelled";
  } finally {
    clearInterval(watch);
    process.off("SIGTERM", onCancel);
    process.off("SIGINT", onCancel);
    trial.finishedAt = new Date().toISOString();
    log(`trial ${t}: ${trial.state}${trial.error ? `: ${trial.error}` : ""}`);
    if (forgotten) {
      rmSync(host, { recursive: true, force: true });
    } else {
      flush(true);
    }
    unlock(home, t);
    dequeue(home, t);
    rmSync(resolve(host, "pid"), { force: true });
  }
  return trial;
}

/** One run: an inner runner from spawn to exit, and what it said. Answers `{isolation, error}`. */
async function runOne({ o, spec, trial, run, arm, left, host, log, flush, pendingFiles, setCurrent, isCancelled }) {
  const tag = `${run.arm}-${run.n}`;
  run.state = "running";
  run.startedAt = new Date().toISOString();
  log(`${tag}: starting (up to $${left} left of the cap, ${trial.minutes} minutes)`);
  flush(true);

  const ns = resolve(host, `ns-${tag}`);
  mkdirSync(ns, { recursive: true });
  const specPath = resolve(host, `${tag}.run.json`);
  writeJsonAtomic(specPath, {
    trial: trial.id, user: spec.user, home: spec.home, root: spec.root, uid: spec.uid, rwMounts: spec.rwMounts ?? [],
    arm: run.arm, n: run.n, change: arm?.change ?? null, request: trial.request, project: trial.project, model: trial.model,
    budgetUsd: left, minutes: trial.minutes, scratchMb: spec.scratchMb, ns,
  });

  const env = { ...process.env };
  for (const k of UNSET) delete env[k];
  const argv = o.command(specPath);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
  let outcome = null; // {state, error?}
  let isolation = null; // a sentence when the isolation failed
  let stopping = null;
  let killer = null;
  let written = 0;
  let sentinels = [];
  const send = (msg) => {
    try {
      child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // the inner is gone
    }
  };
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  const stop = (why) => {
    if (stopping || child.exitCode !== null) return;
    stopping = why;
    log(`${tag}: stopping (${why})`);
    send({ cancel: why });
    killer = setTimeout(kill, o.stopGraceMs);
  };
  setCurrent({ stop });
  if (isCancelled()) stop("cancelled");
  child.stdin.on("error", () => {});

  /** The sentinels the inner wrote: none may be visible here. One that is means the isolation failed. */
  const leaked = () => {
    const seen = sentinels.filter((p) => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    });
    for (const p of seen) rmSync(p, { force: true });
    return seen;
  };

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (text) => {
    const msg = parseLine(text);
    if (!msg) {
      if (text.trim()) log(`${tag}: ${text.slice(0, 2000)}`);
      return;
    }
    switch (msg.type) {
      case "isolated": {
        sentinels = Array.isArray(msg.sentinels) ? msg.sentinels.filter((p) => typeof p === "string" && p.startsWith("/") && SENTINEL.test(basename(p))) : [];
        const seen = leaked();
        pendingFiles.push({ path: `${tag}/isolation.json`, content: JSON.stringify({ overlays: msg.overlays, masked: msg.masked, docker: msg.docker, sentinels: sentinels.length }, null, 2) + "\n" });
        if (!sentinels.length || seen.length) {
          isolation = sentinels.length ? `the isolation check failed: ${seen.join(", ")} was visible outside the trial` : "the isolation check failed: the trial reported no sentinel";
          log(`${tag}: ${isolation}`);
          kill();
          return;
        }
        log(`${tag}: isolated (${(msg.overlays ?? []).length} overlays, ${(msg.masked ?? []).length} masks)`);
        send({ go: true });
        return;
      }
      case "session":
        if (typeof msg.id === "string") run.session = msg.id;
        flush(true);
        return;
      case "progress":
        account(run, msg);
        if (trial.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0) >= trial.capUsd) stop("budget");
        flush();
        return;
      case "file": {
        try {
          checkRelative(String(msg.path));
        } catch (e) {
          log(`${tag}: refused a file from the run: ${e.message}`);
          return;
        }
        const content = String(msg.content ?? "");
        written += content.length;
        if (written > RUN_BYTES) {
          log(`${tag}: the run wrote more than ${RUN_BYTES} bytes; ${msg.path} and later files are dropped`);
          return;
        }
        pendingFiles.push({ path: `${tag}/${msg.path}`, content });
        return;
      }
      case "end":
        account(run, msg);
        outcome = { state: String(msg.state), ...(msg.error ? { error: String(msg.error) } : {}) };
        return;
      case "fail":
        if (msg.isolation) isolation = String(msg.error);
        outcome = { state: "failed", error: String(msg.error) };
        return;
    }
  });
  createInterface({ input: child.stderr }).on("line", (text) => {
    if (text.trim()) log(`${tag}: ${text.slice(0, 2000)}`);
  });

  const hard = setTimeout(() => {
    log(`${tag}: past ${trial.minutes} minutes and the grace; killing it`);
    stopping ??= "timeout";
    kill();
  }, trial.minutes * o.minuteMs + o.graceMs);

  const exit = await new Promise((done) => child.once("close", (code, signal) => done({ code, signal })));
  clearTimeout(hard);
  clearTimeout(killer);
  setCurrent(null);
  await new Promise((r) => setImmediate(r));
  // Once more, with the namespace gone: a sentinel that is here now got out.
  const late = leaked();
  if (late.length && !isolation) isolation = `the isolation check failed: ${late.join(", ")} was visible outside the trial`;

  if (isolation) {
    run.state = "failed";
    run.error = isolation;
  } else if (outcome && ["done", "failed", "cancelled", "budget", "timeout"].includes(outcome.state)) {
    run.state = outcome.state;
    if (outcome.error) run.error = outcome.error;
  } else if (stopping) {
    run.state = stopping;
  } else {
    run.state = "failed";
    run.error = `the trial runner stopped without a result (${exit.signal ?? `exit ${exit.code}`})`;
  }
  run.finishedAt = new Date().toISOString();
  log(`${tag}: ${run.state}${run.error ? `: ${run.error}` : ""} ($${run.costUsd ?? 0}, ${run.tokens ?? 0} tokens)`);
  flush(true);
  rmSync(specPath, { force: true });
  rmSync(ns, { recursive: true, force: true });
  return { isolation: !!isolation, error: isolation };
}

function account(run, msg) {
  const cost = Number(msg.costUsd);
  const tokens = Number(msg.tokens);
  if (Number.isFinite(cost) && cost >= 0) run.costUsd = round(cost);
  if (Number.isFinite(tokens) && tokens >= 0) run.tokens = tokens;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  try {
    await runTrial(dir);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`trial runner: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
