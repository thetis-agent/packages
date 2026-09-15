/* Conversation tabs: one pane per open conversation, one tab per pane, a `+` that starts a new one.
 * A pane is a chat bar (title, state, chips, the model and spend facts, archive) over its own transcript
 * instance, so switching tabs only shows and hides panes: a background conversation keeps receiving
 * its events and is never rebuilt. The composer sits below the panes and follows the active tab through
 * `store.current`. Closing the active tab activates its neighbour; closing the last shows the empty
 * state. Live events are routed here by session, with the per-session `drawn` mark that keeps an event
 * the record already carried from being drawn twice. Chip buttons come from the registry's `chips`
 * slot and are drawn into every pane, because a chip is a fact about that pane's conversation. */

import { fmtCost, shortModel } from "../lib/activity.js";
import { api } from "../lib/api.js";
import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { titleOf } from "./sessions.js";
import { emptyState, mountTranscript } from "./transcript.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
const ARCHIVE = ["M3.5 5.5h13v2.5h-13zM4.5 8v7.5h11V8M8 11h4"];

export function mountTabs({ onNew, onArchive, onRename, onModel }) {
  const strip = $("tabs");
  const host = $("panes");
  const newTab = $("new-tab");
  const panes = new Map(); // session id -> { id, node, tab, dot, label, transcript, bar, chips, drawn }
  const order = [];        // open session ids, in tab order
  const empty = el("section", { class: "pane is-empty is-active" }, emptyState("none", onNew));
  host.append(empty);

  newTab.addEventListener("click", () => onNew());

  // ---- one pane ----

  function createPane(id) {
    const bar = {
      title: el("button", { type: "button", class: "chat-title", title: "Rename this conversation", onClick: () => onRename(id) }),
      state: el("span", { class: "chat-state", hidden: true }),
      model: el("button", { type: "button", class: "chip-quiet mono chip-model", onClick: () => onModel(id) }),
      spend: el("span", { class: "chip-quiet mono chip-spend" }),
      archive: el("button", { type: "button", class: "icon-btn sm archive-chat", onClick: () => onArchive(id) }, icon(ARCHIVE, { size: 16, width: 1.6 })),
    };
    const chips = el("div", { class: "chips", id: `chips-${id}` });
    const root = el("div", { class: "transcript", tabindex: "0" });
    const node = el("section", { class: "pane", "data-session": id, role: "tabpanel" }, el("div", { class: "chat-bar" }, bar.title, bar.state, el("span", { class: "chat-bar-gap" }), chips, bar.model, bar.spend, bar.archive), root);
    const dot = el("span", { class: "tab-dot", "aria-hidden": "true" });
    const label = el("span", { class: "tab-title" });
    const tab = el(
      "div",
      { class: "tab", "data-session": id },
      el("button", { type: "button", class: "tab-open", role: "tab", onClick: () => activate(id) }, dot, label),
      el("button", { type: "button", class: "tab-close", title: "Close this tab", "aria-label": "Close this tab", onClick: () => close(id) }, icon(X, { size: 10, width: 2 }))
    );
    strip.insertBefore(tab, newTab);
    host.append(node);
    const pane = { id, node, tab, dot, label, bar, chips, transcript: mountTranscript(root, { session: id }), drawn: { turn: null, seq: 0 } };
    panes.set(id, pane);
    drawChips(pane);
    drawBar(pane);
    return pane;
  }

  async function load(pane) {
    try {
      const record = await api(`/api/sessions/${pane.id}`);
      if (!panes.has(pane.id)) return;
      pane.transcript.restore(record);
      pane.drawn = record.turn ? { turn: record.turn.turn || "pending", seq: record.turn.events.at(-1)?.seq ?? 0 } : { turn: null, seq: 0 };
      store.mark("running", pane.id, Boolean(record.turn));
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  // ---- the chat bar and the tab, from the store ----

  function drawBar(pane) {
    const { id, bar } = pane;
    const session = store.session(id);
    const activity = store.activityOf(id);
    bar.title.textContent = titleOf(session);
    const working = store.isRunning(id);
    setHidden(bar.state, !working);
    bar.state.textContent = activity?.state === "working" ? (activity.tool ? activity.step : activity.step.toLowerCase()) : "working";
    const cost = (session?.cost ?? 0) + (activity?.state === "working" ? activity.cost : 0);
    setHidden(bar.spend, !(cost > 0));
    bar.spend.textContent = fmtCost(cost);
    bar.spend.title = working ? "Spent in this conversation, counting the running turn" : "Spent in this conversation";
    bar.spend.classList.toggle("is-live", working && activity?.cost > 0);
    bar.model.textContent = shortModel(store.modelFor(id)) || "model";
    bar.model.title = session?.model ? `Answers with ${session.model}` : "Answers with the default model";
    bar.model.classList.toggle("is-set", Boolean(session?.model));
    bar.archive.title = session?.archived ? "Restore this conversation" : "Archive this conversation";
    bar.archive.setAttribute("aria-label", bar.archive.title);
    bar.archive.classList.toggle("is-archived", Boolean(session?.archived));
    pane.label.textContent = titleOf(session);
    pane.tab.title = titleOf(session);
    pane.tab.classList.toggle("is-working", working);
    pane.tab.classList.toggle("is-archived", Boolean(session?.archived));
  }

  function drawAll() {
    for (const pane of panes.values()) drawBar(pane);
  }

  // ---- chips: every declared chip, in every pane; the package draws the text and decides if it shows ----

  function drawChips(pane, only) {
    for (const entry of registry.entries("chips")) {
      if (only && entry.package !== only) continue;
      let button = pane.chips.querySelector(`[data-chip="${CSS.escape(entry.key)}"]`);
      if (!button) {
        button = el("button", { type: "button", class: "chip-quiet chip", "data-chip": entry.key, onClick: () => {
          const impl = registry.entry("chips", entry.key)?.impl;
          if (impl?.open) registry.guard(entry.package, "chips", impl.open, { session: pane.id, button });
        } }, entry.decl.label || entry.id);
        pane.chips.append(button);
      }
      const failed = registry.failureOf(entry.package);
      button.classList.toggle("is-broken", Boolean(failed));
      if (failed) {
        button.title = `${entry.package} could not load`;
        setHidden(button, false);
        continue;
      }
      if (!entry.impl?.draw) {
        setHidden(button, true);
        continue;
      }
      const out = registry.guard(entry.package, "chips", entry.impl.draw, button, { session: pane.id });
      if (!out.ok) {
        button.textContent = `${entry.package} could not draw this`;
        setHidden(button, false);
      }
    }
  }

  registry.watch((change) => {
    const about = change.kind === "declare" || change.kind === "fail" || change.kind === "redraw" || (change.kind === "register" && change.slot === "chips");
    if (!about) return;
    for (const pane of panes.values()) drawChips(pane, change.kind === "redraw" ? change.package : null);
  });

  // ---- open, activate, close ----

  function activate(id) {
    const pane = panes.get(id);
    if (!pane) return;
    store.set({ current: id });
    for (const p of panes.values()) {
      p.node.classList.toggle("is-active", p === pane);
      p.tab.classList.toggle("is-active", p === pane);
      p.tab.querySelector(".tab-open").setAttribute("aria-selected", p === pane ? "true" : "false");
    }
    empty.classList.remove("is-active");
    pane.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    pane.transcript.shown();
  }

  async function open(id) {
    if (panes.has(id)) return activate(id);
    const pane = createPane(id);
    order.push(id);
    store.set({ tabs: [...order] });
    activate(id);
    await load(pane);
  }

  function close(id) {
    const pane = panes.get(id);
    if (!pane) return;
    const at = order.indexOf(id);
    order.splice(at, 1);
    panes.delete(id);
    pane.node.remove();
    pane.tab.remove();
    store.set({ tabs: [...order] });
    if (store.get("current") !== id) return;
    const next = order[at] ?? order[at - 1];
    if (next) return activate(next);
    store.set({ current: null });
    empty.classList.add("is-active");
  }

  /** One message off the event stream, to the pane of its session, if that conversation is open. */
  function applyTurn(message) {
    const pane = panes.get(message.session);
    if (!pane) return;
    const turn = message.turn || "pending";
    if (turn === pane.drawn.turn && message.seq <= pane.drawn.seq) return;
    if (turn !== pane.drawn.turn) pane.drawn = { turn, seq: 0 };
    pane.drawn.seq = message.seq;
    pane.transcript.applyEvent(message.event, message.input);
  }

  /** After a reconnect: every open pane is rebuilt from its record, which carries the turn in progress. */
  async function reload() {
    await Promise.all([...panes.values()].map(load));
  }

  for (const key of ["current", "sessions", "running", "activity", "choices"]) store.watch(key, drawAll);

  return {
    open,
    activate,
    close,
    applyTurn,
    reload,
    list: () => [...order],
    transcriptOf: (id) => panes.get(id)?.transcript ?? null,
  };
}
