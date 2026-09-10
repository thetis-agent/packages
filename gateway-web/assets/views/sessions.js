/* The conversation sidebar: navigation, and nothing else.
 *
 * Search filters as you type; the list sorts by most-recent activity. The
 * legacy sidebar also grouped by day, showed a live per-conversation activity
 * feed (working/waiting/failed, ticking elapsed time), nested sub-agent rows
 * under their parent, and — for a role that could see everyone's work — a
 * whole second grouping by owner with an "all conversations" toggle. None of
 * that has a wire to speak to any more: `sessions` replies with whatever
 * `session.list` returns (no activity snapshots, no sub-agents, no owner
 * field, no archive/unarchive command), and there is no "see everyone's
 * conversations" concept at all — this sidebar is always just the signed-in
 * person's own conversations, full stop.
 *
 * The one still-live signal is `store.busyIds`: any conversation with a turn
 * running shows a working dot, whether or not it is the one on screen — a
 * turn a background tab started keeps going, and the sidebar is where that
 * shows without switching to it.
 */

import { $, clear, el } from "../lib/dom.js";
import { store } from "../lib/store.js";

let query = "";

function when(session) {
  const ms = session.updated_ms || session.created_ms;
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function mountSessions({ onOpen, onNew }) {
  const list = $("session-list");
  const search = $("session-search");
  $("new-chat").addEventListener("click", onNew);

  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  // "/" focuses search from anywhere that is not already an input.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    event.preventDefault();
    search.focus();
  });

  const matches = (session) =>
    !query ||
    String(session.title || session.id || "").toLowerCase().includes(query) ||
    String(session.preview || "").toLowerCase().includes(query);

  const row = (session) => {
    const active = session.id === store.current;
    const working = store.isBusy(session.id);
    return el(
      "button",
      {
        class: `session${working ? " is-working" : ""}${active ? " is-active" : ""}`,
        dataset: { session: session.id },
        title: session.title || session.id,
        onClick: () => onOpen(session.id),
      },
      el(
        "div",
        { class: "session-title" },
        working ? el("span", { class: "session-dot" }) : null,
        el("span", { class: "session-title-text" }, session.title || "Untitled"),
        el("span", { class: "session-when" }, when(session))
      ),
      el("div", { class: "session-line" }, working ? "Working…" : session.preview || "No messages yet")
    );
  };

  function draw() {
    clear(list);
    const all = [...(store.sessions || [])].sort(
      (a, b) => (b.updated_ms || b.created_ms || 0) - (a.updated_ms || a.created_ms || 0)
    );
    const visible = all.filter(matches);

    if (!all.length) {
      list.append(el("div", { class: "session-empty" }, "No conversations yet — start one with the + button."));
      return;
    }
    if (!visible.length) {
      list.append(el("div", { class: "session-empty" }, "Nothing matches — try fewer words, or clear the search."));
      return;
    }
    for (const session of visible) list.append(row(session));
  }

  store.watch("sessions", draw);
  store.watch("current", draw);
  store.watch("busyIds", draw);
  draw();
}
