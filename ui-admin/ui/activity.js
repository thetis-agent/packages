/* Activity: the kernel's journal, newest first, in plain words. Each row says what happened (a plain label
 * for its kind, the raw kind in the tooltip), who did it and to whom, and the details it was recorded with.
 * A user gets only the rows where they are the actor or the target -- the kernel narrows them, not this page
 * -- so Who and To stay (an admin's act on you names the admin) and the heading says whose rows these are.
 *
 * The ids the journal uses for Thetis itself and for the host's command line (`daemon`, `operator`) are said
 * as the agent's name ("Thetis" unless an admin renamed it) and "the host", and the raw kind rides in the tooltip only with developer details on.
 *
 * The rows Thetis writes for its own plumbing (`host.call`: one per call a page makes to a host package, many
 * a minute) are hidden unless the person turned on "Show developer details" (`ext.developer()`); the filter
 * offers them only then. A journal that could not be read says so; it is never drawn as "nothing recorded". */

import { failedCard } from "./failed.js";
import { agentName } from "./state.js";

/** Plain words for the kinds the journal writes; a function where the words name the agent. A kind not listed is shown as it is. */
export const KIND_LABELS = Object.freeze({
  "user.create": "Person added",
  "user.remove": "Person removed",
  "user.role": "Role changed",
  "user.status": "Suspended or activated",
  "user.password": "Password set",
  mounts: "Mounts changed",
  ssh: "SSH keys changed",
  "package.install": "Extension installed",
  "package.uninstall": "Extension removed",
  "package.promote": "Shared with everyone",
  "package.everyone": "For everyone turned on or off",
  "package.fork": "Own copy made",
  "package.unfork": "Switched back to the official version",
  "update.start": () => `${agentName()} update started`,
  "update.done": () => `${agentName()} updated`,
  "update.fail": () => `${agentName()} update failed`,
  "update.rolledback": () => `${agentName()} update rolled back`,
  "turn.start": "Reply started",
  "turn.end": "Reply ended",
  "service.start": "Service started",
  "service.stop": "Service stopped",
  "service.fail": "Service failed",
  "fence.reload": "Workspace restarted",
  "fence.open": "Workspace opened",
  "fence.close": "Workspace closed",
  "daemon.start": () => `${agentName()} started`,
  "daemon.stop": () => `${agentName()} stopped`,
  "restart.armed": "Restart asked for",
  "restart.again": "Restart asked for again",
  "restart.refused": "Restart refused",
  "restart.cancel": "Restart called off",
  "restart.fire": () => `${agentName()} restarted`,
  "config.set": "Setting changed",
  "config.unset": "Setting cleared",
  "config.reload": "Settings file read again",
  "host.call": "Server call",
});

/** Who the journal names by an internal id, in words: the server itself, and whoever typed at the host's command line. */
export const actorWords = () => ({ daemon: agentName(), operator: "the host" });

/** A journal's actor or target as a person reads it. */
export const nameOf = (id) => (id ? actorWords()[id] ?? id : "");

/** The kinds only a developer wants: Thetis's own plumbing, not something a person did. */
export const DEVELOPER_KINDS = new Set(["host.call"]);

/** The plain label for a kind. */
export const kindLabel = (kind) => {
  const words = KIND_LABELS[kind];
  return typeof words === "function" ? words() : words ?? kind;
};

/** The rows a person sees: everything, less the plumbing unless they asked for developer details. */
export function visibleRows(rows, developer) {
  return developer ? rows : rows.filter((r) => !DEVELOPER_KINDS.has(r?.kind));
}

const FILTER = ["", "user.create", "user.remove", "user.role", "user.status", "user.password", "mounts", "ssh", "package.install", "package.uninstall", "package.promote", "package.everyone", "update.start", "update.done", "update.fail", "update.rolledback", "turn.start", "turn.end", "fence.reload", "service.start", "service.stop", "service.fail"];
const LIMIT = 300;

