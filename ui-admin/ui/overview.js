/* Overview, the first section an admin sees: this installation, whether it is up to date, and the one button
 * that updates it. The Installation card draws the same card the bottom-right notice draws (`describe` over
 * the shared update flow), so the two can never offer different next steps: "Update and restart" when the
 * upstream has changes, "Restart" when the code on disk is already newer than the running server, the job's
 * progress while it runs, and a failure with its fix. Under it, the facts behind that: where the runtime
 * checkout and its packages stand, whether the Thetis server runs the code on disk, a restart that is
 * pending (with Cancel), what the update would bring, the files a checkout with local changes holds, and
 * the last update's step log. The raw configuration moved to Advanced → Server settings; per-workspace
 * troubleshooting is Advanced → Workspaces. */

import { describe, dirtyOf, incomingOf, recordOf, staleOf } from "./update-flow.js";
import { actionRunner } from "./update-notice.js";
import { failedCard, failureSentence, toastError } from "./failed.js";
import { stateBadge } from "./state.js";

/** The job's state in words: the record says `rolledback`, a person reads "rolled back". */
export const RECORD_WORDS = Object.freeze({ running: "running", done: "done", failed: "failed", rolledback: "rolled back", interrupted: "stopped part-way" });

/** The one line a checkout gets: its commit, and the strongest true thing about where it stands. `tone` is the badge's. */
export function checkoutLine(kind, c) {
  if (!c) return { text: "unknown", tone: "dim" };
  const at = kind === "runtime" ? `${c.branch} @ ${c.commit}` : `@ ${c.commit}`;
  // Local changes are normal on a box where someone works in the checkout: a note, not an alarm.
  if (c.dirty) return { text: at, note: "local changes: updated by hand", tone: "dim" };
  if (c.error) return { text: at, note: c.error, tone: "warn" };
  if (c.behind) return { text: at, note: kind === "runtime" ? `${c.behind} behind ${c.upstream}` : `${c.behind} behind the pinned ${c.pinned}`, tone: "warn" };
  return { text: at, note: kind === "runtime" ? (c.fetched ? `up to date with ${c.upstream}` : `at ${c.upstream} as of the last check`) : "at the pinned commit", tone: "ok" };
}

/** The job's steps in one shape: `{ name, state: "ok" | "failed" | "running" | "waiting", ms?, tail? }`, from the record host-update writes now or the one it wrote before. */
export function stepsOf(rec) {
  return (Array.isArray(rec?.steps) ? rec.steps : []).map((s) => {
    if (typeof s.ok === "boolean" || "ms" in s) return { name: s.name, state: s.ok === true ? "ok" : s.ok === false ? "failed" : "running", ms: s.ms ?? null, tail: s.tail ?? null };
    const state = s.finishedAt ? (s.code === 0 ? "ok" : "failed") : s.startedAt ? "running" : "waiting";
    return { name: s.name, state, ms: null, tail: s.output ?? null };
  });
}

