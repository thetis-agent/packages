/* Advanced → Workspaces: what code each workspace runs, and the troubleshooting controls for one workspace
 * at a time. Everyday updating is the Overview's one button and the extensions pages' "Apply updates for
 * N people"; this page is for when one workspace needs a hand.
 *
 * Restarting a workspace closes it and opens it again on the code on disk: its services, its provider and
 * the agent itself. By default it drains: running replies stop at their next safe point and continue by
 * themselves once the workspace is back, so nobody is asked to cancel anything. Force is the second choice,
 * behind its own confirm: it cancels running replies at once (they are kept, and continue too). Restarting
 * your own workspace closes the one answering this page, so a lost request is the expected success: the page
 * waits for Thetis to answer again and says the remedy when it never does.
 *
 * The Thetis server card says whether the server runs the code on disk, whether a restart could succeed on
 * this host at all (systemd, Restart=always), a restart that is pending with Cancel, and a restart asked for
 * by hand, with the typed reason that is shown to everyone waiting and journalled. Every sentence about the
 * outcome is the latch's own. While an update of Thetis installs (host-update holds its lock), every restart
 * control here is off and says why: the update restarts what it needs by itself. */

import { failedCard, isLost, toastError } from "./failed.js";
import { stateBadge } from "./words.js";

export { isLost };

const SYSTEM = "_system";
export const SETTLE_MS = 90_000;

/**
 * Waits for the gateway to answer after its own workspace was closed, and says whether it did. The gateway's
 * `ext.awaitReturn` when it has one; otherwise a poll of `status`.
 */
export async function settle(ext, deadline = Date.now() + SETTLE_MS) {
  if (typeof ext.awaitReturn === "function") return (await ext.awaitReturn({ timeoutMs: Math.max(1000, deadline - Date.now()) })) === "back";
  for (;;) {
    try {
      await ext.request("status");
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((done) => setTimeout(done, 700));
    }
  }
}

/** The sentence every restart control says while an update of Thetis installs. */
export const UPDATING = "An update is installing; Thetis restarts by itself when it is done.";

/** The kernel's refusal for a workspace with a turn running in it, from a kernel that cannot drain yet. */
export function isBusy(err) {
  return /has a turn running|is busy|\bbusy\b/.test(err?.message ?? "");
}

/**
 * One workspace restart, and what it answered: `done` with the services restarted and the replies paused
 * (`drained`) or cancelled, `busy` when a kernel that cannot drain refused over a running reply, `refused`
 * with the kernel's sentence, `returned` when the workspace answering this page closed and came back, and
 * `silent` when it never did. `mode` is `drain` (the default) or `force`.
 */
export async function reloadWorkspace(ext, target, { onLost, mode = "drain" } = {}) {
  try {
    const out = await ext.request("fence-reload", { args: { user: target, ...(mode === "force" ? { force: true } : { drain: true }) } });
    return { state: "done", services: out?.data?.services ?? [], drained: out?.data?.drained ?? [], cancelled: out?.data?.cancelled ?? [] };
  } catch (err) {
    // A refused verb answers at once and names its reason; a closed gateway never answers at all.
    if (isBusy(err)) return { state: "busy", message: err.message };
    if (!isLost(err)) return { state: "refused", message: err.message, error: err };
    onLost?.();
    if (await settle(ext)) return { state: "returned", services: [] };
    return { state: "silent", message: `It has not answered for ${SETTLE_MS / 1000} seconds. On the host: thetis reload --user ${target}` };
  }
}

/** What one restart did, in one sentence for its row or its toast. */
export function outcomeSentence(target, out) {
  const who = target === SYSTEM ? "The system workspace" : `${target}'s workspace`;
  if (out.state === "done") {
    const paused = out.drained?.length ? ` ${out.drained.length} running ${out.drained.length === 1 ? "reply was" : "replies were"} paused and continue by themselves.` : "";
    const cut = out.cancelled?.length ? ` ${out.cancelled.length} running ${out.cancelled.length === 1 ? "reply was" : "replies were"} stopped and continue by themselves.` : "";
    return `${who} restarted${out.services?.length ? `: ${out.services.join(", ")}` : ""}.${paused}${cut}`;
  }
  if (out.state === "returned") return `${who} restarted and answered again.`;
  if (out.state === "busy") return `${who} was left alone: a reply is running there. Try again when it ends, or use Force.`;
  if (out.state === "silent") return `${who} has not answered for ${SETTLE_MS / 1000} seconds. On the host: thetis reload --user ${target}`;
  return `${who}: ${out.message}`;
}

