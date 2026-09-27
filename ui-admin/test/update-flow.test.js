// The admin's update card as a state machine, over a fake host: what `describe` says for every shape of
// host-update's check and record (the failure table included), the flow from "Update and restart" through the
// restart and back, "Restart to finish" on a box whose code on disk is newer, the Cancel, the card after the
// page reloaded itself, and the notice that draws it all through `ext.notice`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdateFlow, describe, failureOf, incomingOf, recordOf, stepsFor } from "../ui/update-flow.js";
import { installUpdateNotice, noticeOptions, NOTICE_ID } from "../ui/update-notice.js";

const idle = (patch = {}) => ({ check: null, record: null, phase: "idle", kind: "update", applyError: null, showChanges: false, ...patch });
const incoming = [
  { commit: "a1b2c3d4", subject: "harness-core: retry a dropped round", repo: "packages" },
  { commit: "b2c3d4e5", subject: "kernel: save before a restart", repo: "runtime" },
  { commit: "c3d4e5f6", subject: "ui-admin: one button", repo: "packages" },
];
const check = (patch = {}) => ({ runtime: { commit: "8309ab0" }, packages: { commit: "dad30dc" }, incoming: [], behind: false, dirty: false, stale: { daemon: false }, needs: { restart: false, reload: [] }, updating: false, root: "/opt/thetis", ...patch });
const lost = () => Object.assign(new Error("Not connected."), { status: 0 });

test("describe: nothing to say is no card at all", () => {
  assert.equal(describe(idle()), null);
  assert.equal(describe(idle({ check: check() })), null, "up to date");
  assert.equal(describe(idle({ checkError: new Error("x") })), null, "a check that failed is the Overview's to say, not a corner alarm");
});

test("describe: an update upstream is one card with one button, and what it needs", () => {
  const card = describe(idle({ check: check({ incoming, behind: true, needs: { restart: true, reload: [] } }) }));
  assert.equal(card.title, "Thetis update available · 3 changes");
  assert.match(card.body, /^Needs a restart: running replies pause at a safe point and continue after\.$/);
  assert.deepEqual(card.actions.map((a) => [a.id, a.label, Boolean(a.primary)]), [["changes", "Show changes", false], ["update", "Update and restart", true]]);
  assert.equal(card.dismissible, true);
  const open = describe(idle({ showChanges: true, check: check({ incoming, behind: true, needs: { restart: false, reload: ["bob"] } }) }));
  assert.equal(open.body, "· harness-core: retry a dropped round\n· kernel: save before a restart\n· ui-admin: one button\nNo restart: only extensions changed; the workspaces apply it.");
  assert.equal(open.actions[0].label, "Hide changes");
  assert.notEqual(card.key, describe(idle({ check: check({ incoming: incoming.slice(1), behind: true }) })).key, "a different set of changes is a new card, so a dismissed one comes back");
  // An older host-update listed the commits per checkout.
  assert.equal(incomingOf({ runtime: { incoming: [incoming[0]] }, packages: { incoming: [incoming[1]] } }).length, 2);
});

test("describe: a checkout with local changes is a calm note, never the Update button", () => {
  const card = describe(idle({ check: check({ incoming, behind: true, dirty: true, dirtyFiles: ["src/x.ts"] }) }));
  assert.equal(card.tone, "info");
  assert.equal(card.title, "Thetis update available · 3 changes");
  assert.match(card.body, /local changes, so this one is updated by hand on the host/);
  assert.ok(!card.actions.some((a) => a.id === "update"));
});

test("describe: the dev-box shape — code on disk newer than the running server, nothing upstream — is Restart to finish", () => {
  const card = describe(idle({ check: check({ dirty: true, stale: { daemon: true, why: ["src/kernel/runner.ts"] } }) }));
  assert.equal(card.title, "Thetis's code changed · Restart to finish");
  assert.match(card.body, /newer than the running server \(src\/kernel\/runner\.ts\)/);
  assert.deepEqual(card.actions.map((a) => [a.id, a.label, a.primary]), [["restart", "Restart", true]]);
  assert.equal(card.tone, "info", "dirty says nothing here: a restart does not care");
});

