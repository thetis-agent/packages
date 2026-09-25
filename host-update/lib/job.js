// The update itself: a few commands run one after another on the host, their output kept, and the whole
// written to one file as it goes, so a page can read where it stands and a daemon that restarted halfway
// finds the record rather than nothing. Only one runs at a time.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HostError } from "./error.js";

const OUTPUT_TAIL = 32 * 1024;
/** A running record older than this has no process behind it any more: the daemon restarted under it. */
export const STALE_AFTER_MS = 15 * 60_000;
const HEARTBEAT_MS = 2_000;

export const stateFile = (home) => join(home, "update", "last.json");

/** The last update's record, or null when none has ever run here. A record still `running` past STALE_AFTER_MS is answered as `interrupted`. */
export function readState(home, now = Date.now()) {
  const file = stateFile(home);
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state.state === "running" && now - Date.parse(state.updatedAt) > STALE_AFTER_MS) return { ...state, state: "interrupted", error: "the daemon stopped while the update was running; check the checkout on the host" };
    return state;
  } catch {
    return null;
  }
}

function writeState(home, state) {
  const file = stateFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** Where npm is: beside the node running this process, as a node tarball lays it out, else on PATH. */
export function npmPath() {
  const beside = resolve(dirname(process.execPath), "npm");
  return existsSync(beside) ? beside : "npm";
}

/** The environment a step runs with: the node running the daemon first on PATH, so npm finds it, and no prompts from git. */
export function stepEnv() {
  return { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, GIT_TERMINAL_PROMPT: "0", CI: "1" };
}

/** The commands an update runs, in order. `build` is off only in tests: an installation always rebuilds after a pull. */
export function updateSteps(root, { build = true, npm = npmPath() } = {}) {
  const steps = [
    { name: "pull the runtime", cmd: "git", args: ["-c", "protocol.file.allow=always", "pull", "--ff-only"], cwd: root },
    { name: "move packages to the pinned commit", cmd: "git", args: ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], cwd: root },
  ];
  if (build) {
    steps.push({ name: "install dependencies", cmd: npm, args: ["ci", "--no-audit", "--no-fund", "--loglevel=error"], cwd: root });
    steps.push({ name: "build", cmd: npm, args: ["run", "build"], cwd: root });
  }
  return steps;
}

/** Runs one command, feeding its output to `onOutput` as it comes; answers the exit code. */
function runStep(step, onOutput) {
  return new Promise((done) => {
    const child = spawn(step.cmd, step.args, { cwd: step.cwd, env: stepEnv(), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => onOutput(String(chunk)));
    child.stderr.on("data", (chunk) => onOutput(String(chunk)));
    child.on("error", (err) => {
      onOutput(`${step.cmd}: ${err.message}\n`);
      done(127);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

const tail = (text) => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text);

/**
 * Runs the steps, writing the record after every change and on a heartbeat while a step runs. `from` and
 * `after` describe the checkouts before and after: the record says what the update moved, not only that it ran.
 */
export async function runUpdate(home, steps, { from, after, log = () => {}, by = "operator" }) {
  const startedAt = new Date().toISOString();
  const state = { state: "running", by, startedAt, updatedAt: startedAt, finishedAt: null, ok: null, from, to: null, steps: steps.map((s) => ({ name: s.name, cmd: [s.cmd, ...s.args].join(" "), startedAt: null, finishedAt: null, code: null, output: "" })), error: null };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeState(home, state);
  };
  save();
  for (const [i, step] of steps.entries()) {
    const row = state.steps[i];
    row.startedAt = new Date().toISOString();
    save();
    log(`[update] ${step.name}: ${row.cmd}`);
    const beat = setInterval(save, HEARTBEAT_MS);
    try {
      row.code = await runStep(step, (chunk) => {
        row.output = tail(row.output + chunk);
      });
    } finally {
      clearInterval(beat);
    }
    row.finishedAt = new Date().toISOString();
    if (row.code !== 0) {
      state.state = "failed";
      state.ok = false;
      state.error = `${step.name} failed (exit ${row.code})`;
      break;
    }
  }
  if (state.state === "running") {
    state.state = "done";
    state.ok = true;
  }
  try {
    state.to = await after();
  } catch (err) {
    state.to = null;
    if (state.ok) state.error = `the update ran, but reading the checkout afterwards failed: ${err.message}`;
  }
  state.finishedAt = new Date().toISOString();
  save();
  log(`[update] ${state.state}${state.error ? `: ${state.error}` : ""}`);
  return state;
}

/** Refuses a second update while one is running: the record says so, and a live one is younger than STALE_AFTER_MS. */
export function assertNotRunning(home) {
  const last = readState(home);
  if (last?.state === "running") throw new HostError(`an update is already running, started ${last.startedAt}`, "busy");
}
