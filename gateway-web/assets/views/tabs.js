/* Conversation tabs: one pane per open conversation, one tab per pane, a `+` that starts a new one.
 * A pane is a chat bar (title, state, chips, the model and spend facts, archive) over its own transcript
 * instance, so switching tabs only shows and hides panes: a background conversation keeps receiving
 * its events and is never rebuilt. The composer sits below the panes and follows the active tab through
 * `store.current`. Closing the active tab activates its neighbour; closing the last shows the empty
 * state. Live events are routed here by session, with the per-session `drawn` mark that keeps an event
 * the record already carried from being drawn twice. Chip buttons come from the registry's `chips`
 * slot and are drawn into every pane, because a chip is a fact about that pane's conversation.
 *
 * Only the `KEEP` most recently shown panes keep their rows built: a tab further back keeps its tab and
 * bar, but its transcript is emptied, its events are not drawn, and it is rebuilt from its record when it
 * is shown again (the record carries the turn in progress, so nothing is missed). Without that, every
 * conversation opened in a day stays in the page, and the page slows with each one.
 *
 * A subagent opens as a tab too (`open(childId)`, an id the store knows as an agent): its bar shows a
 * dot, the label, the state, the spend, "Show in conversation" and, while it works, Stop. No rename, no
 * chips, no model, no archive: a child is work inside a conversation, not a conversation. Its events
 * reach its own pane as any session's do, and, through `applyChild`, the pane of every open ancestor,
 * where its block lives. */

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
const STOP = ["M6.5 6.5h7v7h-7z"];
const KEEP = 5; // panes with their rows built: the shown one and the ones shown most recently

