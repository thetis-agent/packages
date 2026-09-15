/* The Context dock: what the model received on the last call of the open conversation, as
 * `@thetis/harness-core` recorded it. Two tabs: Request lists the scalars (model, when, the tools offered,
 * the messages in the exchange) with the tool names as pills; Prompt shows the system prompt as rendered
 * markdown in a scrolling block with a Copy button. The data comes from the package's `context` command.
 * It is requested when the page opens, when the open conversation changes and when a turn of that
 * conversation ends; never from `draw`, which only renders what was last received. One request is in
 * flight at a time; a trigger during one queues a single follow-up, and an answer for a conversation no
 * longer open is dropped. The module defines `install` and does nothing else at import time. */

const NOTHING_YET = "Nothing has been sent in this conversation yet.";
const TABS = [
  ["request", "Request"],
  ["prompt", "Prompt"],
];

export default function install(ext) {
  const { el } = ext.dom;
  const state = { session: null, loaded: false, turns: 0, lastCall: null, error: null };
  let tab = "request";
  let inFlight = null;
  let again = false;

  // --- data ---

  /** Requests the record for the open conversation. Coalesces: a call during a request runs once more after it. */
  function refresh() {
    if (inFlight) {
      again = true;
      return inFlight;
    }
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
        inFlight = null;
        if (session !== ext.conversation.current) return;
        Object.assign(state, {
          session,
          loaded: true,
          turns: Number.isInteger(data.turns) ? data.turns : 0,
          lastCall: isRecord(data.lastCall) ? data.lastCall : null,
          error: typeof data.error === "string" ? data.error : null,
        });
        ext.redraw("context");
      })
      .finally(() => {
        if (!again) return;
        again = false;
        refresh();
      });
    return inFlight;
  }

  ext.conversation.watch(() => {
    Object.assign(state, { loaded: false, error: null });
    refresh();
  });
  ext.events.watch((message) => {
    if (message.event?.type === "turn.end" && message.session === ext.conversation.current) refresh();
  });

  // --- drawing ---

  function draw() {
    const current = ext.conversation.current;
    const fresh = state.loaded && state.session === current;
    const call = fresh ? state.lastCall : null;
    const body = el("div", { class: "ui-context" }, tabs(), pane(current, fresh, call));
    return { title: "Context", subtitle: subtitle(fresh ? state : null, call), body, actions: call && tab === "prompt" ? [copyButton(call.system, body)] : [] };
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
    if (!call) return note(NOTHING_YET);
    return tab === "prompt" ? promptPane(call) : requestPane(call);
  }

  function requestPane(call) {
    const tools = Array.isArray(call.tools) ? call.tools.filter((name) => typeof name === "string") : [];
    return el(
      "div",
      { class: "ui-context-pane", role: "tabpanel" },
      ext.ui.kv([
        ["Model", el("span", { class: "mono" }, text(call.model))],
        ["When", when(call.at)],
        ["Tools offered", String(tools.length)],
        ["Messages in the exchange", text(call.messages)],
      ]),
      ext.ui.section("Tools", tools.length ? `${tools.length} offered on this call` : "No tool was offered on this call."),
      ext.ui.tags(tools, "dim", "none")
    );
  }

  function promptPane(call) {
    const system = typeof call.system === "string" ? call.system : "";
    return el(
      "div",
      { class: "ui-context-pane is-prompt", role: "tabpanel" },
      system ? el("div", { class: "ui-context-prompt" }, ext.markdown(system)) : note("The system prompt was empty on this call.")
    );
  }

  /** Copies the system prompt; where the clipboard is not available, selects the block so the person can. */
  function copyButton(system, body) {
    const button = ext.ui.button("Copy", { title: "Copy the system prompt" });
    button.addEventListener("click", () => {
      const write = navigator.clipboard?.writeText(system);
      if (!write) return selectPrompt(body, button);
      write.then(
        () => flash(button, "Copied"),
        () => selectPrompt(body, button)
      );
    });
    return button;
  }

  function selectPrompt(body, button) {
    const block = body.querySelector(".ui-context-prompt");
    if (!block) return;
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
  refresh();
}

/** "turn N · model · N chars" when there is a call; the turn count alone before one; nothing without a conversation. */
function subtitle(state, call) {
  if (!state) return "";
  const parts = [`turn ${state.turns}`];
  if (call) parts.push(text(call.model), `${Number.isFinite(call.systemChars) ? call.systemChars.toLocaleString() : "?"} chars`);
  return parts.join(" · ");
}

function when(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
}

const text = (value) => (value == null || value === "" ? "—" : String(value));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