test("describe: progress steps follow the record's phase, and pausing offers Cancel", () => {
  assert.deepEqual(stepsFor("update"), ["Downloading…", "Installing…", "Building…", "Checking…", "Pausing running replies…", "Restarting…", "Back online"]);
  assert.equal(stepsFor("update", 2)[4], "Pausing 2 conversations…");
  assert.deepEqual(stepsFor("restart"), ["Pausing running replies…", "Restarting…", "Back online"]);
  const at = (rec, phase = "following") => describe(idle({ phase, record: rec, check: check({ needs: { restart: true } }) })).progress.at;
  assert.equal(at(null, "starting"), 0);
  assert.equal(at({ state: "running", phase: "fetching", needs: null }), 0);
  assert.equal(at({ state: "running", phase: "installing" }), 1);
  assert.equal(at({ state: "running", phase: "building" }), 2);
  assert.equal(at({ state: "running", phase: "checking" }), 3);
  const pausing = describe(idle({ phase: "following", record: { state: "done", phase: "restarting", needs: { restart: true }, restart: { state: "armed" } } }));
  assert.equal(pausing.progress.at, 4);
  assert.deepEqual(pausing.actions.map((a) => a.id), ["cancel"]);
  assert.equal(pausing.dismissible, false);
  assert.equal(at({ state: "done", phase: "restarting", needs: { restart: true } }, "away"), 5, "Thetis went away: Restarting…");
  const back = describe(idle({ phase: "back", record: { state: "done", phase: "done", to: { runtime: "fedcba98" }, restart: { fired: true } }, reloadPage: true }));
  assert.equal(back.title, "Back online");
  assert.match(back.body, /^Thetis is updated to fedcba9\. Replies that were running continue by themselves\.$/);
  assert.equal(back.progress.at, 6);
  assert.deepEqual(back.actions.map((a) => a.id), ["reload"]);
  // No restart needed: the workspaces applied it, and the card says who could not.
  const applied = describe(idle({ phase: "following", record: { state: "done", phase: "done", needs: { restart: false, reload: ["bob", "root"] }, to: { runtime: "fedcba98" }, reloaded: [{ user: "bob", ok: false, error: "busy" }, { user: "root", ok: true }] } }));
  assert.equal(applied.title, "Thetis is updated");
  assert.match(applied.body, /bob could not apply it yet/);
  const rolling = describe(idle({ phase: "following", record: { state: "running", phase: "building", rollingBack: true } }));
  assert.equal(rolling.title, "The update didn't build · rolling back");
  assert.equal(rolling.progress.failed, true);
});

test("describe: the failure table, each with its fix", () => {
  const c = check();
  const fail = (rec) => failureOf(rec, c);
  const rb = fail({ state: "failed", phase: "building", from: { runtime: "8309ab0aa" }, error: "npm ci failed", rollback: { ok: false, error: "reset failed", command: "cd /opt/thetis && git reset --hard 8309ab0 && npm ci && npm run build" } });
  assert.equal(rb.title, "The update failed, and so did the rollback");
  assert.match(rb.body, /On the host: cd \/opt\/thetis && git reset --hard 8309ab0/);
  assert.deepEqual(rb.actions.map((a) => a.id), ["copy", "log"]);
  assert.equal(rb.actions[0].text, "cd /opt/thetis && git reset --hard 8309ab0 && npm ci && npm run build");
  const fetch = fail({ state: "failed", phase: "fetching", error: "fatal: unable to access 'https://github.com/x/'" });
  assert.equal(fetch.title, "Couldn't reach the update source");
  assert.match(fetch.body, /Nothing changed\.$/);
  assert.equal(fetch.actions[0].id, "retry");
  assert.equal(fail({ state: "failed", phase: "fetching", error: "Not possible to fast-forward, aborting." }).key, "not-ff");
  const rolled = fail({ state: "rolledback", phase: "building", from: { runtime: "8309ab0aa" }, rollback: { ok: true }, error: "build failed (exit 2)" });
  assert.equal(rolled.body, "Building the update failed, so nothing was restarted. Thetis was rolled back to 8309ab0 and is running as before.");
  // It built, and the check that the new version loads caught it: said as that, not as a build that broke.
  const steps = [{ name: "build", ok: true }, { name: "check the new version loads", ok: false }, { name: "roll back the runtime", ok: true }, { name: "rebuild the old version", ok: true }];
  const unloadable = fail({ state: "rolledback", phase: "checking", from: { runtime: "8309ab0aa" }, rollback: { ok: true }, steps, error: "the new version does not load: @thetis/ui-tools: boom" });
  assert.equal(unloadable.key, "rolled-back-check");
  assert.equal(unloadable.title, "The update didn't start");
  assert.equal(unloadable.body, "The new version failed its start-up check (@thetis/ui-tools does not load), so nothing was restarted. Thetis was rolled back to 8309ab0 and is running as before.");
  assert.equal(describe(idle({ phase: "following", record: { state: "running", phase: "checking", rollingBack: true, steps } })).title, "The update didn't start · rolling back");
  const refused = fail({ state: "failed", phase: "restarting", error: "The update is installed, but Thetis could not restart itself: x", restart: { state: "refused", message: "Refused: Restart=on-failure." } });
  assert.equal(refused.body, "Refused: Restart=on-failure.", "the latch's own sentence");
  assert.equal(refused.actions[0].id, "restart");
  assert.equal(fail({ state: "interrupted", phase: "building", error: "the daemon stopped" }).key, "interrupted");
  // A refusal at the start: local changes (calm), another update already running, or anything else.
  const dirty = describe(idle({ check: check({ dirtyFiles: ["a", "b"] }), applyError: new Error("Can't update: the server's copy has local changes (a, b). Commit or discard them on the host, then try again.") }));
  assert.equal(dirty.tone, "info");
  assert.match(dirty.body, /local changes \(2 files\)/);
  assert.equal(describe(idle({ applyError: new Error("An update is installing; Thetis restarts by itself when it is done.") })).key, "busy");
  assert.equal(describe(idle({ phase: "timeout" })).title, "Thetis hasn't come back");
  assert.match(describe(idle({ phase: "timeout" })).body, /journalctl -u thetis-runtime -n 50/);
});

