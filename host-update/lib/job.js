// The update itself, as one job on the host: download, install, build, check that the new version loads,
// roll back if any of that fails, and then put the new code into service -- a restart when the daemon's own
// code changed, else a reload of each workspace whose packages changed. Every command's output is kept and
// the whole is written to one record as it goes, so a page reads where it stands and a daemon that restarted
// halfway finds the record rather than nothing. The lock (`./lock.js`) is held for the job's whole life.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkouts } from "./checkout.js";
import { beat, readLock, releaseLock } from "./lock.js";
import { needsFor } from "./needs.js";
import { runSmoke, smokeAgainst, smokeEntries } from "./smoke.js";
import { daemonStartedAt } from "./stale.js";

const OUTPUT_TAIL = 16 * 1024;
const HEARTBEAT_MS = 2_000;
/** A record this young is still being written by a job that took the lock a moment ago; the lock may not show yet. */
const JUST_WRITTEN_MS = 10_000;

export const stateFile = (home) => join(home, "update", "last.json");

/** The sentence for a daemon that has no `HostEnv.restart`: the update is installed and the restart is by hand. */
export const NO_RESTART = "This Thetis version cannot restart itself from here yet. Restart it on the host with `thetis restart`, or `systemctl restart thetis-runtime`.";

const summary = (state) => ({ runtime: state.runtime.commit, packages: state.packages.commit, runtimeBehind: state.runtime.behind, packagesBehind: state.packages.behind });

/**
 * The last update's record, or null when none has ever run here. A record still `running` with no live lock
 * behind it is answered as `interrupted`: the process that ran it is gone. A record that armed a restart
 * which has since happened (this daemon started after it) is answered with `phase: "done"`.
 */
