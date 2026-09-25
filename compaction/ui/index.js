/* The browser side of @thetis/compaction: what the web gateway draws for this package once it has read
 * the `ui` block of the manifest. Three pieces share one per-conversation cache of the state view the
 * `compaction-state` command answers: the `ctx 14%` chip in the chat bar (how full the window is, and
 * `compacting…` while a summary is being written), the Compaction dock (the meter, the server's
 * sentence, the two requests, the summary and the ledger) and the transcript renderer that draws one
 * card per compaction, live from the `extension` events and, on a restored record, from the `marker`
 * the transcript offers at the cut. The cache is filled by one request per conversation change and one
 * per turn end (the chip is visible whenever a conversation is, so the dock's "only while visible" rule
 * cannot apply to the fetch itself; it applies to the follow-ups: an answer during a request coalesces
 * into one more, and a background conversation's turn only marks its view stale). Between answers the
 * chip follows the live stream: every `usage` event moves the figure, every `@thetis/compaction`
 * extension event moves the phase. Nothing here touches the gateway beyond what `ext` hands over, and
 * nothing sets a style attribute: the page's CSP forbids inline styles, so the meter is forty cells with
 * classes rather than a bar with a width. */

const NAME = "@thetis/compaction";
const STATE = "compaction-state";
const REQUEST = "compaction-request";
const RESET = "compaction-reset";
const CACHE_MAX = 32;
const WARN_AT = 0.6; // the share of the window at which the chip turns amber, well before the trigger
const BAR_CELLS = 40;
const BUSY = new Set(["planning", "summarizing"]);
const SETTLES = new Set(["finished", "failed", "skipped", "reset"]);