export function mountOverview(ext, root, { flow } = {}) {
  const { el, clear } = ext.dom;
  const { badge, button, card, heading, kv, put, when } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-overview" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  let alive = true;
  let status = null; // the kernel's status: the daemon and a pending restart
  let statusError = null;
  let checking = false;
  const install = el("section", { class: "ua-install" });
  put(wrap, install);
  if (!flow) {
    put(install, el("p", { class: "panel-hint" }, "Only an admin updates this installation."));
    return () => {};
  }
  const run = actionRunner(ext, flow);
  const code = (text) => el("code", { class: "ua-wrap" }, text);

  async function loadStatus() {
    try {
      status = (await ext.request("status"))?.data ?? null;
      statusError = null;
    } catch (err) {
      statusError = err;
    }
    if (alive) draw();
  }

  async function checkNow() {
    checking = true;
    draw();
    await flow.refresh({ fetch: true });
    checking = false;
    if (!alive) return;
    const n = incomingOf(flow.state.check).length;
    if (!flow.state.checkError) ext.toast(n ? `${n} ${n === 1 ? "change" : "changes"} to take.` : staleOf(flow.state.check) ? "Nothing new upstream; the code on disk is waiting for a restart." : "Thetis is up to date.", { tone: "good" });
    await loadStatus();
  }

  async function cancelRestart(anchor) {
    anchor.disabled = true;
    try {
      const out = await ext.request("restart-cancel");
      ext.toast(out?.data?.cancelled ? "The restart was called off." : "No restart was pending.", { tone: "good" });
    } catch (err) {
      toastError(ext, err, "The restart could not be called off");
    }
    await loadStatus();
  }

  /** The card `describe` makes, drawn inline: the sentence, the progress steps, and the buttons. */
  function statusBlock(state) {
    const c = describe(state);
    if (!c) return el("div", { class: "ua-update-state" }, el("p", {}, badge("Up to date", "ok"), " ", el("span", { class: "text-dim" }, "Thetis runs the newest code it knows of.")));
    const steps = c.progress ? el("ol", { class: "ua-progress" }, ...c.progress.steps.map((label, i) => el("li", { class: i < c.progress.at ? "is-done" : i === c.progress.at ? (c.progress.failed ? "is-failed" : "is-now") : "is-next" }, label))) : null;
    const actions = (c.actions ?? []).filter((a) => a.id !== "log").map((a) => button(a.label, { tone: a.primary ? "primary" : "quiet", onClick: () => void run(a) }));
    return el(
      "div",
      { class: `ua-update-state is-${c.tone}` },
      el("p", { class: "ua-update-title" }, c.title),
      c.body ? el("p", { class: "ua-update-body" }, c.body) : null,
      steps,
      actions.length ? el("div", { class: "card-actions" }, ...actions) : null
    );
  }

  const line = (kind, c) => {
    const said = checkoutLine(kind, c);
    return el("span", {}, code(said.text), said.note ? el("span", {}, " ", badge(said.note, said.tone)) : null);
  };

  /** The last update's record: each step with its state, and the failed or running step's output. */
  function record(rec) {
    if (!rec) return null;
    const steps = stepsOf(rec);
    const tone = rec.state === "done" ? "ok" : rec.state === "running" ? "accent" : "warn";
    const shown = steps.find((s) => s.state === "failed") ?? steps.find((s) => s.state === "running") ?? null;
    const from = rec.from?.runtime ?? rec.from;
    const to = rec.to?.runtime ?? rec.to;
    return el(
      "details",
      { class: "ua-details", open: rec.state !== "done" ? "" : null },
      el("summary", {}, "Last update: ", badge(RECORD_WORDS[rec.state] ?? rec.state, tone), rec.startedAt ? ` ${when(rec.startedAt)}` : "", rec.by ? ` by ${rec.by}` : ""),
      typeof from === "string" && typeof to === "string" ? el("p", { class: "text-dim" }, `${from} → ${to}`) : null,
      rec.error ? el("p", { class: "ua-error" }, rec.error) : null,
      rec.rollback ? el("p", { class: rec.rollback.ok ? "text-dim" : "ua-error" }, rec.rollback.ok ? "Rolled back to the version before." : `The rollback failed too${rec.rollback.error ? `: ${rec.rollback.error}` : "."}`) : null,
      el("ul", { class: "ua-steps" }, ...steps.map((s) => el("li", {}, badge(s.state, s.state === "ok" ? "ok" : s.state === "running" ? "accent" : s.state === "failed" ? "warn" : "dim"), " ", s.name, s.ms != null ? el("span", { class: "text-faint" }, ` ${(s.ms / 1000).toFixed(1)} s`) : null))),
      shown?.tail ? el("pre", { class: "ua-pre" }, String(shown.tail).slice(-4000)) : null
    );
  }

  function draw() {
    clear(install);
    const state = flow.state;
    const facts = state.check;
    if (state.checkError && !facts) {
      put(install, heading("Installation", "this Thetis server"), failedCard(ext, "The installation", state.checkError, { admin: true, retry: () => void flow.refresh({ fetch: false }) }));
      return;
    }
    const rec = state.record ?? recordOf({ last: facts?.last });
    const incoming = incomingOf(facts);
    const pending = status?.restart && typeof status.restart === "object" ? status.restart : null;
    const serverState = staleOf(facts) || status?.daemon?.stale ? "restart" : "current";
    const cancelBtn = pending ? button("Cancel", { tone: "quiet", onClick: () => void cancelRestart(cancelBtn) }) : null;
    const checkBtn = button(checking ? "Checking…" : "Check for updates", { tone: "quiet", disabled: checking || state.phase !== "idle" || facts?.updating ? "" : null, onClick: () => void checkNow() });
    const dirtyFiles = Array.isArray(facts?.dirtyFiles) ? facts.dirtyFiles : [];
    put(
      install,
      card(
        heading("Installation", "this Thetis server, and its updates"),
        statusBlock(state),
        pending ? el("div", { class: "ua-line ua-pending" }, badge("Restart pending", "warn"), el("span", { class: "text-dim" }, `Thetis restarts when running replies reach a safe point: ${pending.reason || "no reason given"}${pending.by ? ` (asked by ${pending.by})` : ""}.`), cancelBtn) : null,
        kv(
          [
            facts?.root && ["checkout", code(facts.root)],
            ["runtime", line("runtime", facts?.runtime)],
            ["packages", line("packages", facts?.packages)],
            facts?.node && ["node", code(facts.node)],
            ["Thetis server", el("span", {}, stateBadge(ext, serverState), status?.daemon?.startedAt ? el("span", { class: "text-faint" }, ` started ${when(status.daemon.startedAt)}`) : null)],
            facts?.fetchedAt && ["last checked", el("span", { class: "text-dim" }, when(facts.fetchedAt), facts.fetchError ? el("span", {}, " · ", `couldn't reach the update source: ${String(facts.fetchError).split("\n")[0]}`) : null)],
          ].filter(Boolean)
        ),
        statusError ? el("p", { class: "text-dim" }, failureSentence("What is running", statusError, { admin: true })) : null,
        incoming.length ? el("details", { class: "ua-details" }, el("summary", {}, `What the update brings (${incoming.length})`), el("ul", { class: "ua-incoming" }, ...incoming.map((x) => el("li", {}, code(String(x.commit ?? "").slice(0, 7)), " ", x.subject)))) : null,
        dirtyOf(facts) ? el("details", { class: "ua-details" }, el("summary", {}, "Local changes on the server", dirtyFiles.length ? ` (${dirtyFiles.length})` : ""), dirtyFiles.length ? el("ul", { class: "ua-incoming" }, ...dirtyFiles.slice(0, 50).map((f) => el("li", {}, code(f)))) : el("p", { class: "text-dim" }, "The checkout has changes that are not committed. They are kept; an update from here waits until they are committed or discarded on the host.")) : null,
        record(rec),
        el("div", { class: "card-actions" }, checkBtn),
        el("p", { class: "text-faint" }, facts?.beyond ?? "Node itself, the OS packages the workspaces need, and the systemd unit are updated by deploy/install.sh on the host.")
      )
    );
  }

  const stop = flow.subscribe(() => {
    if (alive) draw();
  });
  draw();
  // The notice has usually read the check already; a page opened on its own reads it without reaching the remotes.
  if (!flow.state.check) void flow.refresh({ fetch: false });
  void loadStatus();
  return () => {
    alive = false;
    stop();
  };
}
