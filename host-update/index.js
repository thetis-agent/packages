// Updating the installation itself, from the control panel. The runtime checkout and its packages submodule
// live on the host and are bound read-only into every fence, so pulling them, installing dependencies and
// building can only happen here: a host package the daemon loads per call as `host.update.<export>`. The
// kernel has already checked that the caller is an admin or the operator and journalled the call.
//
// Four exports. `check` says where the two checkouts stand against their upstream, what an update would
// need (a restart, or reloads of named workspaces), whether the running daemon is older than the code on
// disk, and whether an update is installing; it reaches the remotes at most once per half hour when asked
// with `fetch: "stale"`. `apply` runs the whole update as one job on the host -- download, install, build,
// a check that the new version loads, a rollback if any of that fails, then the restart or the reloads --
// and answers at once. `progress` reads the job's record. `restart` asks for a restart when the code on disk
// is already newer than the daemon and there is nothing to download: the dev-box "Restart to finish".
//
// What this cannot update: Node itself, the OS packages the fence needs, and the systemd unit. Those are
// deploy/install.sh's, run on the host; the answer names them so nobody looks for them here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkouts } from "./lib/checkout.js";
import { assert } from "./lib/error.js";
import { journalData, NO_RESTART, readState, runJob } from "./lib/job.js";
import { takeLock, updating, UPDATING } from "./lib/lock.js";
import { needsFor } from "./lib/needs.js";
import { staleDaemon } from "./lib/stale.js";

// Only the four methods are exported as functions: every function export is callable as `host.update.<name>`.
export { UPDATING } from "./lib/lock.js";

const BEYOND = "Node itself, the OS packages the fence needs, and the systemd unit are updated by deploy/install.sh on the host.";

/** The real `git fetch` happens at most this often for the whole installation when a page asks with `fetch: "stale"`. */
export const FETCH_EVERY_MS = 30 * 60_000;
/** A fetch that failed is tried again sooner: the network may be back. */
export const FETCH_RETRY_MS = 5 * 60_000;

const fetchedFile = (home) => join(home, "update", "fetched.json");

function readFetched(home) {
  try {
    return JSON.parse(readFileSync(fetchedFile(home), "utf8"));
  } catch {
    return null;
  }
}

function writeFetched(home, row) {
  mkdirSync(dirname(fetchedFile(home)), { recursive: true });
  writeFileSync(fetchedFile(home), JSON.stringify(row));
}

/**
 * Whether this check reaches the remotes. `true` always does, `"stale"` only when the last fetch is older
 * than FETCH_EVERY_MS (FETCH_RETRY_MS after a failure). A "stale" fetch is claimed before it runs, so ten
 * admin tabs opening at once make one fetch between them.
 */
function wantsFetch(home, fetch, now = Date.now()) {
  if (fetch === true) return true;
  if (fetch !== "stale") return false;
  const last = readFetched(home);
  const age = now - Date.parse(last?.at ?? "");
  if (Number.isFinite(age) && age < (last.ok === false ? FETCH_RETRY_MS : FETCH_EVERY_MS)) return false;
  writeFetched(home, { at: new Date(now).toISOString(), ok: null });
  return true;
}

const NOTHING = { restart: false, reload: [], why: [] };

/**
 * Where the installation stands. The answer (see the README for every field): `runtime` and `packages` as
 * git sees them, `incoming` commits across both, `behind`, `dirty` and `dirtyFiles`, `stale.daemon` when the
 * running daemon is older than the code on disk, `needs` for the incoming commits, `updating` while a job
 * holds the lock, `fetchedAt` for the last real fetch, and `last`, the last job's record.
 */