test("recordOf reads the record however host-update wraps it", () => {
  assert.equal(recordOf(null), null);
  assert.deepEqual(recordOf({ state: "running", phase: "fetching" }), { state: "running", phase: "fetching" });
  assert.deepEqual(recordOf({ last: { state: "done", phase: "done" }, beyond: "x" }), { state: "done", phase: "done" });
  assert.equal(recordOf({ last: null }), null);
});

/** A fake ext: `script[verb]` is a list of answers (or errors) consumed in order, the last one repeating. */
function fakeExt(script, { back = "back", notice } = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const ext = {
    calls,
    can: (verb) => verb === "update-check" || verb === "status",
    toast: () => {},
    async request(verb, { args } = {}) {
      calls.push([verb, args ?? null]);
      const q = queues[verb];
      if (!q) throw new Error(`no answer for ${verb}`);
      const next = q.length > 1 ? q.shift() : q[0];
      if (next instanceof Error) throw next;
      return { data: typeof next === "function" ? next(args) : next };
    },
    awaitReturn: async () => back,
    ...(notice ? { notice } : {}),
  };
  return ext;
}

/** A store like sessionStorage, in memory. */
const memoryStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test("the flow: Update and restart runs the job, follows it, waits out the restart, and says Back online", async () => {
  const running = (phase) => ({ state: "running", phase, needs: { restart: true, reload: [] }, from: { runtime: "8309ab0" } });
  const ext = fakeExt({
    "update-check": [check({ incoming, behind: true, needs: { restart: true, reload: [] } }), check()],
    "update-apply": [{ state: "started", then: "restart", last: running("fetching") }],
    "update-progress": [running("installing"), running("building"), { state: "done", phase: "restarting", needs: { restart: true }, restart: { state: "armed" } }, lost(), { state: "done", phase: "done", to: { runtime: "fedcba98" }, needs: { restart: true }, restart: { state: "armed", fired: true } }],
  });
  let t = 0;
  const store = memoryStore();
  const flow = createUpdateFlow(ext, { wait: async () => void (t += 2000), now: () => t, store });
  const seen = [];
  flow.subscribe((s) => {
    const c = describe(s);
    seen.push(c ? `${c.title}${c.progress ? ` @${c.progress.at}` : ""}` : "none");
  });
  await flow.refresh();
  assert.equal(describe(flow.state).title, "Thetis update available · 3 changes");
  await flow.apply();
  assert.equal(flow.state.phase, "back");
  assert.equal(describe(flow.state).title, "Back online");
  const titles = [...new Set(seen)];
  assert.deepEqual(titles.filter((x) => x.startsWith("Updating") || x.startsWith("Back")), ["Updating Thetis @0", "Updating Thetis @1", "Updating Thetis @2", "Updating Thetis @4", "Updating Thetis @5", "Back online @6"]);
  assert.deepEqual(ext.calls.find((c) => c[0] === "update-apply"), ["update-apply", { then: "restart" }], "the one button always sends then: restart");
  assert.deepEqual(ext.calls.filter((c) => c[0] === "update-check").map((c) => c[1]), [{ fetch: "stale" }, { fetch: false }], "on load stale, after the restart without reaching the remotes");
  assert.equal(store.m.size, 0, "the remembered click is forgotten once it is said");
});