export function readState(home, now = Date.now(), startedAt = daemonStartedAt()) {
  const file = stateFile(home);
  const lock = readLock(home, now);
  if (!existsSync(file)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (state.state === "running" && !lock?.live && now - Date.parse(state.updatedAt) > JUST_WRITTEN_MS) {
    return { ...state, state: "interrupted", error: "Thetis stopped while the update was running. Check the checkout on the host (git status, then npm ci and npm run build) before updating again." };
  }
  if (state.phase === "restarting" && state.state === "done" && Date.parse(state.restart?.armedAt ?? "") < startedAt) {
    return { ...state, phase: "done", restart: { ...state.restart, fired: true } };
  }
  return state;
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

/** A step that runs one command and answers its exit code, feeding its output to `onOutput` as it comes. */
function command(cmd, args, cwd) {
  const shown = [cmd, ...args].join(" ");
  return {
    cmd: shown,
    run: (onOutput) =>
      new Promise((done) => {
        const child = spawn(cmd, args, { cwd, env: stepEnv(), stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk) => onOutput(String(chunk)));
        child.stderr.on("data", (chunk) => onOutput(String(chunk)));
        child.on("error", (err) => {
          onOutput(`${cmd}: ${err.message}\n`);
          done({ code: 127 });
        });
        child.on("close", (code) => done({ code: code ?? 1 }));
      }),
  };
}

const gitCmd = (cwd, ...args) => command("git", ["-c", "protocol.file.allow=always", ...args], cwd);

/** Several commands as one step, stopping at the first that fails. */
function sequence(...steps) {
  return {
    cmd: steps.map((s) => s.cmd).join(" && "),
    run: async (onOutput) => {
      for (const s of steps) {
        const out = await s.run(onOutput);
        if (out.code !== 0) return out;
      }
      return { code: 0 };
    },
  };
}

const tail = (text) => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text);

/**
 * Runs an update job to its end and answers the final record. `before` is the checkouts as `apply` found
 * them (clean, with an upstream). `hooks` replace the pieces a test cannot run for real: `npm` (the npm
 * binary) and `smoke(root, home, baseline)`.
 */
export async function runJob(env, { before, by = "operator", then = "none", note = null, hooks = {} }) {
  const { root, home } = env;
  const npm = hooks.npm ?? npmPath();
  const baselineOf = hooks.baseline ?? (async () => runSmoke(root, await smokeEntries(root, home), { env: stepEnv() }));
  const smoke = hooks.smoke ?? ((baseline) => smokeAgainst(root, home, baseline, { env: stepEnv() }));
  const log = env.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const record = { state: "running", phase: "fetching", then, by, startedAt, updatedAt: startedAt, finishedAt: null, ok: null, from: summary(before), to: null, needs: null, steps: [], error: null, ...(note ? { note } : {}) };
  const save = () => {
    record.updatedAt = new Date().toISOString();
    writeState(home, record);
  };
  const heartbeat = setInterval(() => {
    save();
    beat(home);
  }, HEARTBEAT_MS);

  /** Runs one step, recorded as `{ name, cmd, ok, ms, code, tail }`. Answers whether it succeeded. */
  const step = async (name, spec) => {
    const row = { name, cmd: spec.cmd, ok: null, ms: 0, code: null, tail: "" };
    record.steps.push(row);
    save();
    log(`[update] ${name}: ${spec.cmd}`);
    const t0 = Date.now();
    const out = await spec.run((chunk) => {
      row.tail = tail(row.tail + chunk);
    });
    row.ms = Date.now() - t0;
    row.code = out.code;
    row.ok = out.code === 0;
    if (out.error) row.error = out.error;
    save();
    return row.ok ? null : out.error ?? `${name} failed (exit ${out.code})`;
  };
  /** A step recorded as done without running anything, with the reason in its tail. */
  const skipped = (name, why) => {
    record.steps.push({ name, cmd: "", ok: true, ms: 0, code: 0, tail: why, skipped: true });
    save();
  };
  /** A step whose work is a function answering `{ ok, error?, output }`. */
  const check = (fn) => ({
    cmd: "node (import every entry)",
    run: async (onOutput) => {
      const out = await fn();
      onOutput(out.output ?? "");
      return { code: out.ok ? 0 : 1, error: out.error };
    },
  });

  const fromRuntime = before.runtime.head;
  const fromPackages = before.packages.head;
  let changed = false; // whether the checkout has moved, so a failure from here on must be rolled back
  let installed = false; // whether npm ci ran, so a rollback runs it again
  let built = false; // whether the build ran, so a rollback builds again
  try {
    save();
    const download = sequence(gitCmd(root, "fetch", "--tags", "origin"), gitCmd(resolve(root, "packages"), "fetch", "origin"));
    let failed = await step("download", download);
    if (failed) return finish("failed", `Couldn't reach the update source: ${lastLine(record)}. Nothing changed.`);
    const fetched = await checkouts(root);
    record.from = summary(fetched);
    if (fetched.runtime.error) return finish("failed", fetched.runtime.error);
    if (fetched.runtime.ahead > 0) return finish("failed", `This server's checkout has ${fetched.runtime.ahead} commit${fetched.runtime.ahead === 1 ? "" : "s"} that ${fetched.runtime.ahead === 1 ? "is" : "are"} not upstream, so it cannot update by itself. Update it by hand on the host (deploy/install.sh).`);
    if (!fetched.runtime.behind && !fetched.packages.behind && !fetched.packages.error) {
      record.to = record.from;
      record.needs = { restart: false, reload: [], why: [] };
      record.note = [record.note, "Thetis is already up to date."].filter(Boolean).join(" ");
      return finish("done");
    }
    const baseline = await baselineOf();
    changed = true;
    failed = (await step("pull the runtime", gitCmd(root, "merge", "--ff-only", fetched.runtime.upstreamHead))) ?? (await step("move packages to the pinned commit", gitCmd(root, "submodule", "update", "--init", "--recursive")));
    const moved = await checkouts(root);
    record.to = summary(moved);
    const needs = await needsFor(root, home, { runtime: [fromRuntime, moved.runtime.head], packages: [fromPackages, moved.packages.head] });
    record.needs = { restart: needs.restart, reload: needs.reload, why: needs.why };
    if (!failed) {
      record.phase = "installing";
      if (needs.dependencies) {
        installed = true;
        failed = await step("install dependencies", command(npm, ["ci", "--no-audit", "--no-fund", "--loglevel=error"], root));
      } else {
        skipped("install dependencies", "No dependency changed, so node_modules is left as it is.");
      }
    }
    if (!failed) {
      record.phase = "building";
      built = true;
      failed = await step("build", command(npm, ["run", "build"], root));
    }
    if (!failed) {
      record.phase = "checking";
      failed = await step("check the new version loads", check(() => smoke(baseline)));
    }
    if (failed) return await rollBack(failed);
    changed = false;
    if (then !== "restart") return finish("done");
    if (needs.restart) return await restart(needs);
    return await reload(needs);
  } catch (err) {
    const message = `the update stopped: ${err?.message ?? err}`;
    return changed ? await rollBack(message) : finish("failed", message);
  } finally {
    clearInterval(heartbeat);
    releaseLock(home);
  }

  function finish(state, error = null) {
    record.state = state;
    if (state === "done") record.phase = record.phase === "restarting" ? "restarting" : "done";
    record.ok = state === "done";
    record.error = error;
    record.finishedAt = new Date().toISOString();
    save();
    log(`[update] ${state}${error ? `: ${error}` : ""}`);
    return record;
  }

  /** Back to `from`: the checkout, the submodule, and whatever npm and the build changed. The old daemon kept serving throughout. */
  async function rollBack(error) {
    record.error = error;
    record.rollingBack = true;
    save();
    const by = [
      ["roll back the runtime", gitCmd(root, "reset", "--hard", fromRuntime)],
      ["roll back packages", sequence(gitCmd(root, "submodule", "update", "--init", "--recursive"), gitCmd(resolve(root, "packages"), "reset", "--hard", fromPackages))],
      ...(installed ? [["roll back dependencies", command(npm, ["ci", "--no-audit", "--no-fund", "--loglevel=error"], root)]] : []),
      ...(built ? [["rebuild the old version", command(npm, ["run", "build"], root)]] : []),
    ];
    let failed = null;
    for (const [name, spec] of by) {
      failed = await step(name, spec);
      if (failed) break;
    }
    delete record.rollingBack;
    if (!failed) {
      record.rollback = { ok: true };
      return finish("rolledback", error);
    }
    const hand = `cd ${root} && git reset --hard ${fromRuntime} && git submodule update --init --recursive && git -C packages reset --hard ${fromPackages} && npm ci && npm run build`;
    record.rollback = { ok: false, error: `The rollback failed too (${failed}). Thetis is still running, but a workspace that reloads may break. On the host: ${hand}`, command: hand };
    return finish("failed", error);
  }

  /** Arms the restart latch in drain mode. The lock goes when this job returns, before the latch can fire. */
  async function restart(needs) {
    record.phase = "restarting";
    save();
    if (typeof env.restart !== "function") {
      record.restart = { state: "refused", why: "unsupported", message: NO_RESTART };
      return finish("failed", `The update is installed, but ${NO_RESTART.charAt(0).toLowerCase()}${NO_RESTART.slice(1)}`);
    }
    const reason = `Update to ${record.to.runtime} (${needs.why.length ? `Thetis's own code changed: ${needs.why.slice(0, 3).join(", ")}` : "Thetis's own code changed"})`;
    let armed;
    try {
      armed = await env.restart(reason, by);
    } catch (err) {
      armed = { state: "refused", message: String(err?.message ?? err) };
    }
    const message = typeof armed?.message === "string" ? armed.message : "";
    record.restart = { state: armed?.state ?? "refused", ...(armed?.why ? { why: armed.why } : {}), message, armedAt: new Date().toISOString(), reason };
    if (armed?.state === "armed" || armed?.state === "again") return finish("done");
    return finish("failed", `The update is installed, but Thetis could not restart itself: ${message || "the restart was refused without a reason"}`);
  }

  /** Reloads each affected workspace, draining its turns, the admin's own last so their page goes last. */
  async function reload(needs) {
    record.phase = "reloading";
    record.reloaded = [];
    save();
    const order = [...needs.reload.filter((u) => u !== by), ...needs.reload.filter((u) => u === by)];
    for (const user of order) {
      try {
        await env.reloadFence(user, { drain: true });
        record.reloaded.push({ user, ok: true });
      } catch (err) {
        record.reloaded.push({ user, ok: false, error: String(err?.message ?? err) });
      }
      save();
    }
    const missed = record.reloaded.filter((r) => !r.ok).map((r) => r.user);
    if (missed.length) record.note = [record.note, `Not applied yet for ${missed.join(", ")}: it applies when that workspace next opens or is updated.`].filter(Boolean).join(" ");
    return finish("done");
  }
}

/** The last non-empty output line of the last step: git's own words, for a sentence. */
function lastLine(record) {
  const last = record.steps.at(-1);
  return (last?.tail ?? "").trim().split("\n").filter(Boolean).pop() ?? "the download failed";
}

/** What a journal row says about a finished job. */
export const journalData = (record) => ({ from: record.from, to: record.to, ...(record.needs ? { needs: record.needs } : {}), ...(record.error ? { error: record.error } : {}), ...(record.rollback ? { rollback: record.rollback } : {}) });