export function mountTabs({ onNew, onClosed, onArchive, onRename, onModel }) {
  const strip = $("tabs");
  const host = $("panes");
  const newTab = $("new-tab");
  const panes = new Map(); // session id -> { id, agent, node, tab, dot, label, note, transcript, bar, chips, drawn, built }
  const order = [];        // open session ids, in tab order
  const recent = [];       // open session ids, most recently shown first: the first KEEP stay built
  const empty = el("section", { class: "pane is-empty is-active" }, emptyState("none", onNew));
  host.append(empty);

  newTab.addEventListener("click", () => onNew());

  // ---- one pane ----

  function createPane(id) {
    const agent = store.isAgent(id);
    const bar = agent
      ? {
          dot: el("span", { class: "chat-dot", "aria-hidden": "true" }),
          title: el("span", { class: "chat-title is-agent" }),
          word: el("span", { class: "chat-agent-state" }),
          state: el("span", { class: "chat-state", hidden: true }),
          spend: el("span", { class: "chip-quiet mono chip-spend" }),
          parent: el("button", { type: "button", class: "ghost-btn sm chat-parent", title: "Show this subagent's block in its conversation", onClick: () => { void reveal(id, { open: true, self: false }); } }, "Show in conversation"),
          stop: el("button", { type: "button", class: "stop-btn sm chat-stop", title: "Stop this subagent", "aria-label": "Stop this subagent", hidden: true, onClick: () => { void cancel(id); } }, icon(STOP, { size: 14, width: 0 }), "Stop"),
        }
      : {
          title: el("button", { type: "button", class: "chat-title", title: "Rename this conversation", onClick: () => onRename(id) }),
          state: el("span", { class: "chat-state", hidden: true }),
          model: el("button", { type: "button", class: "chip-quiet mono chip-model", onClick: () => onModel(id) }),
          spend: el("span", { class: "chip-quiet mono chip-spend" }),
          archive: el("button", { type: "button", class: "icon-btn sm archive-chat", onClick: () => onArchive(id) }, icon(ARCHIVE, { size: 16, width: 1.6 })),
        };
    if (agent) bar.stop.querySelector("path").setAttribute("fill", "currentColor");
    const chips = agent ? null : el("div", { class: "chips", id: `chips-${id}` });
    const root = el("div", { class: "transcript", tabindex: "0" });
    const node = agent
      ? el("section", { class: "pane is-agent", "data-session": id, role: "tabpanel" }, el("div", { class: "chat-bar is-agent" }, bar.dot, bar.title, bar.word, bar.state, el("span", { class: "chat-bar-gap" }), bar.spend, bar.parent, bar.stop), root)
      : el("section", { class: "pane", "data-session": id, role: "tabpanel" }, el("div", { class: "chat-bar" }, bar.title, bar.state, el("span", { class: "chat-bar-gap" }), chips, bar.model, bar.spend, bar.archive), root);
    const dot = el("span", { class: "tab-dot", "aria-hidden": "true" });
    const label = el("span", { class: "tab-title" });
    const note = agent ? el("span", { class: "tab-note" }) : null;
    const tab = el(
      "div",
      { class: `tab${agent ? " is-agent" : ""}`, "data-session": id },
      el("button", { type: "button", class: "tab-open", role: "tab", onClick: () => activate(id) }, dot, label, note),
      el("button", { type: "button", class: "tab-close", title: "Close this tab", "aria-label": "Close this tab", onClick: () => close(id) }, icon(X, { size: 10, width: 2 }))
    );
    strip.insertBefore(tab, newTab);
    host.append(node);
    const transcript = mountTranscript(root, { session: id, brief: agent, onOpenAgent: (child) => { void open(child); } });
    const pane = { id, agent, node, tab, dot, label, note, bar, chips, transcript, drawn: { turn: null, seq: 0 }, built: false };
    panes.set(id, pane);
    drawChips(pane);
    drawBar(pane);
    return pane;
  }

  /** Builds a pane's rows from its record. A pane dropped while the record was on its way stays empty. */
  async function load(pane) {
    pane.built = true;
    try {
      const record = await api(`/api/sessions/${pane.id}`);
      if (!panes.has(pane.id) || !pane.built) return;
      pane.transcript.restore(record);
      pane.drawn = record.turn ? { turn: record.turn.turn || "pending", seq: record.turn.events.at(-1)?.seq ?? 0 } : { turn: null, seq: 0 };
      store.mark("running", pane.id, Boolean(record.turn));
    } catch (err) {
      pane.built = false;
      toast(err.message, { tone: "error" });
    }
  }

  /** Shown now: first in `recent`; the panes past KEEP give up their rows. */
  function keep(id) {
    const at = recent.indexOf(id);
    if (at >= 0) recent.splice(at, 1);
    recent.unshift(id);
    for (const old of recent.splice(KEEP)) drop(panes.get(old));
  }

  function drop(pane) {
    if (!pane?.built) return;
    pane.built = false;
    pane.drawn = { turn: null, seq: 0 };
    pane.transcript.reset();
  }

  async function cancel(id) {
    try {
      await api(`/api/sessions/${id}/cancel`, { method: "POST" });
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  // ---- the chat bar and the tab, from the store ----

  function drawBar(pane) {
    if (pane.agent) return drawAgentBar(pane);
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

  /** A subagent's bar: the label, the state word, the step while it works, and its spend. */
  function drawAgentBar(pane) {
    const { id, bar } = pane;
    const agent = store.agent(id);
    const activity = store.activityOf(id);
    const working = store.isRunning(id) || activity?.state === "working";
    const label = agent?.label || "subagent";
    const word = working ? "working" : agent?.outcome || (activity?.state === "failed" ? "failed" : activity?.state === "stopped" ? "stopped" : "done");
    const bad = word === "failed" || word === "stopped";
    bar.title.textContent = label;
    bar.title.title = agent?.task ? `${label} · ${agent.task}` : label;
    bar.word.textContent = word;
    setHidden(bar.state, !working);
    bar.state.textContent = activity?.state === "working" ? (activity.tool ? activity.step : activity.step.toLowerCase()) : "working";
    const cost = (agent?.cost ?? 0) + (activity?.state === "working" ? activity.cost : 0);
    setHidden(bar.spend, !(cost > 0));
    bar.spend.textContent = fmtCost(cost);
    bar.spend.title = working ? "Spent by this subagent, counting the running turn" : "Spent by this subagent";
    bar.spend.classList.toggle("is-live", working && activity?.cost > 0);
    setHidden(bar.stop, !working);
    for (const node of [bar.dot, pane.tab]) {
      node.classList.toggle("is-working", working);
      node.classList.toggle("is-bad", bad);
    }
    pane.label.textContent = label;
    pane.note.textContent = cost > 0 ? fmtCost(cost) : "";
    pane.tab.title = `${label} · ${word}${agent?.task ? ` · ${agent.task}` : ""}`;
  }

  function drawAll() {
    for (const pane of panes.values()) drawBar(pane);
  }

  // ---- chips: every declared chip, in every pane; the package draws the text and decides if it shows ----

  function drawChips(pane, only) {
    if (!pane.chips) return;
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

  /** Shows a pane, building its rows first when it has none. Resolves once they are built. */
  async function activate(id) {
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
    keep(id);
    if (pane.built) return pane.transcript.shown();
    await load(pane);
  }

  async function open(id) {
    if (panes.has(id)) return activate(id);
    createPane(id);
    order.push(id);
    store.set({ tabs: [...order] });
    await activate(id);
  }

  /**
   * Closes a pane, and tells `onClosed` once the tab is gone and the conversation on screen has moved off
   * it. The order is the point: what that hook does — discarding a conversation nothing was ever said in —
   * must not happen while the id is still `current`, still in `tabs`, and still the one in the address bar.
   */
  function close(id) {
    const pane = panes.get(id);
    if (!pane) return;
    const at = order.indexOf(id);
    order.splice(at, 1);
    recent.splice(recent.indexOf(id) >>> 0, 1);
    panes.delete(id);
    pane.node.remove();
    pane.tab.remove();
    store.set({ tabs: [...order] });
    if (store.get("current") === id) {
      const next = order[at] ?? order[at - 1];
      if (next) void activate(next); // `current` moves synchronously, inside activate, before it awaits anything
      else {
        store.set({ current: null });
        empty.classList.add("is-active");
      }
    }
    onClosed?.(id);
  }

  /**
   * Brings a subagent on screen: its own pane when one is open (unless `self` is false: the way back
   * from that pane), else its block in its conversation's pane, revealed and flashed. With `open`, the
   * conversation is opened first when it is not. False when there is nothing to show.
   */
  async function reveal(id, { open: mayOpen = false, self = true } = {}) {
    if (self && panes.has(id)) {
      activate(id);
      return true;
    }
    const root = store.rootOf(id);
    if (root === id) return false;
    if (!panes.has(root)) {
      if (!mayOpen) return false;
      await open(root);
    }
    await activate(root);
    return Boolean(panes.get(root)?.transcript.revealAgent(id));
  }

  /** One message off the event stream: to the pane of its session, if built, and to the block in every built ancestor's pane. */
  function applyTurn(message) {
    const pane = panes.get(message.session);
    if (pane?.built) {
      const turn = message.turn || "pending";
      const seen = turn === pane.drawn.turn && message.seq <= pane.drawn.seq;
      if (!seen) {
        if (turn !== pane.drawn.turn) pane.drawn = { turn, seq: 0 };
        pane.drawn.seq = message.seq;
        pane.transcript.applyEvent(message.event, message.input);
      }
    }
    for (let up = message.parent, hops = 0; up && hops < 32; up = store.agent(up)?.parent, hops += 1) {
      const above = panes.get(up);
      if (above?.built) above.transcript.applyChild(message);
    }
  }

  /** After a reconnect: every built pane is rebuilt from its record, which carries the turn in progress. */
  async function reload() {
    await Promise.all([...panes.values()].filter((p) => p.built).map(load));
  }

  for (const key of ["current", "sessions", "running", "activity", "choices", "agents"]) store.watch(key, drawAll);

  return {
    open,
    activate,
    close,
    reveal,
    applyTurn,
    reload,
    list: () => [...order],
    transcriptOf: (id) => panes.get(id)?.transcript ?? null,
  };
}
