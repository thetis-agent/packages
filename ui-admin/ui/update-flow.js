/* Updating Thetis itself, for an admin, in one place both the bottom-right notice and the Overview draw from.
 * The flow keeps what it knows (host-update's check, the job's record, where the page is in the sequence)
 * and `describe` turns that into the one card: what it says, its tone, its progress and its buttons. Both
 * surfaces draw that card, so the notice and the Overview can never disagree about what the next step is.
 *
 * The server runs the whole sequence as one job (`update-apply { then: "restart" }`): fetch, install, build,
 * a check that the new code starts, a rollback on any failure, then the restart, which pauses running replies
 * at a safe point first. The page only follows: it polls `update-progress` every two seconds, and when a
 * request is lost while Thetis restarts, it waits for Thetis to come back (`ext.awaitReturn`) and reads the
 * record again. On a box whose code on disk is already newer than the running server (a checkout changed by
 * hand, the dev-box case), there is nothing to fetch: the card says "Restart to finish" and asks
 * host-update for the restart alone. A checkout with local changes is normal on such a box, so it is said
 * calmly, never as an alarm.
 *
 * Nothing here touches the DOM: `describe` is pure and the flow takes its timers and storage from options,
 * so the whole state machine runs under `node --test` against a fake host. */

export const CHECK_EVERY_MS = 30 * 60_000;
export const POLL_MS = 2_000;
export const BACK_TIMEOUT_MS = 90_000;
/** How long a built update waits for its restart before the page stops expecting it: the latch's drain and countdown, and a margin. */
export const RESTART_WAIT_MS = 4 * 60_000;
/** A click remembered across the page reloading itself, for this long. */
const REMEMBER_MS = 15 * 60_000;
const REMEMBER_KEY = "thetis.ui-admin.update";
/** How many times the page asks for the record after reloading itself before it gives up on saying the outcome. */
const RESUME_TRIES = 10;
/** How long after an update applied without a restart a reloaded page still says so. */
const APPLIED_SAID_MS = 2 * 60_000;