export function mountActivity(ext, root, who = {}) {
  const mine = who.role === "user";
  const developer = () => (typeof ext.developer === "function" ? Boolean(ext.developer()) : false);
  const { el, clear } = ext.dom;
  const { badge, busy, heading, put, table, when } = ext.ui;
  let rows = [];
  let kind = "";
  let failed = null;
  const wrap = el("div", { class: "panel-col ua-activity" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  const kinds = () => [...FILTER, ...(developer() ? [...DEVELOPER_KINDS] : [])];
  const pick = el("select", { class: "input", "aria-label": "Kind", onChange: (e) => { kind = e.target.value; void load(); } });
  const fillPick = () => {
    clear(pick);
    for (const k of kinds()) pick.append(el("option", { value: k, selected: k === kind || null }, k ? kindLabel(k) : "everything"));
  };
  const reload = el("button", { type: "button", class: "btn is-quiet", onClick: () => void load() }, "Refresh");

  async function load() {
    const stop = busy(wrap, "Reading the journal…");
    try {
      const out = await ext.request("journal", { args: { limit: LIMIT, kind: kind || undefined } });
      rows = Array.isArray(out.data) ? out.data : [];
      failed = null;
    } catch (err) {
      failed = err;
      rows = [];
    } finally {
      stop();
    }
    draw();
  }

  function tone(k) {
    if (k.endsWith(".fail") || k === "update.rolledback" || k === "user.remove" || k === "package.uninstall" || k === "restart.refused") return "warn";
    if (k === "package.promote" || k === "user.create" || k === "package.install" || k === "mounts" || k === "ssh" || k === "update.done") return "accent";
    return "dim";
  }

  function detail(row) {
    const d = row.data || {};
    const parts = [];
    if (d.name) parts.push(row.kind === "host.call" && d.method ? `${d.name}.${d.method}` : String(d.name));
    if (d.promoted) parts.push(`→ ${d.promoted}`);
    if (d.package) parts.push(String(d.package));
    if (d.role) parts.push(`role ${d.role}`);
    if (d.status) parts.push(`status ${d.status}`);
    if (d.reason) parts.push(String(d.reason));
    if (Array.isArray(d.mounts)) parts.push(d.mounts.length ? d.mounts.map((m) => `${m.path} (${m.mode})`).join(", ") : "no mounts");
    if (Array.isArray(d.ssh)) parts.push(d.ssh.length ? d.ssh.map((k) => String(k).split("/").filter(Boolean).at(-1)).join(", ") : "no keys");
    if (d.turn) parts.push(String(d.turn));
    if (d.why) parts.push(`why: ${d.why}`);
    if (typeof d.ms === "number") parts.push(`${(d.ms / 1000).toFixed(1)} s`);
    if (d.error) parts.push(`error: ${d.error.message || d.error}`);
    if (d.reported && typeof d.reported.cost === "number") parts.push(`$${d.reported.cost.toFixed(4)}`);
    return parts.join(" · ");
  }

  function draw() {
    clear(wrap);
    fillPick();
    const title = mine ? "What was done by you or to you" : "Activity";
    if (failed) return void put(wrap, el("div", { class: "toolbar" }, heading(title), el("div", { class: "toolbar-gap" }), reload), failedCard(ext, "The activity", failed, { admin: !mine, retry: () => void load() }));
    const shown = visibleRows(rows, developer());
    put(
      wrap,
      el("div", { class: "toolbar" }, heading(title, `${shown.length} newest rows`), el("div", { class: "toolbar-gap" }), pick, reload),
      table(
        [
          { key: "at", label: "When", render: (r) => el("span", { class: "text-dim", title: r.at }, when(r.at)) },
          // The raw kind ("fence.reload") is a developer's word: it rides in the tooltip only when they asked for details.
          { key: "kind", label: "What", render: (r) => el("span", { title: developer() ? r.kind : null }, badge(kindLabel(r.kind), tone(r.kind))) },
          { key: "actor", label: "Who", render: (r) => el("code", {}, nameOf(r.actor) || agentName()) },
          { key: "target", label: "To", render: (r) => el("code", {}, nameOf(r.target)) },
          { key: "data", label: "Details", render: (r) => el("span", { class: "text-dim small" }, detail(r)) },
        ],
        shown,
        { rowKey: (r) => r.at + r.kind + (r.target || ""), empty: mine ? "Nothing recorded about you yet." : "Nothing recorded yet." }
      )
    );
  }

  // The person may turn developer details on or off while the page is open: the rows follow.
  const stopDeveloper = typeof ext.onDeveloper === "function" ? ext.onDeveloper(() => draw()) : null;
  void load();
  return () => {
    if (typeof stopDeveloper === "function") stopDeveloper();
  };
}