test("the flow: a restart this page never saw go is still Back online, from the record's own word", async () => {
  const ext = fakeExt({
    "update-apply": [{ state: "started", then: "restart" }],
    "update-progress": [{ state: "done", phase: "done", needs: { restart: true }, restart: { state: "armed", fired: true }, to: { runtime: "fedcba98" } }],
    "update-check": [check()],
  });
  const flow = createUpdateFlow(ext, { wait: async () => {}, store: memoryStore() });
  await flow.apply();
  assert.equal(flow.state.phase, "back");
});

test("the flow: a failed job ends on the failure card; a refused start says why; Thetis not coming back says what to run", async () => {
  const failing = fakeExt({ "update-apply": [{ state: "started" }], "update-progress": [{ state: "running", phase: "building" }, { state: "rolledback", phase: "building", rollback: { ok: true }, from: { runtime: "8309ab0" } }] });
  const flow = createUpdateFlow(failing, { wait: async () => {}, store: memoryStore() });
  await flow.apply();
  assert.equal(describe(flow.state).key, "rolled-back");
  const refused = fakeExt({ "update-apply": [new Error("An update is installing; Thetis restarts by itself when it is done. It was started 2026-09-27T10:00:00Z by root.")] });
  const f2 = createUpdateFlow(refused, { wait: async () => {}, store: memoryStore() });
  await f2.apply();
  assert.equal(f2.state.phase, "idle");
  assert.equal(describe(f2.state).key, "busy");
  const gone = fakeExt({ "update-apply": [{ state: "started" }], "update-progress": [lost()] }, { back: "timeout" });
  const f3 = createUpdateFlow(gone, { wait: async () => {}, store: memoryStore() });
  await f3.apply();
  assert.equal(describe(f3.state).key, "timeout");
});

test("the flow: Restart to finish arms host-update's restart, shows the pause, and comes back; Cancel calls it off", async () => {
  const ext = fakeExt({ "update-restart": [{ state: "armed", message: "armed" }], "update-progress": [null, null, lost(), null], "update-check": [check()] });
  const flow = createUpdateFlow(ext, { wait: async () => {}, store: memoryStore() });
  const seen = [];
  flow.subscribe((s) => seen.push(describe(s)?.title ?? "none"));
  await flow.restart();
  assert.deepEqual([...new Set(seen)].slice(0, 2), ["Restarting Thetis", "Back online"]);
  assert.match(describe(flow.state).body, /^Thetis restarted\./);
  assert.deepEqual(ext.calls[0], ["update-restart", { reason: "the code on disk is newer than the running Thetis server" }]);
  const refused = fakeExt({ "update-restart": [{ state: "refused", why: "updating", message: "An update is installing; Thetis restarts by itself when it is done." }] });
  const f2 = createUpdateFlow(refused, { wait: async () => {}, store: memoryStore() });
  await f2.restart();
  assert.equal(describe(f2.state).key, "busy", "host-update's sentence is what the card says");
  const cancelling = fakeExt({ "restart-cancel": [{ cancelled: true }], "update-check": [check({ stale: { daemon: true } })] });
  const f3 = createUpdateFlow(cancelling, { wait: async () => {}, store: memoryStore() });
  await f3.cancel();
  assert.equal(describe(f3.state).key, "restart-to-finish", "called off: the code is still waiting for a restart");
});

