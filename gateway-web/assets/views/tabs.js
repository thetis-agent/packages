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
 * where its block lives.
 *
 * A package's tab is a third shape (`openKind`): a pane of a declared `tabs` kind, keyed `<kind>:<id>`, whose
 * body the package draws whole through `open(root, handle)`; no chat bar, no transcript, no chips, never
 * dropped for being far back. While one is shown `current` is null — no conversation is on screen, as in a
 * `+` draft — and `activeTab` names it, which is what the composer hides on and the address bar writes. A
 * kind declared but not yet registered shows "Loading…" and is drawn when its module lands. */

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

/** The pane key of a tab: a conversation's is its session id; a package's is `<kind>:<id>`. */
export const keyOf = (kind, id) => (kind === "session" ? id : `${kind}:${id}`);

export function mountTabs({ onNew, onClosed, onArchive, onRename, onModel, onExample }) {
  const strip = $("tabs");
  const host = $("panes");
  const newTab = $("new-tab");
  const panes = new Map(); // pane key -> { id, kind, agent, node, tab, dot, label, note, transcript, bar, chips, drawn, built } (a package's pane: kind, entry, params, body, impl)
  const order = [];        // open pane keys, in tab order
  const recent = [];       // open session ids, most recently shown first: the first KEEP stay built
  const empty = el("section", { class: "pane is-empty is-active" }, emptyState("none", onNew));
  host.append(empty);

  /** The pane shown when no conversation is: "none" offers to start one, "new" is a new one not yet said anything in. */
  function showEmpty(kind) {
    empty.replaceChildren(emptyState(kind === "new" ? "new" : "none", onNew, onExample));
    empty.classList.toggle("is-new", kind === "new");
    empty.classList.add("is-active");
  }

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
    const pane = { id, kind: "session", agent, node, tab, dot, label, note, bar, chips, transcript, drawn: { turn: null, seq: 0 }, built: false, restored: false };
    panes.set(id, pane);
    drawChips(pane);
    drawBar(pane);
    return pane;
  }

  // ---- a package's pane ----

  function createKindPane(entry, id, params) {
    const key = keyOf(entry.id, id);
    const body = el("div", { class: "kind-body" });
    const node = el("section", { class: "pane is-kind", "data-kind": entry.id, "data-key": key, role: "tabpanel" }, body);
    const label = el("span", { class: "tab-title" }, entry.decl.label || entry.id);
    const note = el("span", { class: "tab-note" });
    const tab = el(
      "div",
      { class: "tab is-kind", "data-kind": entry.id, "data-key": key },
      el("button", { type: "button", class: "tab-open", role: "tab", onClick: () => activate(key) }, entry.decl.icon ? icon(entry.decl.icon, { size: 13, width: 1.6 }) : null, label, note),
      el("button", { type: "button", class: "tab-close", title: "Close this tab", "aria-label": "Close this tab", onClick: () => close(key) }, icon(X, { size: 10, width: 2 }))
    );
    tab.title = entry.decl.label || entry.id;
    strip.insertBefore(tab, newTab);
    host.append(node);
    const pane = { id, key, kind: entry.id, entry, params: params ?? {}, node, tab, label, note, body, impl: null, transcript: null, chips: null, built: true, drawn: { turn: null, seq: 0 } };
    panes.set(key, pane);
    mountKind(pane);
    return pane;
  }

  /** Draws a package's pane: now when its module has registered, else "Loading…" until it does, or the broken note when it failed to load. */
  function mountKind(pane) {
    const entry = registry.entry("tabs", pane.entry.key);
    clear(pane.body);
    if (!entry?.impl?.open) {
      pane.body.append(registry.failureOf(pane.entry.package) ? registry.broken(pane.entry.package) : el("div", { class: "panel-empty" }, "Loading…"));
      return;
    }
    const handle = {
      id: pane.id,
      kind: pane.kind,
      params: pane.params,
      setTitle: (text) => { pane.label.textContent = text; pane.tab.title = text; },
      setNote: (text) => { pane.note.textContent = text ?? ""; },
      close: () => close(pane.key),
    };
    const out = registry.guard(entry.package, "tabs", entry.impl.open, pane.body, handle);
    if (!out.ok) {
      pane.body.append(registry.broken(entry.package));
      return;
    }
    pane.impl = typeof out.value === "function" ? { unmount: out.value } : out.value && typeof out.value === "object" ? out.value : {};
    if (isShown(pane)) hook(pane, "activate");
  }

  /** One of a package pane's hooks, if it gave one; a throw is the package's and is reported, never the shell's. */
  function hook(pane, name) {
    const fn = pane.impl?.[name];
    if (typeof fn !== "function") return;
    try {
      fn();
    } catch (err) {
      console.error(`${pane.entry.package} threw in its tab's ${name}:`, err);
    }
  }

  const isShown = (pane) => {
    const shown = store.get("activeTab");
    return Boolean(shown && shown.kind === pane.kind && shown.id === pane.id);
  };

  /** The package pane on screen, if the active tab is one. */
  function shownKind() {
    const shown = store.get("activeTab");
    return shown && shown.kind !== "session" ? panes.get(keyOf(shown.kind, shown.id)) ?? null : null;
  }

  /** Builds a pane's rows from its record. A pane dropped while the record was on its way stays empty. */
  async function load(pane) {
    pane.built = true;
    // A replacement load also owns prior buffered events if its refresh fails.
    const loading = { events: pane.loading?.events ?? [] };
    pane.loading = loading;
    try {
      let record, buffered;
      for (;;) {
        const from = loading.events.length;
        record = await api(`/api/sessions/${pane.id}`);
        if (panes.get(pane.id) !== pane || !pane.built || pane.loading !== loading) return;
        buffered = loading.events.slice(from);
        // A completed turn is now in history and has no sequence watermark. Reread after its end
        // instead of guessing whether these buffered messages are already in the saved conversation.
        if (!buffered.some((message) => message.event.type === "turn.end")) break;
      }
      pane.transcript.restore(record);
      pane.restored = true;
      pane.drawn = record.turn ? { turn: record.turn.turn || "pending", seq: record.turn.events.at(-1)?.seq ?? 0 } : { turn: null, seq: 0 };
      if (!buffered.some((message) => message.session === pane.id)) store.mark("running", pane.id, Boolean(record.turn));
      pane.loading = null;
      for (const message of buffered) deliver(pane, message);
    } catch (err) {
      if (panes.get(pane.id) !== pane || pane.loading !== loading) return;
      pane.loading = null;
      pane.built = pane.restored;
      for (const message of loading.events) deliver(pane, message);
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
    pane.restored = false;
    pane.loading = null;
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
    if (pane.kind !== "session") return;
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
    bar.spend.title = working ? "Cost of this chat so far, counting the reply being written" : "Cost of this chat";
    bar.spend.classList.toggle("is-live", working && activity?.cost > 0);
    bar.model.textContent = shortModel(store.modelFor(id)) || "model";
    bar.model.title = `The model that answers in this chat: ${store.modelFor(id) || "the default"}. Click to change it.`;
    bar.model.classList.toggle("is-set", Boolean(session?.model));
    bar.archive.title = session?.archived ? "Put this chat back in the list" : "Archive this chat: it leaves the list and nothing is deleted";
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
    bar.spend.title = working ? "Cost of this subagent so far, counting the reply being written" : "Cost of this subagent";
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
        button.title = `The ${entry.package} extension could not load`;
        setHidden(button, false);
        continue;
      }
      if (!entry.impl?.draw) {
        setHidden(button, true);
        continue;
      }
      const out = registry.guard(entry.package, "chips", entry.impl.draw, button, { session: pane.id });
      if (!out.ok) {
        button.textContent = `The ${entry.package} extension could not draw this`;
        setHidden(button, false);
      }
      // Every chip says what it is on hover: the package's own sentence when its draw set one, else the
      // hint or label it declared. A chip is a few characters of monospace, and they all look alike.
      else if (!button.title) button.title = entry.decl.hint || entry.decl.label || "";
    }
  }

  registry.watch((change) => {
    // A package's tab kind registered (or failed) after a pane was opened on its declaration: draw it now.
    if (change.kind === "fail" || (change.kind === "register" && change.slot === "tabs")) {
      for (const pane of panes.values()) if (pane.kind !== "session" && !pane.impl && (change.kind === "fail" ? pane.entry.package === change.package : pane.entry.key === registry.keyOf(change.package, change.id))) mountKind(pane);
    }
    const about = change.kind === "declare" || change.kind === "fail" || change.kind === "redraw" || (change.kind === "register" && change.slot === "chips");
    if (!about) return;
    for (const pane of panes.values()) drawChips(pane, change.kind === "redraw" ? change.package : null);
  });

  // ---- open, activate, close ----

  /** Shows a pane, building its rows first when it has none. Resolves once they are built. `key` is a session id or a package pane's key. */
  async function activate(key) {
    const pane = panes.get(key);
    if (!pane) return;
    const before = shownKind();
    if (before && before !== pane) hook(before, "deactivate");
    // One `set` for both, so a watcher of either sees them agree: a conversation on screen, or none and which tab instead.
    const shown = store.get("activeTab");
    const same = shown && shown.kind === pane.kind && shown.id === pane.id;
    store.set({ current: pane.kind === "session" ? pane.id : null, activeTab: same ? shown : { kind: pane.kind, id: pane.id } });
    for (const p of panes.values()) {
      p.node.classList.toggle("is-active", p === pane);
      p.tab.classList.toggle("is-active", p === pane);
      p.tab.querySelector(".tab-open").setAttribute("aria-selected", p === pane ? "true" : "false");
    }
    empty.classList.remove("is-active");
    pane.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (pane.kind !== "session") {
      if (before !== pane) hook(pane, "activate");
      return;
    }
    keep(key);
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
   * A package's tab: `entryKey` names the registry's `tabs` entry, `id` what the tab is about. The one already
   * open for `id` is shown again; else a pane is made and shown. False when no package declares that kind here.
   */
  async function openKind(entryKey, id, params) {
    const entry = registry.entry("tabs", entryKey);
    if (!entry) return false;
    const key = keyOf(entry.id, id);
    if (!panes.has(key)) {
      createKindPane(entry, id, params);
      order.push(key);
      store.set({ tabs: [...order] });
    }
    await activate(key);
    return true;
  }

  function closeKind(entryKey, id) {
    const entry = registry.entry("tabs", entryKey);
    if (entry) close(keyOf(entry.id, id));
  }

  /**
   * Closes a pane, and tells `onClosed` once the tab is gone and the conversation on screen has moved off
   * it. The order is the point: what that hook does — discarding a conversation nothing was ever said in —
   * must not happen while the id is still `current`, still in `tabs`, and still the one in the address bar.
   * A package's pane is unmounted first, and `onClosed` is not for it: nothing of it was on the server.
   */
  function close(key) {
    const pane = panes.get(key);
    if (!pane) return;
    const at = order.indexOf(key);
    order.splice(at, 1);
    recent.splice(recent.indexOf(key) >>> 0, 1);
    panes.delete(key);
    const wasShown = isShown(pane);
    if (pane.kind !== "session") hook(pane, "unmount");
    pane.node.remove();
    pane.tab.remove();
    store.set({ tabs: [...order] });
    if (wasShown) {
      const next = order[at] ?? order[at - 1];
      if (next) void activate(next); // `current` moves synchronously, inside activate, before it awaits anything
      else {
        store.set({ current: null, activeTab: null });
        showEmpty("none");
      }
    }
    if (pane.kind === "session") onClosed?.(pane.id);
  }

  /**
   * A new conversation that does not exist yet: no pane is active, nothing is created on the server, and
   * the composer's first send creates it. A click on `+` that is never followed by a message leaves
   * nothing behind to be tidied away.
   */
  function showNew() {
    const before = shownKind();
    if (before) hook(before, "deactivate");
    store.set({ current: null, activeTab: null });
    for (const p of panes.values()) {
      p.node.classList.remove("is-active");
      p.tab.classList.remove("is-active");
      p.tab.querySelector(".tab-open").setAttribute("aria-selected", "false");
    }
    showEmpty("new");
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

  /** A load owns its event buffer until the snapshot and its sequence watermark have been restored. */
  function deliver(pane, message) {
    if (!pane?.built || !pane.transcript) return;
    if (pane.loading) { pane.loading.events.push(message); return; }
    if (pane.id === message.session) {
      const turn = message.turn || "pending";
      const seen = turn === pane.drawn.turn && message.seq <= pane.drawn.seq;
      if (!seen) {
        if (turn !== pane.drawn.turn) pane.drawn = { turn, seq: 0 };
        pane.drawn.seq = message.seq;
        pane.transcript.applyEvent(message.event, message.input, message.messages);
      }
    } else pane.transcript.applyChild(message);
  }

  /** One message off the event stream: to its own pane and to the block in every built ancestor. */
  function applyTurn(message) {
    deliver(panes.get(message.session), message);
    for (let up = message.parent, hops = 0; up && hops < 32; up = store.agent(up)?.parent, hops += 1) {
      deliver(panes.get(up), message);
    }
  }

  /** After a reconnect: every built pane is rebuilt from its record, which carries the turn in progress. */
  async function reload() {
    await Promise.all([...panes.values()].filter((p) => p.built && p.transcript).map(load));
  }

  for (const key of ["current", "sessions", "running", "activity", "choices", "agents"]) store.watch(key, drawAll);

  return {
    open,
    openKind,
    activate,
    close,
    closeKind,
    showNew,
    reveal,
    applyTurn,
    reload,
    list: () => [...order],
    active: () => store.get("activeTab"),
    transcriptOf: (id) => panes.get(id)?.transcript ?? null,
  };
}
