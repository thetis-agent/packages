/* Fetch context only while its dock is visible. Snapshot notifications refresh during a turn;
 * stale responses are discarded and overlapping requests coalesce into one follow-up.
 *
 * The `context` answer is a bounded summary; the big texts — the system prompt, the whole request, one
 * message or tool definition — come from `context-page` a page at a time, only when a view needs them
 * (the Prompt tab, a row opened, Copy), and are kept for the capture they belong to. The Request tab is
 * the raw dump of what was sent, and is there only with developer details on (`ext.developer()`); the
 * Prompt and Usage tabs are for everyone. */
import { contextViews } from "./views.js";

const NOTHING_YET = "Nothing has been sent in this conversation yet.";
const TABS = [
  ["request", "Request", true],
  ["prompt", "Prompt", false],
  ["usage", "Usage", false],
];

export default function install(ext) {
  const { el } = ext.dom;
  const state = { session: null, loaded: false, turns: 0, status: "idle", started: false, lastCall: null, usage: [], usageCount: 0, usageTotals: null, error: null };
  const parts = new Map(); // `${session}|${at}|${part}|${index}` -> { text, done, loading, error }
  const views = contextViews(ext, { part: partOf, need });
  let chosen = null; // the tab the person picked; null means the default for who they are
  let inFlight = null;
  let again = false;
  let stale = true; // what `state` holds may be behind the open conversation; the next draw asks
  let body = null; // the node the last draw answered; connected while the dock shows it

  const visible = () => Boolean(body?.isConnected);

  /** Whether the person asked for developer details. The gateway may not offer the preference yet. */
  function developer() {
    try {
      return typeof ext.developer === "function" && ext.developer() === true;
    } catch {
      return false;
    }
  }

  const tabs = () => TABS.filter(([, , dev]) => !dev || developer());
  /** The tab on screen: the one picked if it is still offered, else the Request for a developer and the Usage for everyone else. */
  const tab = () => (chosen && tabs().some(([id]) => id === chosen) ? chosen : developer() ? "request" : "usage");

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
        const usage = Array.isArray(data.usage) ? data.usage : [];
        Object.assign(state, {
          session,
          loaded: true,
          turns: Number.isInteger(data.turns) ? data.turns : 0,
          status: data.status ?? "idle",
          started: Boolean(data.started || data.turns > 0 || data.status === "running"),
          usage,
          usageCount: Number.isInteger(data.usageCount) ? data.usageCount : usage.length,
          usageTotals: isRecord(data.usageTotals) ? data.usageTotals : null,
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
    for (const [key, entry] of parts) if (entry.error) parts.delete(key);
    stale = true;
    if (visible()) refresh();
  }

  const keyOf = (part, index = null) => `${state.session}|${state.lastCall?.at ?? ""}|${part}|${index ?? ""}`;

  /** What is held of a big text of the capture on screen: `{ text, done, loading, error }`, or null. */
  function partOf(part, index = null) {
    return parts.get(keyOf(part, index)) ?? null;
  }

  /**
   * Makes sure a big text of the capture on screen is being fetched, page by page, and answers the
   * promise of the whole text. A capture replaced mid-way starts the dock over rather than stitching
   * two requests together.
   */
  function need(part, index = null) {
    const key = keyOf(part, index);
    const had = parts.get(key);
    if (had?.done) return Promise.resolve(had.text);
    if (had?.promise) return had.promise;
    if (had?.error) return Promise.resolve(null); // said in the view; Refresh asks again
    const session = state.session;
    const at = state.lastCall?.at ?? undefined;
    const entry = { text: "", done: false, loading: true, error: null };
    parts.set(key, entry);
    entry.promise = (async () => {
      let offset = 0;
      try {
        for (;;) {
          const out = await ext.request("context-page", { session, args: { part, ...(index === null ? {} : { index }), offset, ...(at ? { at } : {}) } });
          const page = out?.data ?? {};
          if (page.changed) {
            parts.delete(key);
            invalidate();
            return null;
          }
          entry.text += typeof page.text === "string" ? page.text : "";
          if (!Number.isInteger(page.next) || page.next <= offset) break;
          offset = page.next;
        }
        entry.done = true;
        return entry.text;
      } catch (err) {
        entry.error = err?.message || "The request failed.";
        return null;
      } finally {
        entry.loading = false;
        delete entry.promise;
        if (session === ext.conversation.current) ext.redraw("context");
      }
    })();
    return entry.promise;
  }

  ext.conversation.watch(() => { views.reset(); parts.clear(); invalidate(); });
  ext.events.watch((message) => {
    if (message.session !== ext.conversation.current) return;
    if (["turn.start", "turn.end", "context.updated"].includes(message.event?.type)) invalidate();
  });
  // The preference adds or removes the Request tab; the open dock follows it.
  try {
    ext.onDeveloper?.(() => ext.redraw("context"));
  } catch {
    /* an older gateway: no preference */
  }

  // --- drawing ---

  function draw() {
    const current = ext.conversation.current;
    const fresh = state.loaded && state.session === current;
    // Being drawn is the one sure sign the dock is open on this entry, so this is where a stale record is
    // brought up to date. A request already running answers this draw through its own redraw.
    if (current && (stale || !fresh) && !inFlight) refresh();
    const call = fresh ? state.lastCall : null;
    const on = tab();
    body = el("div", { class: "ui-context" }, tabStrip(on), pane(current, fresh, call, on));
    const actions = current ? [ext.ui.button("Refresh", { title: "Refresh context", onClick: invalidate })] : [];
    if (call && on === "prompt" && partOf("system")?.done) actions.unshift(copyButton(() => need("system"), body, "Copy", ".ui-context-prompt"));
    if (call?.request && on === "request") actions.unshift(copyButton(() => need("request"), body, "Copy JSON", ".ui-context-raw"));
    return { title: "Context", subtitle: subtitle(fresh ? state : null, call), body, actions };
  }

  function tabStrip(on) {
    return el(
      "div",
      { class: "ui-context-tabs", role: "tablist", "aria-label": "Context views" },
      ...tabs().map(([id, label]) =>
        el("button", { type: "button", role: "tab", class: `ui-context-tab${on === id ? " is-active" : ""}`, "aria-selected": on === id ? "true" : "false", onClick: () => switchTo(id) }, label)
      )
    );
  }

  function switchTo(id) {
    if (tab() === id) return;
    chosen = id;
    ext.redraw("context");
  }

  function pane(current, fresh, call, on) {
    if (!current) return note("Open a conversation to see what the model received.");
    if (!fresh) return note("Loading…");
    if (state.error) return note(state.error, "error");
    if (!call && !state.started) return note(NOTHING_YET);
    if (on === "usage") return views.usage(state);
    if (!call) return note(state.status === "running" ? "The turn is running. Waiting for its first request capture…" : state.started ? "No request capture is available for this conversation yet." : NOTHING_YET);
    return on === "prompt" ? views.prompt(call) : views.request(call);
  }

  /** Copies the request or prompt once it is all here; when clipboard access is unavailable, selects its text instead. */
  function copyButton(get, body, label, selector) {
    const button = ext.ui.button(label, { title: label === "Copy" ? "Copy the system prompt" : "Copy the whole request body as JSON" });
    button.addEventListener("click", async () => {
      const content = await get();
      if (content === null) return flash(button, "Not copied");
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
