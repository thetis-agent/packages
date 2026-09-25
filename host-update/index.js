// Updating the installation itself, from the control panel. The runtime checkout and its packages
// submodule live on the host and are bound read-only into every fence, so pulling them, installing
// dependencies and building can only happen here: a host package the daemon loads per call as
// `host.update.<export>`. The kernel has already checked that the caller is an admin or the operator and
// journalled the call.
//
// Three exports. `check` says where the two checkouts stand against their upstream, reaching the remotes
// only when asked to. `apply` runs the update -- pull, submodule update, npm ci, build -- as a job that
// writes its record under `<home>/update/` as it goes and answers at once, because a build takes minutes
// and a page should not hold a request open for that. `progress` reads that record. Nothing running
// changes by itself: what a workspace loads and what the daemon runs are put into service by the reload
// and the restart the control panel already offers, and the page shows both once the update is done.
//
// What this cannot update: Node itself, the OS packages the fence needs, and the systemd unit. Those are
// deploy/install.sh's, run on the host; the answer names them so nobody looks for them here.
import { checkouts } from "./lib/checkout.js";
import { assert } from "./lib/error.js";
import { assertNotRunning, readState, runUpdate, updateSteps } from "./lib/job.js";

export { checkouts, runtimeState, packagesState } from "./lib/checkout.js";
export { readState, runUpdate, updateSteps } from "./lib/job.js";

const BEYOND = "Node itself, the OS packages the fence needs, and the systemd unit are updated by deploy/install.sh on the host.";

/** The checkouts against their upstream, with the last update's record. `fetch: true` reaches the remotes first. */
export async function check(args, env) {
  const state = await checkouts(env.root, { fetch: args.fetch === true });
  return { ...state, last: readState(env.home), beyond: BEYOND };
}

/** The last update's record as it stands now, or null. */
export async function progress(_args, env) {
  return { last: readState(env.home), beyond: BEYOND };
}

/**
 * Starts the update and answers at once. Refused while one runs, when a checkout has uncommitted changes
 * (an update by hand is the only safe one then), and when nothing is behind. The steps are the installer's.
 */
export async function apply(args, env) {
  assertNotRunning(env.home);
  const before = await checkouts(env.root, { fetch: true });
  assert(!before.runtime.error, before.runtime.error, "invalid");
  assert(!before.runtime.dirty && !before.packages.dirty, "the checkout has uncommitted changes; update it by hand on the host, or commit or discard them first", "invalid");
  if (!before.runtime.behind && !before.packages.behind && !before.packages.error) return { state: "current", from: summary(before), last: readState(env.home) };
  const by = args.actor ? String(args.actor) : "operator";
  env.journal({ kind: "update.start", target: "runtime", data: { from: summary(before) }, ...(args.actor ? { actor: by } : {}) });
  const job = runUpdate(env.home, updateSteps(env.root, { build: args.build !== false }), { from: summary(before), after: async () => summary(await checkouts(env.root)), log: env.log, by });
  void job.then((state) => env.journal({ kind: state.ok ? "update.done" : "update.fail", target: "runtime", data: { from: state.from, to: state.to, ...(state.error ? { error: state.error } : {}) }, ...(args.actor ? { actor: by } : {}) }), () => {});
  // `build: false` skips npm ci and the build. The control panel never sends it; the tests do, because a
  // test that ran npm would be a test of the network.
  return { state: "started", from: summary(before), last: readState(env.home) };
}

/** The two commits and how far each is behind: what a record and a journal row say about a checkout. */
function summary(state) {
  return { runtime: state.runtime.commit, packages: state.packages.commit, runtimeBehind: state.runtime.behind, packagesBehind: state.packages.behind };
}