const short = (commit) => (typeof commit === "string" ? commit.slice(0, 7) : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The record `update-progress` answers: the record itself, or `{ last }` as an older host-update wraps it. */
export function recordOf(data) {
  if (!data || typeof data !== "object") return null;
  if ("last" in data && !("state" in data && "phase" in data)) return data.last ?? null;
  return typeof data.state === "string" ? data : null;
}

/** The commits the update would bring: host-update's merged list, or both checkouts' lists from an older one. */
export function incomingOf(check) {
  if (Array.isArray(check?.incoming)) return check.incoming;
  return [...(check?.runtime?.incoming ?? []), ...(check?.packages?.incoming ?? [])];
}

/** Whether the checkout has local changes: the merged flag, or either checkout's. */
export const dirtyOf = (check) => Boolean(check?.dirty ?? (check?.runtime?.dirty || check?.packages?.dirty));

/** Whether the running server is older than the code on disk. */
export const staleOf = (check) => Boolean(check?.stale?.daemon);

/** What the update needs to go live: a restart, or only workspaces applying it. Unknown means a restart, the safe word. */
const needsRestart = (needs) => (needs && typeof needs.restart === "boolean" ? needs.restart : true);

/** The progress steps for each kind of sequence. `pausing` is the number of replies being paused, when known. */
export function stepsFor(kind, pausing = null) {
  const pause = typeof pausing === "number" && pausing > 0 ? `Pausing ${plural(pausing, "conversation", "conversations")}…` : "Pausing running replies…";
  if (kind === "restart") return [pause, "Restarting…", "Back online"];
  if (kind === "apply") return ["Downloading…", "Installing…", "Building…", "Checking…", "Applying to workspaces…", "Done"];
  return ["Downloading…", "Installing…", "Building…", "Checking…", pause, "Restarting…", "Back online"];
}

const PHASE_AT = { fetching: 0, installing: 1, building: 2, checking: 3, reloading: 4, draining: 4, restarting: 4 };

/** How many replies the record says are being paused, if it says. */
const pausingOf = (rec) => (typeof rec?.pausing === "number" ? rec.pausing : Array.isArray(rec?.pausing) ? rec.pausing.length : null);

/**
 * The failure card for a record that ended badly, from the table the plan fixed: what went wrong, in words,
 * and the one thing that fixes it. The raw error rides in `detail` for the Overview's log.
 */
export function failureOf(rec, check) {
  const error = String(rec?.error ?? "").trim();
  const from = short(rec?.from?.runtime ?? rec?.from);
  const failed = (rec?.steps ?? []).find((s) => s && s.ok === false) ?? null;
  const phase = rec?.phase ?? null;
  const root = check?.root ?? check?.runtime?.root ?? "<checkout>";
  if (rec?.rollback && rec.rollback.ok === false) {
    const command = rec.rollback.command || `cd ${root} && git reset --hard ${from || "<previous commit>"} && npm ci && npm run build`;
    return { key: "rollback-failed", title: "The update failed, and so did the rollback", body: `Thetis is still running, but a workspace that restarts may break. On the host: ${command}`, tone: "error", actions: [{ id: "copy", label: "Copy command", text: command }, { id: "log", label: "Show log" }] };
  }
  if (/uncommitted|local changes|dirty/i.test(error)) return dirtyFailure(check);
  if (/fast.?forward|diverge|not upstream|ahead of/i.test(error)) {
    return { key: "not-ff", title: "Thetis can't update automatically", body: "The server has commits that aren't upstream, so it can't update by itself. Update by hand on the host with deploy/install.sh.", tone: "warn", actions: [{ id: "log", label: "Show log" }] };
  }
  if (phase === "fetching" || failed?.name === "fetch" || /could not (read|resolve)|unable to access|fetch/i.test(failed?.name ?? "")) {
    return { key: "fetch", title: "Couldn't reach the update source", body: `${error || "git could not fetch"}. Nothing changed.`, tone: "warn", actions: [{ id: "retry", label: "Try again", primary: true }] };
  }
  if (phase === "restarting" || rec?.restart?.state === "refused") {
    // Installed and built, but the latch said no: its own sentence says why, and a restart later finishes it.
    return { key: "restart-refused", title: "Thetis is updated but did not restart", body: rec?.restart?.message || error || "The restart was refused.", tone: "warn", actions: [{ id: "restart", label: "Restart", primary: true }, { id: "log", label: "Show log" }] };
  }
  if (rec?.state === "interrupted") {
    return { key: "interrupted", title: "The update stopped part-way", body: "Thetis stopped while the update ran. The checkout on the host needs a look.", tone: "warn", actions: [{ id: "log", label: "Show log" }] };
  }
  if (rec?.state === "rolledback" || rec?.rollback?.ok) {
    const back = `Thetis was rolled back${from ? ` to ${from}` : ""} and is running as before.`;
    // It built, and the check that the new version loads caught it: a different failure from a build that broke.
    if (failedTheCheck(rec)) {
      const who = /does not load: (@[a-z0-9-]+\/[a-z0-9._-]+)/i.exec(error)?.[1];
      return { key: "rolled-back-check", title: "The update didn't start", body: `The new version failed its start-up check${who ? ` (${who} does not load)` : ""}, so nothing was restarted. ${back}`, tone: "warn", actions: [{ id: "log", label: "Show log" }, { id: "retry", label: "Try again" }] };
    }
    return { key: "rolled-back", title: "The update didn't build", body: `Building the update failed, so nothing was restarted. ${back}`, tone: "warn", actions: [{ id: "log", label: "Show log" }, { id: "retry", label: "Try again" }] };
  }
  return { key: "failed", title: "The update failed", body: `${error ? `${error.split("\n")[0]}. ` : ""}Nothing was restarted.`, tone: "error", actions: [{ id: "log", label: "Show log" }, { id: "retry", label: "Try again" }] };
}

/** Whether the job got as far as checking the new version and failed there: it built, but does not load. */
function failedTheCheck(rec) {
  const failed = (rec?.steps ?? []).find((s) => s && s.ok === false && !/^roll back|^rebuild/.test(String(s.name ?? "")));
  if (failed) return /check/i.test(String(failed.name ?? ""));
  return rec?.phase === "checking" || /does not load/i.test(String(rec?.error ?? ""));
}

/** The card for an update that went live without a restart: every workspace applied it, or the ones that could not are named. */
function appliedCard(rec) {
  const failedUsers = (Array.isArray(rec.reloaded) ? rec.reloaded : []).filter((r) => r && r.ok === false).map((r) => r.user);
  const tail = failedUsers.length ? ` ${failedUsers.join(", ")} could not apply it yet; Advanced → Workspaces restarts one by hand.` : "";
  return { key: "applied", title: "Thetis is updated", body: `Updated to ${short(rec.to?.runtime ?? rec.to) || "the new version"}. No restart was needed: the workspaces applied it.${tail}`, tone: failedUsers.length ? "warn" : "ok", actions: [], progress: { steps: stepsFor("apply"), at: 5 }, dismissible: true };
}

/** The calm "update by hand" card: a checkout with local changes cannot be pulled, and that is not a fault. */
function dirtyFailure(check) {
  const files = Array.isArray(check?.dirtyFiles) ? check.dirtyFiles : [];
  return { key: "dirty", title: "Thetis can't update by itself here", body: `The server's copy has local changes${files.length ? ` (${plural(files.length, "file", "files")})` : ""}. Commit or discard them on the host, then try again.`, tone: "info", actions: [{ id: "log", label: "Show the files" }] };
}

/**
 * The one card for the state, or null when there is nothing to say. `{ key, title, body, tone, actions,
 * progress?, dismissible }`: `key` changes whenever the card means something new, so a dismissed card stays
 * dismissed only until then. Actions are ids the surface wires to the flow (`update`, `restart`, `changes`,
 * `log`, `retry`, `wait`, `cancel`, `copy`, `reload`).
 */
export function describe(s) {
  const kind = s.kind ?? "update";
  const rec = s.record;
  if (s.phase === "timeout") {
    return { key: "timeout", title: "Thetis hasn't come back", body: `It has not answered for ${BACK_TIMEOUT_MS / 1000} s. On the host: journalctl -u thetis-runtime -n 50`, tone: "error", actions: [{ id: "wait", label: "Keep waiting", primary: true }], dismissible: true };
  }
  if (s.phase === "back") {
    const to = short(rec?.to?.runtime ?? rec?.to);
    const failed = kind === "update" && rec && (rec.state === "failed" || rec.state === "rolledback");
    if (failed) return { ...failureOf(rec, s.check), dismissible: true };
    // The page reloaded itself because the workspaces applied the update; nothing restarted, so "Back online" would be wrong.
    if (kind === "update" && rec?.state === "done" && !needsRestart(rec.needs) && !rec.restart?.fired) return appliedCard(rec);
    return { key: "back", title: "Back online", body: `${kind === "update" && to ? `Thetis is updated to ${to}. ` : "Thetis restarted. "}Replies that were running continue by themselves.`, tone: "ok", actions: s.reloadPage ? [{ id: "reload", label: "Reload page", primary: true }] : [], progress: { steps: stepsFor(kind), at: stepsFor(kind).length - 1 }, dismissible: true };
  }
  if (s.phase === "starting" || s.phase === "following" || s.phase === "away") {
    if (s.phase === "following" && rec && ["failed", "rolledback", "interrupted"].includes(rec.state)) return { ...failureOf(rec, s.check), dismissible: true };
    if (s.phase === "following" && kind === "update" && rec?.state === "done" && !needsRestart(rec.needs)) return appliedCard(rec);
    if (rec?.rollingBack) {
      return { key: "rolling-back", title: failedTheCheck(rec) ? "The update didn't start · rolling back" : "The update didn't build · rolling back", body: "Thetis keeps running the version before while it goes back to it.", tone: "warn", actions: [], progress: { steps: stepsFor("update"), at: PHASE_AT[rec.phase] ?? 2, failed: true }, dismissible: false };
    }
    const seq = kind === "restart" ? "restart" : rec && !needsRestart(rec.needs ?? s.check?.needs) ? "apply" : "update";
    const steps = stepsFor(seq, pausingOf(rec));
    let at;
    if (seq === "restart") at = s.phase === "away" ? 1 : 0;
    else if (s.phase === "away") at = seq === "apply" ? 4 : 5;
    else at = s.phase === "starting" ? 0 : rec?.state === "done" ? 4 : (PHASE_AT[rec?.phase] ?? 0);
    const pausing = (seq === "restart" && at === 0) || (seq === "update" && at === 4);
    return { key: `progress-${seq}`, title: seq === "restart" ? "Restarting Thetis" : "Updating Thetis", body: pausing ? "Running replies stop at a safe point and continue after the restart." : s.phase === "away" ? "Waiting for Thetis to come back…" : seq === "update" ? "Nothing that is running changes until the new version is built and checked." : "", tone: "info", actions: pausing ? [{ id: "cancel", label: "Cancel the restart" }] : [], progress: { steps, at }, dismissible: false };
  }
  if (s.applyError) {
    const text = String(s.applyError?.message ?? s.applyError);
    if (/uncommitted|local changes|dirty/i.test(text)) return { ...dirtyFailure(s.check), dismissible: true };
    if (/installing|update is running|already running/i.test(text)) return { key: "busy", title: "An update is already running", body: "Another admin started it. This card follows it.", tone: "info", actions: [], dismissible: true };
    return { key: "apply-error", title: "The update could not start", body: text.split("\n")[0], tone: "error", actions: [{ id: "retry", label: "Try again" }, { id: "log", label: "Show log" }], dismissible: true };
  }
  const check = s.check;
  if (!check) return null;
  if (check.updating) {
    const steps = stepsFor(needsRestart(check.needs ?? rec?.needs) ? "update" : "apply", pausingOf(rec));
    return { key: "updating", title: "Thetis is updating", body: "An update is installing on the server. It restarts by itself when done.", tone: "info", actions: [], progress: { steps, at: PHASE_AT[rec?.phase] ?? 0 }, dismissible: true };
  }
  const incoming = incomingOf(check);
  if (incoming.length) {
    const n = incoming.length;
    const title = `Thetis update available · ${plural(n, "change", "changes")}`;
    const need = needsRestart(check.needs) ? "Needs a restart: running replies pause at a safe point and continue after." : "No restart: only extensions changed; the workspaces apply it.";
    const list = s.showChanges ? incoming.slice(0, 20).map((c) => `· ${c.subject}`).join("\n") + (n > 20 ? `\n· and ${n - 20} more` : "") : null;
    if (dirtyOf(check)) {
      return { key: `available-dirty-${n}-${short(incoming[0]?.commit)}`, title, body: [list, "The server's copy has local changes, so this one is updated by hand on the host."].filter(Boolean).join("\n"), tone: "info", actions: [{ id: "changes", label: s.showChanges ? "Hide changes" : "Show changes" }, { id: "log", label: "Show the files" }], dismissible: true };
    }
    return { key: `available-${n}-${short(incoming[0]?.commit)}`, title, body: [list, need].filter(Boolean).join("\n"), tone: "info", actions: [{ id: "changes", label: s.showChanges ? "Hide changes" : "Show changes" }, { id: "update", label: "Update and restart", primary: true }], dismissible: true };
  }
  if (staleOf(check)) {
    const why = Array.isArray(check.stale?.why) && check.stale.why.length ? ` (${check.stale.why.slice(0, 3).join(", ")})` : "";
    return { key: "restart-to-finish", title: "Thetis's code changed · Restart to finish", body: `The code on disk is newer than the running server${why}. Running replies pause at a safe point and continue after the restart.`, tone: "info", actions: [{ id: "restart", label: "Restart", primary: true }], dismissible: true };
  }
  return null;
}

/** Waits for Thetis to go and come back: the gateway's helper when it has one, a poll of `update-progress` when not. */
async function awaitBack(ext, wait, now) {
  if (typeof ext.awaitReturn === "function") return ext.awaitReturn({ timeoutMs: BACK_TIMEOUT_MS });
  const deadline = now() + BACK_TIMEOUT_MS;
  for (;;) {
    try {
      await ext.request("update-progress");
      return "back";
    } catch {
      if (now() >= deadline) return "timeout";
      await wait(1000);
    }
  }
}

/**
 * A lost request, as against one the gateway answered: the only failure that means "Thetis is restarting".
 * The API says it with a status (0 for no answer, the door's 502/503/504); an error with no status at all
 * was thrown in the page, and is a refusal to read, not a restart.
 */
function lost(err) {
  const status = Number(err?.status);
  return Number.isFinite(status) && (status === 0 || status >= 502);
}

/** sessionStorage, or nothing: a private window or blocked storage just forgets the click. */
function defaultStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The flow for one page. `refresh({ fetch })` reads the check; `apply()`, `restart()`, `cancel()` act;
 * `subscribe(fn)` is called with the state after every change and answers the stop function. `wait(ms)`,
 * `now()` and `store` are options so a test drives it without timers or a browser.
 */
export function createUpdateFlow(ext, { wait = (ms) => new Promise((done) => setTimeout(done, ms)), now = () => Date.now(), store = defaultStore() } = {}) {
  const state = { check: null, checkError: null, record: null, phase: "idle", kind: "update", applyError: null, showChanges: false, reloadPage: false };
  const listeners = new Set();
  let following = false;

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error("an update-flow listener threw:", err);
      }
    }
  };
  const set = (patch) => {
    Object.assign(state, patch);
    emit();
  };

  const remember = (kind) => {
    try {
      store?.setItem(REMEMBER_KEY, JSON.stringify({ kind, at: now() }));
    } catch {
      /* forgetting the click only loses the "Back online" card after a page reload */
    }
  };
  const recalled = () => {
    try {
      const got = JSON.parse(store?.getItem(REMEMBER_KEY) ?? "null");
      return got && now() - got.at < REMEMBER_MS ? got : null;
    } catch {
      return null;
    }
  };
  const forget = () => {
    try {
      store?.removeItem(REMEMBER_KEY);
    } catch {
      /* nothing to forget */
    }
  };

  async function readProgress() {
    const out = await ext.request("update-progress");
    return recordOf(out?.data);
  }

  async function refresh({ fetch = "stale" } = {}) {
    try {
      const out = await ext.request("update-check", { args: { fetch } });
      const check = out?.data ?? null;
      set({ check, checkError: null, record: recordOf({ last: check?.last }) ?? state.record });
      if (check?.updating && state.phase === "idle") void follow();
    } catch (err) {
      set({ checkError: err });
    }
    return state;
  }

  /**
   * Polls the record while the job runs. A lost request means Thetis went away to restart. A job that is done
   * and needs a restart has armed it: the poll goes on until Thetis goes, for as long as the latch can wait
   * (its drain is bounded at two minutes), and a restart that never came leaves the card to say what is true.
   */
  async function follow() {
    if (following) return;
    following = true;
    let errors = 0;
    const since = now();
    try {
      for (;;) {
        let rec;
        try {
          rec = await readProgress();
          errors = 0;
        } catch (err) {
          if (lost(err)) return void (await away());
          if (++errors >= 5) return void set({ phase: "idle", applyError: err });
          await wait(POLL_MS);
          continue;
        }
        set({ phase: state.phase === "idle" || state.phase === "starting" ? "following" : state.phase, record: rec ?? state.record });
        if (rec?.state === "running") {
          await wait(POLL_MS);
          continue;
        }
        // The restart already happened (this page never saw Thetis go): back online.
        if (rec?.state === "done" && rec.restart?.fired) {
          forget();
          set({ phase: "back", reloadPage: true });
          return;
        }
        if (rec?.state === "done" && needsRestart(rec.needs) && state.kind === "update" && rec.restart?.state !== "refused") {
          if (now() - since < RESTART_WAIT_MS) {
            await wait(POLL_MS);
            continue;
          }
          // The restart never came (refused, or called off): the check says what is true now.
          forget();
          set({ phase: "idle" });
          await refresh({ fetch: false });
          return;
        }
        // Applied without a restart: the workspaces restarted, this page's own among them, so the page is
        // about to reload itself on the new build. The click stays remembered, and the reloaded page says
        // "Thetis is updated" once more (and then forgets); a page that does not reload keeps the card.
        if (rec?.state === "done" && state.kind === "update" && !needsRestart(rec.needs)) return;
        forget();
        return;
      }
    } finally {
      following = false;
    }
  }

  /** Thetis is restarting: wait for it, then read what happened. */
  async function away() {
    set({ phase: "away" });
    const got = await awaitBack(ext, wait, now);
    if (got !== "back") return void set({ phase: "timeout" });
    let rec = state.record;
    try {
      rec = (await readProgress()) ?? rec;
    } catch {
      /* the record is the job's; a page without it still says Back online */
    }
    forget();
    set({ phase: "back", record: rec, reloadPage: true });
    void refresh({ fetch: false });
  }

  /** Update and restart: the whole job, on the server. */
  async function apply() {
    set({ phase: "starting", kind: "update", applyError: null });
    try {
      const out = await ext.request("update-apply", { args: { then: "restart" } });
      if (out?.data?.state === "current") {
        set({ phase: "idle" });
        await refresh({ fetch: false });
        return;
      }
      remember("update");
      // The answer carries the record as it stood a moment after the start; an older job's record is not this one.
      const started = recordOf(out?.data);
      set({ record: started?.state === "running" ? started : null });
      await follow();
    } catch (err) {
      if (lost(err)) return void (await away());
      set({ phase: "idle", applyError: err });
    }
  }

  /**
   * Restart to finish: the code on disk is already the new one. host-update arms the latch; the page shows the
   * pause and then waits for Thetis to go and come back. A refusal is the latch's own sentence.
   */
  async function restart() {
    set({ phase: "starting", kind: "restart", applyError: null });
    try {
      const out = await ext.request("update-restart", { args: { reason: "the code on disk is newer than the running Thetis server" } });
      if (out?.data?.state === "refused") return void set({ phase: "idle", applyError: new Error(out.data.message || "The restart was refused.") });
      remember("restart");
      set({ phase: "following" });
      // Nothing to follow but Thetis itself: a cheap read until it stops answering.
      for (;;) {
        await wait(POLL_MS);
        if (state.phase !== "following" || state.kind !== "restart") return;
        try {
          await ext.request("update-progress");
        } catch (err) {
          if (lost(err)) return void (await away());
        }
      }
    } catch (err) {
      if (lost(err)) return void (await away());
      set({ phase: "idle", applyError: err });
    }
  }

  /** Calls the pending restart off. The code stays built; the card goes back to "Restart to finish". */
  async function cancel() {
    try {
      await ext.request("restart-cancel");
    } catch (err) {
      set({ applyError: err });
      return;
    }
    forget();
    set({ phase: "idle", kind: "update" });
    await refresh({ fetch: false });
  }

  /** After the page reloaded itself on the new build: say Back online once, for the admin who clicked. */
  async function resume() {
    const got = recalled();
    if (!got) return;
    // The page reloaded because its own workspace just restarted: the first requests can land before the
    // gateway answers again. A few tries, a second apart, before the click is let go unsaid.
    let rec = null;
    for (let tries = 0; ; tries++) {
      try {
        rec = await readProgress();
        break;
      } catch {
        if (tries >= RESUME_TRIES) return;
        await wait(1000);
      }
    }
    if (rec?.state === "running") {
      set({ kind: got.kind, record: rec, phase: "following" });
      return void follow();
    }
    forget();
    // An update applied without a restart is said after the reload it caused, not on a page opened later.
    const finished = Date.parse(rec?.finishedAt ?? "");
    if (got.kind === "update" && rec?.state === "done" && !needsRestart(rec.needs) && Number.isFinite(finished) && now() - finished > APPLIED_SAID_MS) return;
    set({ kind: got.kind, record: rec, phase: "back", reloadPage: false });
  }

  return {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh,
    apply,
    restart,
    cancel,
    resume,
    follow,
    wait: () => away(),
    toggleChanges: () => set({ showChanges: !state.showChanges }),
    dismiss: () => {
      // A dismissed outcome is said: the reloaded page need not say it again.
      if (state.phase === "back" || (state.phase === "following" && state.record?.state === "done")) forget();
      set({ phase: state.phase === "back" || state.phase === "timeout" ? "idle" : state.phase, applyError: null, record: state.phase === "back" ? null : state.record });
    },
  };
}
