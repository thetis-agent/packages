/* The centre stage: a tab per open conversation.
 *
 * The legacy stage opened a tab per sub-agent, per opened file, or for a plan
 * document, beside one permanent, non-closable "chat" tab — none of the
 * former has a wire to speak to any more (no sub-agents, no workspace, no
 * plan). What replaces it is not a literal port of the latter: wire.ts's
 * `#streams` (a `Map` keyed by conversation id) and `#turns` already support
 * many conversations open and running at once, so this stage turns that into
 * what the plan's wireframe shows — a tab per open conversation, `+` opens
 * another. Switching tabs never rebuilds a pane: each keeps its own
 * transcript instance (views/transcript.js's `mountTranscriptInto`), so a
 * background tab goes on receiving `event` frames and a foreground switch
 * only shows and hides DOM that was already there.
 */

import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { titleOf } from "../lib/activity.js";
import { conversationSummary } from "../lib/usage.js";
import { mountTranscriptInto } from "./transcript.js";

const CLOSE = ["M5 5l8 8", "M13 5l-8 8"];
const PLUS = ["M9 3.5v11M3.5 9h11"];

const panes = new Map(); // conversation id -> { paneEl, subEl, usageEl, transcript }

let stripEl = null;
let stageEl = null;
let hooks = null;

/** Called once from app.js with `{ onOpen(id), onClose(id), onNew() }`. */
export function mountStage(config) {
  hooks = config;
  stripEl = $("stage-tabs");
  stageEl = $("stage");

  store.watch("tabs", () => {
    syncPanes();
    drawStrip();
  });
  store.watch("current", () => {
    showCurrent();
    drawStrip();
  });
  store.watch("sessions", drawStrip);
  store.watch("busyIds", drawStrip);
  store.watch("usage", drawUsage);

  syncPanes();
  drawStrip();
}

/** The transcript instance for one open tab, or undefined if it has none. */
export function transcriptFor(id) {
  return panes.get(id)?.transcript;
}

/* A tab is named by its conversation's stored title — the first thing said in
 * it (core/session-store.ts `record`). "Untitled" is now a real answer rather
 * than the only one: a conversation opened and not yet spoken to has no title,
 * and a tab for one that is not in the list yet (a `new` whose `list` reply has
 * not landed) has nothing to read. Both settle on the next `sessions` frame,
 * which `showCurrent` and `drawStrip` both run on. */
function title(id) {
  return titleOf((store.sessions || []).find((session) => session.id === id));
}

function ensurePane(id) {
  if (panes.has(id)) return panes.get(id);
  const subEl = el("span", { class: "chat-sub" }, title(id));
  /* The far end of the bar carries what this conversation has spent so far — the calmest place on the
   * screen that is still attached to the conversation it belongs to. It stays empty until there is
   * something to say, so a conversation nobody has spent anything on shows nothing at all rather than
   * a row of zeroes. */
  const usageEl = el("span", { class: "chat-usage" });
  const bar = el("div", { class: "chat-bar" }, subEl, el("span", { class: "chat-bar-gap" }), usageEl);
  const transcriptEl = el("div", { class: "transcript", tabindex: "0" });
  const paneEl = el("section", { class: "stage-pane", "data-pane": id }, bar, transcriptEl);
  setHidden(paneEl, true);
  stageEl.append(paneEl);
  const entry = { paneEl, subEl, usageEl, transcript: mountTranscriptInto(transcriptEl) };
  panes.set(id, entry);
  drawUsageInto(id, entry);
  return entry;
}

function drawUsageInto(id, entry) {
  const summary = conversationSummary(store.usageOf(id).total);
  entry.usageEl.textContent = summary ? summary.text : "";
  if (summary) entry.usageEl.setAttribute("title", summary.detail);
  else entry.usageEl.removeAttribute("title");
}

function drawUsage() {
  for (const [id, entry] of panes) drawUsageInto(id, entry);
}

/** Creates or drops panes so they match `store.tabs` exactly, then shows
 *  whichever is current. */
function syncPanes() {
  const wanted = new Set(store.tabs);
  for (const [id, entry] of panes) {
    if (wanted.has(id)) continue;
    entry.paneEl.remove();
    panes.delete(id);
  }
  for (const id of store.tabs) ensurePane(id);
  showCurrent();
}

function showCurrent() {
  for (const [id, entry] of panes) {
    setHidden(entry.paneEl, id !== store.current);
    entry.subEl.textContent = title(id);
  }
}

function tab(id) {
  const active = id === store.current;
  return el(
    "button",
    {
      type: "button",
      class: `stage-tab${active ? " is-active" : ""}`,
      title: title(id),
      "aria-current": active ? "true" : null,
      onClick: () => hooks.onOpen(id),
    },
    store.isBusy(id) ? el("span", { class: "stage-tab-dot" }) : null,
    el("span", { class: "stage-tab-text" }, title(id)),
    // A button may not contain another button, so the close affordance is a
    // span with the button role, as the legacy tab strip did; the tab itself
    // stays the keyboard target.
    el(
      "span",
      {
        role: "button",
        tabindex: "-1",
        class: "stage-tab-close",
        title: "Close tab",
        "aria-label": `Close ${title(id)}`,
        onClick: (event) => {
          event.stopPropagation();
          hooks.onClose(id);
        },
      },
      icon(CLOSE, { size: 10, width: 1.8 })
    )
  );
}

function drawStrip() {
  if (!stripEl) return;
  clear(stripEl).append(
    ...store.tabs.map(tab),
    el(
      "button",
      { type: "button", class: "stage-tab-new icon-btn sm", title: "New chat", "aria-label": "New chat", onClick: () => hooks.onNew() },
      icon(PLUS, { size: 14, width: 1.8 })
    )
  );
}