test("the flow: after the page reloaded itself on the new build, the admin who clicked is told Back online once", async () => {
  const store = memoryStore();
  store.setItem("thetis.ui-admin.update", JSON.stringify({ kind: "update", at: 1000 }));
  const ext = fakeExt({ "update-progress": [{ state: "done", phase: "done", to: { runtime: "fedcba98" }, restart: { fired: true } }] });
  const flow = createUpdateFlow(ext, { wait: async () => {}, now: () => 5000, store });
  await flow.resume();
  assert.equal(describe(flow.state).title, "Back online");
  assert.equal(describe(flow.state).actions.length, 0, "the page already reloaded: no Reload page button");
  assert.equal(store.m.size, 0);
  // A page that reloaded because its own workspace applied an update (no restart) says the update is in, not "Back online";
  // and the first requests after such a reload can fail while the gateway comes back, so the record is asked again.
  const store2 = memoryStore();
  store2.setItem("thetis.ui-admin.update", JSON.stringify({ kind: "update", at: 1000 }));
  const applied = { state: "done", phase: "done", to: { runtime: "fedcba98" }, needs: { restart: false, reload: ["ann", "bob"] }, reloaded: [{ user: "bob", ok: true }, { user: "ann", ok: true }] };
  const slow = fakeExt({ "update-progress": [lost(), lost(), applied] });
  const f2 = createUpdateFlow(slow, { wait: async () => {}, now: () => 5000, store: store2 });
  await f2.resume();
  assert.equal(slow.calls.filter((c) => c[0] === "update-progress").length, 3, "asked until the gateway answered");
  assert.equal(describe(f2.state).key, "applied");
  assert.equal(describe(f2.state).title, "Thetis is updated");
  // The whole chain: Update, the job applies without a restart, the page's own workspace restarts and the page
  // reloads; the click survives that reload, the new page says "Thetis is updated" once, and a page opened
  // long after says nothing.
  const store3 = memoryStore();
  const t0 = Date.parse("2026-09-27T01:48:48Z");
  const doneRec = { ...applied, finishedAt: "2026-09-27T01:48:48Z" };
  const clicked = fakeExt({ "update-apply": [{ state: "started", then: "restart" }], "update-progress": [{ state: "running", phase: "reloading", needs: { restart: false, reload: ["ann"] } }, doneRec] });
  const before = createUpdateFlow(clicked, { wait: async () => {}, now: () => t0, store: store3 });
  await before.apply();
  assert.equal(describe(before.state).key, "applied");
  assert.equal(store3.m.size, 1, "the click is kept for the reload the update causes");
  const after = createUpdateFlow(fakeExt({ "update-progress": [doneRec] }), { wait: async () => {}, now: () => t0 + 3000, store: store3 });
  await after.resume();
  assert.equal(describe(after.state).key, "applied", "the reloaded page says it once more");
  assert.equal(store3.m.size, 0, "and then forgets");
  store3.setItem("thetis.ui-admin.update", JSON.stringify({ kind: "update", at: t0 }));
  const later = createUpdateFlow(fakeExt({ "update-progress": [doneRec] }), { wait: async () => {}, now: () => t0 + 10 * 60_000, store: store3 });
  await later.resume();
  assert.equal(describe(later.state), null, "a page opened ten minutes later has nothing to say about it");
  const nobody = createUpdateFlow(fakeExt({}), { store: memoryStore() });
  await nobody.resume();
  assert.equal(describe(nobody.state), null, "nobody clicked here: nothing to say");
});

test("the notice: drawn through ext.notice for an admin only, replaced in place, closed when there is nothing to say, and a dismissed card stays away until it changes", async () => {
  const shown = [];
  const handles = [];
  const notice = (id, options) => {
    const handle = { options, closed: false, updates: [], update(o) { this.updates.push(o); this.options = o; }, close() { this.closed = true; } };
    shown.push([id, options.title]);
    handles.push(handle);
    return handle;
  };
  const ext = fakeExt({ "update-check": [check({ incoming, behind: true, needs: { restart: true } })], "update-progress": [null] }, { notice });
  const doc = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const flow = createUpdateFlow(ext, { wait: async () => {}, store: memoryStore() });
  const stop = installUpdateNotice(ext, flow, { every: 60_000_000, doc });
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(shown, [[NOTICE_ID, "Thetis update available · 3 changes"]]);
  const h = handles[0];
  assert.equal(h.options.tone, "info");
  assert.deepEqual(h.options.actions.map((a) => [a.label, a.primary]), [["Show changes", false], ["Update and restart", true]]);
  h.options.actions[0].run();
  assert.equal(handles.length, 1, "the same card, replaced in place");
  assert.match(h.options.body, /· kernel: save before a restart/);
  h.options.onDismiss();
  await flow.refresh();
  assert.equal(handles.length, 1, "dismissed: the same card does not come back");
  stop();
  // A user: no notice, whatever the gateway offers.
  const user = { ...fakeExt({}), can: () => false, notice: () => assert.fail("a user never gets the card") };
  installUpdateNotice(user, createUpdateFlow(user, { store: memoryStore() }))();
  // An older gateway without ext.notice: nothing, and no error.
  const older = fakeExt({});
  installUpdateNotice(older, createUpdateFlow(older, { store: memoryStore() }))();
  assert.deepEqual(noticeOptions({ title: "T", tone: "error", actions: [], dismissible: false }, () => {}, null).tone, "error");
});

test("the notice's body: one line as a string, the list of changes a line each", async () => {
  const { bodyOf } = await import("../ui/update-notice.js");
  assert.equal(bodyOf("", null), undefined);
  assert.equal(bodyOf("one line", (t, p, ...k) => ({ t, p, k })), "one line");
  assert.equal(bodyOf("a\nb", null), "a\nb", "no page element maker: the string as it is");
  const node = bodyOf("· a\n· b\nNeeds a restart.", (t, p, ...k) => ({ t, p, k }));
  assert.deepEqual(node.k.map((line) => line.k[0]), ["· a", "· b", "Needs a restart."]);
});
