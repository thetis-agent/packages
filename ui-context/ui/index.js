/* Fetch context only while its dock is visible. Snapshot notifications refresh during a turn;
 * stale responses are discarded and overlapping requests coalesce into one follow-up. */
import { contextViews } from "./views.js";

const NOTHING_YET = "Nothing has been sent in this conversation yet.";
const TABS = [
  ["request", "Request"],
  ["prompt", "Prompt"],
  ["usage", "Usage"],
];

export default function install(ext) {
  const { el } = ext.dom;
  const state = { session: null, loaded: false, turns: 0, status: "idle", started: false, lastCall: null, usage: [], error: null };
  const views = contextViews(ext);
  let tab = "request";
  let inFlight = null;
  let again = false;
  let stale = true; // what `state` holds may be behind the open conversation; the next draw asks
  let body = null; // the node the last draw answered; connected while the dock shows it

  const visible = () => Boolean(body?.isConnected);

  // --- data ---

  /** Requests the record for the open conversation. Coalesces: a call during a request runs once more after it. */
  function refresh() {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    stale = false;
    const session = ext.conversation.current;
    if (!session) {
      Object.assign(state, { session: null, loaded: false, turns: 0, lastCall: null, error: null });
      ext.redraw("context");
      return Promise.resolve();
    }
    inFlight = ext
      .request("context", { session })
      .then(
        (answer) => answer?.data ?? {},
        (err) => ({ error: err?.message || "The request failed." })
      )
      .then((data) => {
        if (session !== ext.conversation.current) return;
        Object.assign(state, {
          session,
          loaded: true,
          turns: Number.isInteger(data.turns) ? data.turns : 0,
          status: data.status ?? "idle",
          started: Boolean(data.started || data.turns > 0 || data.status === "running"),
          usage: Array.isArray(data.usage) ? data.usage : [],
          lastCall: isRecord(data.lastCall) ? data.lastCall : null,
          error: typeof data.error === "string" ? data.error : null,
        });
        ext.redraw("context");
      })
      .finally(() => {
        inFlight = null;
        if (!again) return;
        again = false;
        if (visible()) refresh();
        else stale = true;
      });
    return inFlight;
  }

  /** A reason to ask again: asks now for an open dock, and leaves it to the next draw for a closed one. */
  function invalidate() {
    stale = true;
    if (visible()) refresh();
  }

  ext.conversation.watch(() => { views.reset(); invalidate(); });
  ext.events.watch((message) => {
    if (message.session !== ext.conversation.current) return;
    if (["turn.start", "turn.end", "context.updated"].includes(message.event?.type)) invalidate();
  });

  // --- drawing ---

  function draw() {
    const current = ext.conversation.current;
    const fresh = state.loaded && state.session === current;
    // Being drawn is the one sure sign the dock is open on this entry, so this is where a stale record is
    // brought up to date. A request already running answers this draw through its own redraw.
    if (current && (stale || !fresh) && !inFlight) refresh();
    const call = fresh ? state.lastCall : null;
    body = el("div", { class: "ui-context" }, tabs(), pane(current, fresh, call));
    const actions = current ? [ext.ui.button("Refresh", { title: "Refresh context", onClick: invalidate })] : [];
    if (call && tab === "prompt") actions.unshift(copyButton(call.system ?? "", body, "Copy", ".ui-context-prompt"));
    if (call?.request && tab === "request") actions.unshift(copyButton(JSON.stringify(call.request, null, 2), body, "Copy JSON", ".ui-context-raw"));
    return { title: "Context", subtitle: subtitle(fresh ? state : null, call), body, actions };
  }

  function tabs() {
    return el(
      "div",
      { class: "ui-context-tabs", role: "tablist", "aria-label": "Context views" },
      ...TABS.map(([id, label]) =>
        el("button", { type: "button", role: "tab", class: `ui-context-tab${tab === id ? " is-active" : ""}`, "aria-selected": tab === id ? "true" : "false", onClick: () => switchTo(id) }, label)
      )
    );
  }

  function switchTo(id) {
    if (tab === id) return;
    tab = id;
    ext.redraw("context");
  }

  function pane(current, fresh, call) {
    if (!current) return note("Open a conversation to see what the model received.");
    if (!fresh) return note("Loading…");
    if (state.error) return note(state.error, "error");
    if (tab === "usage") return views.usage(state);
    if (!call) return note(state.status === "running" ? "The turn is running. Waiting for its first request capture…" : state.started ? "No request capture is available for this conversation yet." : NOTHING_YET);
    return tab === "prompt" ? views.prompt(call) : views.request(call);
  }

  /** Copies the request or prompt; when clipboard access is unavailable, selects its text instead. */
  function copyButton(content, body, label, selector) {
    const button = ext.ui.button(label, { title: label === "Copy" ? "Copy the system prompt" : "Copy the whole request body as JSON" });
    button.addEventListener("click", () => {
      const write = globalThis.navigator?.clipboard?.writeText(content);
      if (!write) return selectPrompt(body, button, selector);
      write.then(
        () => flash(button, "Copied"),
        () => selectPrompt(body, button, selector)
      );
    });
    return button;
  }

  function selectPrompt(body, button, selector) {
    const block = body.querySelector(selector);
    if (!block) return;
    const disclosure = block.closest("details");
    if (disclosure) disclosure.open = true;
    const range = document.createRange();
    range.selectNodeContents(block);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    flash(button, "Selected");
  }

  function flash(button, label) {
    const was = button.textContent;
    button.textContent = label;
    setTimeout(() => {
      button.textContent = was;
    }, 1200);
  }

  function note(sentence, tone) {
    return el("p", { class: `ui-context-note${tone ? ` is-${tone}` : ""}` }, sentence);
  }

  ext.dock("context", { draw });
}

/** "turn N · model · N chars" when there is a call; the turn count alone before one; nothing without a conversation. */
function subtitle(state, call) {
  if (!state) return "";
  const parts = [state.status === "running" ? `turn ${state.turns + 1} · running` : `turn ${state.turns}`];
  if (call) parts.push(text(call.model), `${Number.isFinite(call.systemChars) ? call.systemChars.toLocaleString() : "?"} chars`);
  return parts.join(" · ");
}

const text = (value) => (value == null || value === "" ? "—" : String(value));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