export async function check(args, env) {
  const fetch = wantsFetch(env.home, args.fetch);
  const state = await checkouts(env.root, { fetch });
  if (fetch) {
    const error = state.runtime.error ?? state.packages.error;
    const ok = state.runtime.fetched && (state.packages.fetched || !state.runtime.upstream);
    writeFetched(env.home, { at: new Date().toISOString(), ok: !!ok, ...(ok ? {} : { error }) });
  }
  const { runtime, packages } = state;
  // The runtime's upstream pins a packages commit this submodule has not fetched yet: behind, by an unknown amount.
  const unfetchedPin = !!packages.error && !!packages.pinnedHead && packages.pinnedHead !== packages.head;
  const behind = !runtime.error && (runtime.behind > 0 || packages.behind > 0 || unfetchedPin);
  let needs = NOTHING;
  if (behind) {
    const { restart, reload, why } = await needsFor(env.root, env.home, { runtime: [runtime.head, runtime.upstreamHead], packages: [packages.head, packages.pinnedHead ?? packages.head] });
    needs = { restart, reload, why };
  }
  const dirtyFiles = [...runtime.dirtyFiles, ...packages.dirtyFiles.map((f) => `packages/${f}`)];
  const fetched = readFetched(env.home);
  return {
    ...state,
    incoming: [...runtime.incoming.map((c) => ({ ...c, repo: "runtime" })), ...packages.incoming.map((c) => ({ ...c, repo: "packages" }))],
    behind,
    dirty: runtime.dirty || packages.dirty,
    ...(dirtyFiles.length ? { dirtyFiles } : {}),
    stale: await staleDaemon(env.root, env.home),
    needs,
    updating: updating(env.home),
    ...(fetched?.at && fetched.ok !== null ? { fetchedAt: fetched.at, ...(fetched.ok === false ? { fetchError: fetched.error ?? "the last fetch failed" } : {}) } : {}),
    last: readState(env.home),
    beyond: BEYOND,
  };
}

/** The last update's record as it stands now, or null when none has run here. */
export async function progress(_args, env) {
  return readState(env.home);
}

/**
 * Starts the update and answers at once: `{ state: "started", then, from, last }`. Refused with `busy` while
 * one runs and `invalid` when a checkout has local changes (an update by hand is the only safe one then) or
 * tracks no upstream. `then: "restart"` puts the result into service when it is done -- a restart when the
 * daemon's own code changed, else a drained reload of each affected workspace; anything else leaves that to
 * whoever asked. The third argument is for tests only: `{ npm, smoke, baseline }` stand-ins.
 */
export async function apply(args, env, hooks = {}) {
  const then = args.then === "restart" ? "restart" : "none";
  const before = await checkouts(env.root);
  assert(!before.runtime.error, before.runtime.error, "invalid");
  const dirtyFiles = [...before.runtime.dirtyFiles, ...before.packages.dirtyFiles.map((f) => `packages/${f}`)];
  assert(!dirtyFiles.length, `Can't update: the server's copy has local changes (${dirtyFiles.slice(0, 8).join(", ")}${dirtyFiles.length > 8 ? ", …" : ""}). Commit or discard them on the host, then try again.`, "invalid");
  const by = args.actor ? String(args.actor) : "operator";
  const { note } = takeLock(env.home, by);
  const actor = args.actor ? { actor: by } : {};
  env.journal({ kind: "update.start", target: "runtime", data: { from: { runtime: before.runtime.commit, packages: before.packages.commit }, then }, ...actor });
  const job = runJob(env, { before, by, then, note, hooks });
  const kind = { done: "update.done", rolledback: "update.rolledback" };
  void job.then((record) => env.journal({ kind: kind[record.state] ?? "update.fail", target: "runtime", data: journalData(record), ...actor }), () => {});
  return { state: "started", then, from: { runtime: before.runtime.commit, packages: before.packages.commit }, last: readState(env.home) };
}

/**
 * Asks for a restart through the kernel's latch, which drains running turns first. For the case where the
 * code on disk is already newer than the running daemon. Answers the latch's own `{ state, message }`;
 * refused while an update is installing, and on a daemon that cannot restart itself from here.
 */
export async function restart(args, env) {
  if (updating(env.home)) return { state: "refused", why: "updating", message: UPDATING };
  if (typeof env.restart !== "function") return { state: "refused", why: "unsupported", message: NO_RESTART };
  let reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) {
    const stale = await staleDaemon(env.root, env.home);
    reason = stale.daemon ? `Restart to finish: ${stale.why.join("; ")} since Thetis started` : "Restart asked for from the control panel";
  }
  return env.restart(reason, args.actor ? String(args.actor) : "operator");
}