export default function install(ext) {
  const { el, setHidden } = ext.dom;
  const views = new Map(); // session -> StateView: the last answer of compaction-state, newest last
  const errors = new Map(); // session -> the sentence of a refused compaction-state; a change or Refresh retries
  const stale = new Set(); // sessions whose view is behind a turn that ended while they were not open
  const live = new Map(); // session -> { used } from the newest usage event since the last answer
  const phases = new Map(); // session -> the phase seen on the live stream, until the compaction settles or the turn ends
  const expanded = new Set(); // the dock's folds the person opened, kept across redraws
  let inFlight = null;
  let again = false;
  let body = null; // the node the last dock draw answered; connected while the dock shows it
  let acting = false; // a request or a reset is on its way; the buttons wait for the answer

  const can = (verb) => (typeof ext.can === "function" ? ext.can(verb) : true);
  const visible = () => Boolean(body?.isConnected);
  // The shell's renderer answers a list of block nodes (a paragraph, a list, a code block); older builds answered one node.
  const markdown = (text) => { const out = ext.markdown(text); return Array.isArray(out) ? out : [out]; };

  function remember(session, view) {
    views.delete(session);
    views.set(session, view);
    errors.delete(session);
    stale.delete(session);
    live.delete(session); // the answer was asked for after the event, so it is the newer figure
    if (views.size > CACHE_MAX) views.delete(views.keys().next().value);
  }

  // ---- the one request: coalesced, one in flight, a follow-up for the conversation open when it lands ----

  function refresh(session = ext.conversation.current) {
    if (!session) return Promise.resolve();
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = ext
      .request(STATE, { session })
      .then(
        (answer) => (isRecord(answer?.data) ? answer.data : { error: "The package answered no state." }),
        (err) => ({ error: err?.message || "The request failed." })
      )
      .then((data) => {
        if (typeof data.error === "string") errors.set(session, data.error);
        else remember(session, data);
        ext.redraw();
      })
      .finally(() => {
        inFlight = null;
        if (!again) return;
        again = false;
        refresh();
      });
    return inFlight;
  }

  ext.conversation.watch((session) => {
    if (session) refresh(session);
    else ext.redraw();
  });

  ext.events.watch((message) => {
    const { session, event } = message;
    if (!session || !event) return;
    const current = session === ext.conversation.current;
    if (event.type === "usage" && isRecord(event.usage)) {
      live.set(session, { used: (event.usage.prompt_tokens ?? 0) + (event.usage.completion_tokens ?? 0) });
      ext.redraw();
      return;
    }
    if (event.type === "extension" && event.name === NAME && isRecord(event.data)) {
      const data = event.data;
      if (BUSY.has(data.phase)) phases.set(session, data.phase);
      else phases.delete(session);
      // A finished compaction is the one moment the figure drops without a usage event: show it at once.
      if (data.phase === "finished" && Number.isFinite(data.tokensAfter)) live.set(session, { used: data.tokensAfter });
      if (SETTLES.has(data.phase)) {
        stale.add(session);
        if (current && visible()) refresh(session);
      }
      ext.redraw();
      return;
    }
    if (event.type === "turn.end") {
      phases.delete(session);
      if (current) refresh(session);
      else stale.add(session);
    }
  });

  // ---- the chip: hidden until a figure is known; amber from 60%, red from the trigger; busy while summarizing ----

  ext.chip("context", {
    draw(button, { session }) {
      const view = views.get(session);
      const busy = BUSY.has(phases.get(session));
      button.classList.add("mono", "cmp-chip");
      if (!view && !busy) {
        // Being drawn for a conversation nothing is known about is the one sure sign it should be asked for: after a
        // reload the page opens the conversation before this module's watch exists, so the watch alone misses it.
        if (session && !errors.has(session) && !inFlight) refresh(session);
        setHidden(button, true);
        return;
      }
      setHidden(button, false);
      button.classList.toggle("is-busy", busy);
      if (busy) {
        button.textContent = "compacting…";
        button.title = "A compaction is running: the older part of the conversation is being summarized.";
        button.classList.remove("is-warn", "is-err");
        return;
      }
      const used = usedOf(session, view);
      button.textContent = `ctx ${percent(used, view.window)}%`;
      button.title = `${view.estimated ? "≈" : ""}${tokens(used)} of ${tokens(view.window)} tokens · ${view.enabled ? `auto-compacts at ${percent(view.threshold, 1)}%` : "auto compaction is off"}`;
      button.classList.toggle("is-warn", used >= view.window * WARN_AT && used < view.trigger);
      button.classList.toggle("is-err", used >= view.trigger);
    },
    open() {
      ext.open.dock("compaction");
    },
  });

  /** The live figure when the stream moved it since the last answer, else the answer's. */
  function usedOf(session, view) {
    return live.get(session)?.used ?? view.used;
  }

  // ---- the dock ----

  function draw() {
    const current = ext.conversation.current;
    const view = current ? views.get(current) : null;
    // Being drawn is the one sure sign the dock is open on this conversation, so a view it has not read,
    // or one a background turn left behind, is asked for here. A request already running answers this
    // draw through its own redraw.
    if (current && (!view || stale.has(current)) && !errors.has(current) && !inFlight) refresh(current);
    body = el("div", { class: "cmp-dock" }, pane(current, view));
    const actions = current ? [ext.ui.button("Refresh", { title: "Read the compaction state again", onClick: () => refresh(current) })] : [];
    return { title: "Compaction", subtitle: subtitle(current, view), body, actions };
  }

  function subtitle(session, view) {
    if (!view) return "";
    if (BUSY.has(phases.get(session))) return "compacting…";
    const used = usedOf(session, view);
    return `${percent(used, view.window)}% · ${tokens(used)} of ${tokens(view.window)}`;
  }

  function pane(session, view) {
    if (!session) return note("Open a conversation to see how much of its context window is used.");
    if (errors.has(session)) return note(errors.get(session), "error");
    if (!view) return note("Reading the state…");
    const state = view.state;
    return [
      meter(session, view),
      sentence(session, view),
      actions(session, view),
      state.summary && fold("summary", `Summary of the first ${state.cut} messages`, state.last ? `${tokens(state.last.tokensBefore)} → ${tokens(state.last.tokensAfter)}` : "", el("div", { class: "cmp-summary" }, ...markdown(state.summary))),
      ledger(state),
    ];
  }

  /** Forty cells, `is-on` up to the used share, one `is-tick` at the trigger: a bar that needs no width style. */
  function meter(session, view) {
    const used = usedOf(session, view);
    const share = view.window > 0 ? used / view.window : 0;
    const on = Math.round(Math.min(1, share) * BAR_CELLS);
    const tick = Math.min(BAR_CELLS - 1, Math.floor(view.threshold * BAR_CELLS));
    const tone = used >= view.trigger ? " is-err" : share >= WARN_AT ? " is-warn" : "";
    const cells = Array.from({ length: BAR_CELLS }, (_, i) => el("span", { class: `cmp-cell${i < on ? " is-on" : ""}${i === tick ? " is-tick" : ""}` }));
    return el(
      "div",
      { class: `cmp-meter${tone}` },
      el("div", { class: "cmp-bar", role: "meter", "aria-label": "Context window used", "aria-valuemin": "0", "aria-valuemax": String(view.window), "aria-valuenow": String(used) }, ...cells),
      el(
        "div",
        { class: "cmp-numbers mono" },
        el("span", {}, `${view.estimated ? "≈" : ""}${tokens(used)} of ${tokens(view.window)} tokens · ${percent(used, view.window)}%`),
        el("span", { class: "cmp-trigger" }, `compacts at ${tokens(view.trigger)} (${percent(view.threshold, 1)}%)`)
      ),
      el("div", { class: "cmp-model" }, view.model || "")
    );
  }

  function sentence(session, view) {
    const state = view.state;
    const busy = BUSY.has(phases.get(session));
    const failure = state.failures > 0 && state.lastFailure ? `Last attempt, ${clock(state.lastFailure.at)}: ${state.lastFailure.reason}` : null;
    return el(
      "div",
      { class: "cmp-sentence" },
      el("p", { class: `cmp-lead${busy ? " is-busy" : ""}` }, busy ? "A compaction is running: the older part of the conversation is being summarized." : view.sentence),
      failure && el("p", { class: "cmp-failure" }, failure)
    );
  }

  function actions(session, view) {
    const { state, pending } = view;
    const focus = el("input", { type: "text", class: "input cmp-focus", placeholder: "Focus for the summary (optional)", "aria-label": "What the summary must keep", maxlength: "400" });
    const request = ext.ui.button("Compact on next message", {
      tone: "primary",
      title: "Summarize the older part of the conversation at the start of the next message, whatever its size",
      disabled: acting || !can(REQUEST),
      onClick: () => act(session, REQUEST, { instructions: String(focus.value ?? "").trim() || undefined }),
    });
    let reset = null;
    reset = ext.ui.button("Send the full history again", {
      title: "Drop the summary from the next message on and send every message as it was",
      disabled: acting || !can(RESET) || (state.cut === 0 && !pending) || Boolean(pending?.reset),
      onClick: () => confirmReset(session, view, reset),
    });
    return el(
      "div",
      { class: "cmp-actions" },
      pending && el("p", { class: "cmp-pending" }, pendingLine(pending)),
      el("div", { class: "cmp-row" }, request, focus),
      el("div", { class: "cmp-row" }, reset),
      el("p", { class: "cmp-hint" }, `Automatic compaction is ${view.enabled ? "on" : "off"} for this package. The setting lives in Control panel → Packages → compaction.`)
    );
  }

  /** There is no verb to withdraw a request, so the line says what is pending and how it is replaced. */
  function pendingLine(pending) {
    const what = pending.reset ? "the full history is sent again" : pending.instructions ? `a compaction focused on “${pending.instructions}”` : "a compaction";
    return `Pending since ${clock(pending.at)}: ${what} at the start of the next message. Requesting the other replaces it.`;
  }

  async function act(session, verb, args) {
    acting = true;
    ext.redraw("compaction");
    try {
      const { text, data } = await ext.request(verb, { session, args });
      const view = views.get(session);
      if (view && isRecord(data) && "pending" in data) view.pending = data.pending;
      if (text) ext.toast(text);
    } catch (err) {
      ext.toast(`The request was not recorded: ${err?.message || "no answer"}`, { tone: "error" });
    } finally {
      acting = false;
      // The sentence is the server's, so the dock reads it again rather than composing its own.
      stale.add(session);
      refresh(session);
    }
  }

  async function confirmReset(session, view, anchor) {
    const lines = view.state.cut > 0 ? [["Summarized now", `${view.state.cut} messages`], ["Compacted", `${view.state.compactions} time${view.state.compactions === 1 ? "" : "s"}`]] : [];
    const ok = await ext.ui.confirm(anchor, {
      title: "Send the full history again?",
      lines,
      note: "The summary is dropped from the next message on. Nothing was deleted, so nothing is lost; the next request carries the whole conversation, and compaction can run again later.",
      confirmLabel: "Send it all",
      tone: "warn",
    });
    if (ok) await act(session, RESET, {});
  }

  function fold(key, label, aside, ...children) {
    return el(
      "details",
      {
        class: "cmp-fold",
        open: expanded.has(key),
        onToggle: (event) => {
          if (event.currentTarget?.open ?? event.target?.open) expanded.add(key);
          else expanded.delete(key);
        },
      },
      el("summary", {}, el("span", { class: "cmp-fold-label" }, label), aside && el("span", { class: "cmp-fold-aside mono" }, aside)),
      ...children
    );
  }

  function ledger(state) {
    const rows = Array.isArray(state.ledger) ? state.ledger.slice().reverse() : [];
    if (!rows.length) return null;
    // One element, not a list: `el` flattens its children one level, and this sits inside the pane's list.
    return el(
      "div",
      { class: "cmp-history" },
      ext.ui.section("History", `${rows.length} newest first`),
      el(
        "ul",
        { class: "cmp-ledger mono" },
        ...rows.map((row) => el("li", { class: `cmp-ledger-row is-${row.kind}` }, ledgerLine(row)))
      )
    );
  }

  function note(text, tone) {
    return el("p", { class: `cmp-note${tone ? ` is-${tone}` : ""}` }, text);
  }

  ext.dock("compaction", { draw });

  // ---- the transcript: one card per compaction, updated in place from planning to finished or failed ----

  const open = new Map(); // session -> the card of the compaction in progress: { node, text, body, cut }

  ext.transcript((event, ctx) => {
    if (event.type === "extension") return event.name === NAME && isRecord(event.data) ? liveCard(ctx.session, event.data) : null;
    if (event.type === "marker") return restoredCard(event);
    return null;
  });

  function liveCard(session, data) {
    const { phase } = data;
    // A replayed event after a reload reaches the transcript but not `ext.events.watch`, so the chip learns
    // the phase here as well: a page opened mid-compaction says "compacting…" like one that watched it start.
    if (BUSY.has(phase)) phases.set(session, phase);
    else phases.delete(session);
    ext.redraw();
    if (phase === "skipped" || phase === "reset") {
      // One-off notes: they belong to no card in progress and are never updated.
      const card = makeCard(phase === "reset" ? "is-reset" : "is-skipped");
      card.text.textContent = phase === "reset" ? "Context reset: the full history is sent again from here." : `Compaction skipped: ${data.detail}`;
      return card.node;
    }
    // A card the transcript no longer holds (a restore rebuilt it) is not worth updating: start again.
    let card = open.get(session);
    const fresh = phase === "planning" || !card || !card.node.isConnected;
    if (fresh) {
      card = makeCard("is-busy");
      open.set(session, card);
    }
    if (BUSY.has(phase)) {
      setTone(card, "is-busy");
      card.text.textContent = `Compacting… summarizing ${count(data.messages ?? (data.cut != null && data.from != null ? data.cut - data.from : undefined))} messages (≈${tokens(data.used)} tokens)`;
    } else if (phase === "finished") {
      open.delete(session);
      finish(card, session, { messages: data.messages ?? data.cut - data.from, before: data.used, after: data.tokensAfter, cost: data.cost, cut: data.cut });
    } else if (phase === "failed") {
      open.delete(session);
      setTone(card, "is-failed");
      card.text.textContent = `Compaction failed: ${data.detail}`;
    } else return null;
    return fresh ? card.node : true;
  }

  /** The finished card at the cut of a restored record, with the summary the record already holds. */
  function restoredCard(event) {
    const state = event.record?.harness?.[NAME];
    if (!isRecord(state) || !(state.cut > 0) || event.index !== state.cut) return null;
    const last = isRecord(state.last) ? state.last : {};
    const card = makeCard("is-done");
    finish(card, event.session, { messages: last.messages ?? state.cut - (last.from ?? 0), before: last.tokensBefore, after: last.tokensAfter, cost: last.cost, cut: state.cut, summary: state.summary });
    return card.node;
  }

  function makeCard(tone) {
    const text = el("span", { class: "cmp-card-text" });
    const body = el("div", { class: "cmp-card-body" }, text);
    const node = el("div", { class: `msg compaction-card ${tone}` }, el("span", { class: "cmp-dot", "aria-hidden": "true" }), body);
    return { node, text, body };
  }

  function setTone(card, tone) {
    card.node.classList.remove("is-busy", "is-done", "is-failed", "is-skipped", "is-reset");
    card.node.classList.add(tone);
  }

  function finish(card, session, { messages, before, after, cost, cut, summary }) {
    setTone(card, "is-done");
    const numbers = [Number.isFinite(before) && Number.isFinite(after) ? `${tokens(before)} → ${tokens(after)} tokens` : "", Number.isFinite(cost) ? money(cost) : ""].filter(Boolean).join(", ");
    card.text.textContent = `Context compacted: ${count(messages)} earlier ${messages === 1 ? "message" : "messages"} summarized${numbers ? ` (${numbers})` : ""}`;
    card.body.append(summaryFold(session, cut, summary));
  }

  /**
   * "Show summary": the text is fetched when the fold is first opened, not when the card is drawn, because
   * the finished event does not carry it and a restored transcript may hold many cards nobody opens.
   */
  function summaryFold(session, cut, given) {
    const content = el("div", { class: "cmp-card-summary" });
    let loaded = false;
    const fold = el(
      "details",
      {
        class: "cmp-fold cmp-card-fold",
        onToggle: () => {
          if (loaded || !fold.open) return;
          loaded = true;
          if (typeof given === "string" && given) return content.append(...markdown(given));
          content.append(el("p", { class: "cmp-note" }, "Reading the summary…"));
          summaryFor(session, cut).then(({ summary, text }) => {
            content.replaceChildren();
            if (text) content.append(el("p", { class: "cmp-note" }, text));
            if (summary) content.append(...markdown(summary));
          });
        },
      },
      el("summary", {}, "Show summary"),
      content
    );
    return fold;
  }

  async function summaryFor(session, cut) {
    let view = views.get(session);
    if (!(view && view.state?.cut === cut && view.state.summary)) {
      try {
        const answer = await ext.request(STATE, { session });
        if (isRecord(answer?.data)) {
          remember(session, answer.data);
          view = answer.data;
        }
      } catch (err) {
        return { text: `The summary could not be read: ${err?.message || "no answer"}` };
      }
    }
    const state = view?.state;
    if (!state?.summary) return { text: "No summary is on record for this conversation any more." };
    if (state.cut !== cut) return { text: `A later compaction has rewritten this summary; it now covers the first ${state.cut} messages.`, summary: state.summary };
    return { summary: state.summary };
  }
}

/** "12:03 · auto · 84 msgs · 730k → 21k · $0.41", or what failed, or a reset. */
function ledgerLine(row) {
  const at = clock(row.at);
  if (row.kind === "failed") return `${at} · ${row.trigger} · failed: ${row.reason || "no reason recorded"}`;
  if (row.kind === "reset") return `${at} · reset · the full history is sent again`;
  const parts = [at, row.trigger, `${count(row.cut - row.from)} ${row.cut - row.from === 1 ? "msg" : "msgs"}`];
  if (Number.isFinite(row.tokensBefore) && Number.isFinite(row.tokensAfter)) parts.push(`${tokens(row.tokensBefore)} → ${tokens(row.tokensAfter)}`);
  if (Number.isFinite(row.cost)) parts.push(money(row.cost));
  return parts.join(" · ");
}

/** The shell's token format (730k, 21k, 1.2M), with the trailing zeros of a round million dropped, so a 1,000,000 window reads "1M". */
export function tokens(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

const percent = (part, whole) => (whole > 0 && Number.isFinite(part) ? Math.round((part / whole) * 100) : 0);
const count = (n) => (Number.isFinite(n) ? String(n) : "the older");
const money = (c) => (c >= 0.01 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`);
const clock = (iso) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "—");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