export function mountWorkspaces(ext, root, { user } = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, card, confirm, heading, kv, put, table, tags } = ext.ui;
  let daemon = null; // { startedAt, uptimeSecs, supervised, restartPolicy, stale }
  let pending = null; // the restart armed now, or null
  let rows = [];
  let failed = null;
  let updating = false; // host-update holds its lock: every restart here waits for it
  let said = null; // { state, message }: the last thing the latch said about a restart, kept where it was asked for
  const notes = new Map(); // user -> the last outcome sentence for that row
  const wrap = el("div", { class: "panel-col ua-workspaces" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading the workspaces…");
    try {
      const [out, check] = await Promise.all([ext.request("status"), ext.request("update-check", { args: { fetch: false } }).catch(() => null)]);
      updating = Boolean(check?.data?.updating);
      daemon = out?.data?.daemon ?? null;
      pending = out?.data?.restart && typeof out.data.restart === "object" ? out.data.restart : null;
      rows = Array.isArray(out?.data?.workspaces) ? out.data.workspaces : [];
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    draw();
  }

  /** Restarts one workspace, drained unless `force`, and keeps the outcome on its row. */
  async function restart(target, mode) {
    notes.delete(target);
    const out = await reloadWorkspace(ext, target, { mode, onLost: () => ext.toast(`${target}'s workspace is restarting. Waiting for it to answer again…`, { tone: "good" }) });
    const sentence = outcomeSentence(target, out);
    notes.set(target, { text: sentence, bad: out.state === "refused" || out.state === "silent" || out.state === "busy" });
    if (out.state === "refused") toastError(ext, out.error ?? new Error(out.message), `${target}'s workspace`);
    else ext.toast(sentence, { tone: out.state === "silent" || out.state === "busy" ? "warn" : "good" });
    await load();
  }

  async function ask(anchor, row) {
    const me = row.user === user;
    const changed = Array.isArray(row.changed) ? row.changed : [];
    const lines = [["workspace", row.user], ...(changed.length ? [["applies", changed.map((c) => `${c.name} ${c.loaded} → ${c.onDisk}`).join(", ")]] : []), ["keeps", "conversations and files"]];
    const note = [
      row.user === SYSTEM ? "The providers and the sign-in page restart on the code on disk now." : `${me ? "Your" : `${row.user}'s`} services and the agent restart on the code on disk now.`,
      "Running replies stop at a safe point and continue by themselves when it is back. Open terminal sessions in it end.",
      me ? "This is the workspace serving this page, so the page waits for it to answer again." : null,
    ]
      .filter(Boolean)
      .join(" ");
    return confirm(anchor, { title: "Restart this workspace?", lines, note, confirmLabel: "Restart", tone: "warn" });
  }

  async function askForce(anchor, row) {
    return confirm(anchor, { title: "Restart it now?", lines: [["workspace", row.user]], note: "Running replies are stopped at once instead of at a safe point. What they said and did is kept, and they continue by themselves when the workspace is back. Open terminal sessions in it end.", confirmLabel: "Restart now", tone: "warn" });
  }

  /** Why a restart of Thetis could not succeed on this host, or null when it could. */
  function blocker() {
    if (!daemon.supervised) return "Thetis was not started by systemd here, so exiting would stop it rather than restart it. An operator starts it under systemd on the host; the control is off until then.";
    const policy = daemon.restartPolicy ?? null;
    if (policy === null) return "The restart policy of the systemd unit could not be read, so there is no way to know whether Thetis would come back. The control is off until an operator puts that right on the host.";
    if (policy !== "always") return `The systemd unit says Restart=${policy}, not Restart=always, so Thetis would exit and stay down. The control is off until an operator puts that right on the host.`;
    return null;
  }

  async function cancelRestart(anchor) {
    anchor.disabled = true;
    try {
      const out = await ext.request("restart-cancel");
      ext.toast(out?.data?.cancelled ? "The restart was called off." : "No restart was pending.", { tone: "good" });
    } catch (err) {
      toastError(ext, err, "The restart could not be called off");
    }
    await load();
  }

  /**
   * Asks for a restart by hand, for troubleshooting. The reason is typed into the confirm itself, because it is
   * shown to everyone waiting and written to the journal. The latch's answer is shown word for word.
   */
  async function arm(anchor) {
    const reason = el("input", { class: "input ua-reason", type: "text", placeholder: "what changed, and why a workspace restart cannot pick it up", "aria-label": "Reason", autocomplete: "off" });
    setTimeout(() => reason.focus(), 0);
    const ok = await confirm(anchor, {
      title: "Restart Thetis?",
      lines: [["restarts", "the server and every workspace"], ["reason", reason]],
      note: "Nothing happens the moment you confirm: running replies stop at a safe point, Thetis counts down where everyone can see it, restarts, and the replies continue by themselves. Open terminal sessions end. It can be called off until it fires. The reason is shown to everyone waiting and recorded.",
      confirmLabel: "Restart Thetis",
      tone: "warn",
    });
    if (!ok) return;
    const text = reason.value.trim();
    if (!text) return void ext.toast("A restart needs a reason: it is shown to everyone waiting and recorded.", { tone: "error" });
    try {
      const out = await ext.request("restart-request", { args: { reason: text } });
      const state = out?.data?.state ?? null;
      const message = typeof out?.data?.message === "string" && out.data.message.trim() ? out.data.message : null;
      said = message ? { state, message } : { state: "unknown", message: "Thetis answered without a sentence of its own, so this page cannot tell what it did. thetis restart status on the host says whether anything is armed." };
      ext.toast(said.message, { tone: said.state === "armed" || said.state === "again" ? "warn" : "error" });
    } catch (err) {
      said = { state: "failed", message: err.message };
      toastError(ext, err, "The restart could not be asked for");
    }
    await load();
  }

  function serverCard() {
    if (!daemon) return null;
    const why = blocker();
    const go = pending ? null : button("Restart Thetis…", { tone: "quiet", disabled: why || updating ? true : null, title: updating ? UPDATING : why ? "A restart could not succeed on this host" : "Ask Thetis to restart itself", onClick: () => void arm(go) });
    const cancel = pending ? button("Cancel", { onClick: () => void cancelRestart(cancel) }) : null;
    return card(
      "Thetis server",
      kv([
        ["state", el("span", { class: "ua-line" }, stateBadge(ext, daemon.stale ? "restart" : "current"), el("span", { class: "text-dim" }, daemon.stale ? `the code on disk is newer, since ${clock(daemon.codeAt)}` : "runs the code on disk"))],
        ["started", el("span", { class: "text-dim" }, daemon.startedAt ? `${clock(daemon.startedAt)} · up ${upFor(daemon.uptimeSecs)}` : "not known")],
        ["supervision", el("span", { class: "ua-line" }, daemon.supervised ? badge("systemd", "ok") : badge("not supervised", "warn"), el("span", { class: "text-dim" }, daemon.restartPolicy ? `Restart=${daemon.restartPolicy}` : "restart policy not known"))],
      ]),
      pending ? el("div", { class: "ua-line ua-pending" }, badge("Restart pending", "warn"), el("span", { class: "text-dim" }, `${pending.reason || "no reason given"}${pending.by ? ` (asked by ${pending.by})` : ""}`), cancel) : null,
      why ? el("p", { class: "text-faint" }, why) : null,
      updating ? el("p", { class: "text-dim" }, UPDATING) : null,
      el("div", { class: "card-actions" }, go),
      said ? el("p", { class: said.state === "armed" || said.state === "again" ? "text-dim" : "ua-refused" }, said.message) : null
    );
  }

  /** The packages this workspace has not applied: name, the version it loaded and the one on disk. */
  function changedLine(row) {
    const changed = Array.isArray(row.changed) ? row.changed : [];
    if (!changed.length) return null;
    const say = (c, name) => `${name} ${c.loaded} → ${c.onDisk}`;
    return el("span", { class: "text-dim ua-changed", title: changed.map((c) => say(c, c.name)).join(", ") }, changed.map((c) => say(c, c.name.slice(c.name.indexOf("/") + 1))).join(", "));
  }

  /** What this workspace runs, and what it is meant to run and is not: a failed service is a badge with since when. */
  function servicesCell(row) {
    const down = Array.isArray(row.down) ? row.down : [];
    const short = (name) => name.slice(name.indexOf("/") + 1);
    return el(
      "div",
      { class: "ua-code" },
      tags(row.services ?? [], "dim", down.length ? "none running" : "no service"),
      ...down.map((d) => el("span", { class: "ua-line", title: `${d.name} has not been running since ${clock(d.since)}: ${d.error}` }, badge(`${short(d.name)} not running`, "warn")))
    );
  }

  /** Up to date or Update ready, by the version each package loaded: the same word the extensions pages say. */
  function codeCell(row) {
    const note = notes.get(row.user);
    if (!row.openedAt) return el("div", { class: "ua-code" }, el("span", { class: "text-faint" }, "not open · opens on the next request"), note ? el("span", { class: note.bad ? "ua-refused" : "text-dim" }, note.text) : null);
    const state = (row.changed ?? []).length ? "update" : "current";
    return el("div", { class: "ua-code" }, el("span", { class: "ua-line" }, stateBadge(ext, state), el("span", { class: "text-faint" }, `opened ${clock(row.openedAt)}`)), changedLine(row), note ? el("span", { class: note.bad ? "ua-refused" : "text-dim" }, note.text) : null);
  }

  function actionsCell(r) {
    // A workspace that is not open has nothing to restart: a button there would only look like one.
    if (!r.openedAt) return el("span", { class: "text-faint" }, "—");
    const off = updating ? true : null;
    const go = button("Restart", { tone: "warn", disabled: off, title: updating ? UPDATING : "Restart this workspace; running replies pause at a safe point", onClick: () => void run(go, "drain") });
    const force = button("Force…", { tone: "quiet", disabled: off, title: updating ? UPDATING : "Restart now, stopping running replies at once", onClick: () => void run(force, "force") });
    async function run(anchor, mode) {
      if (!(await (mode === "force" ? askForce(anchor, r) : ask(anchor, r)))) return;
      go.disabled = force.disabled = true;
      try {
        await restart(r.user, mode);
      } finally {
        go.disabled = force.disabled = updating;
      }
    }
    return el("span", { class: "ua-line" }, go, force);
  }

  function draw() {
    clear(wrap);
    if (failed) return void put(wrap, heading("Workspaces"), failedCard(ext, "The workspaces", failed, { admin: true, retry: () => void load() }));
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Workspaces", `${rows.length} ${rows.length === 1 ? "workspace" : "workspaces"}`)),
      updating ? el("p", { class: "ua-broken" }, `${UPDATING} Restarting a workspace waits until then.`) : null,
      serverCard(),
      table(
        [
          { key: "user", label: "Workspace", render: (r) => el("span", { class: "ua-line" }, el("code", {}, r.user), r.user === user ? el("span", { class: "text-faint" }, " (me)") : null, r.user === SYSTEM ? badge("system", "accent") : null) },
          { key: "code", label: "Code", render: codeCell },
          { key: "services", label: "Services", render: servicesCell },
          { key: "actions", label: "", render: actionsCell },
        ],
        rows,
        { rowKey: (r) => r.user, empty: "No workspace has been opened yet." }
      ),
      el("p", { class: "panel-hint" }, "A tool's code is read again on every call, and a page's files on every request: new code in those is live already. A service, a provider and the agent itself are read when the workspace opens, so restarting the workspace is how new code in those goes live. Restart waits for running replies to reach a safe point; Force stops them at once. Either way they continue by themselves. Updating Thetis itself is the Overview's.")
    );
  }

  void load();
}

/** A moment as a clock time, which is what an operator compares. ISO strings and epoch milliseconds read the same. */
function clock(at) {
  const ms = typeof at === "number" ? at : Date.parse(at ?? "");
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "an unknown time";
}

function upFor(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n)) return "an unknown time";
  if (n < 90) return `${Math.max(0, Math.round(n))} s`;
  const m = Math.round(n / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}
