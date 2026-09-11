/* One conversation's transcript.
 *
 * Renders exactly the event kinds this wire's `render.ts` can produce: `user`
 * (an echo of submitted text), `delta` (streamed reply text), `reasoning`
 * (streamed thinking text), `assistant` (the finished reply), `tool-call` /
 * `tool-result`, `note`, `incident` (documented as a valid wire kind —
 * render.ts never emits it today, only `note`, but a turn that widens it
 * later should not need a UI change), and `turn-finished`. The legacy
 * transcript also carried sub-agent inline blocks, ask_user forms, a
 * compacting/compacted/nudge/modification/branch-op vocabulary, and a running
 * cost/token ledger built from `turn-finished`'s usage fields — none of which
 * this wire's `turn-finished` carries any more (no cost, no token counts, no
 * sub-agents), so all of that went with the frames that fed it.
 *
 * `mountTranscriptInto` is a factory rather than a singleton: views/stage.js
 * keeps one instance per open tab, each bound to that tab's own DOM subtree,
 * so switching tabs never rebuilds a transcript — it just shows and hides
 * panes that were drawn once and go on receiving events in the background.
 */

import { avatarFor } from "../lib/avatar.js";
import { chooseTranscriptRow } from "../lib/dispatch.js";
import { clear, el } from "../lib/dom.js";
import { createFollow } from "../lib/follow.js";
import { renderMarkdown } from "../lib/markdown.js";
import { store } from "../lib/store.js";
import { rendererFor } from "../lib/surface.js";

const limits = {
  /** How many of the most recently placed rows are watched for growing after the fact.
   *
   *  Every placed row is watched so that a row rewritten in place, an `<img>` that finishes loading
   *  and an SVG that lays out late all re-stick (see the comment on `growth` below), but a
   *  conversation is unbounded and a ResizeObserver over every row of a thousand-turn transcript is
   *  a cost paid forever for rows nobody will ever see move again. The bound protects that: only
   *  the tail of the transcript is watched, which is the only part of it the reader can be at the
   *  bottom of. A row that scrolls out of this window and only then changes size does not bring the
   *  view down, and should not — it is far above the fold by then. */
  watchedRows: 64,
};

export function mountTranscriptInto(root) {
  /** The bubble currently receiving `delta`/`reasoning` text for the turn in
   *  flight, or null between turns. Replaced with the rendered final text when
   *  `assistant` arrives, so streaming never double-renders markdown. */
  let live = null;
  /** The most recently sent local row, still waiting on `accepted` (or an
   *  `error`) to say whether it actually went. There is at most one: the
   *  composer refuses a second send while one is pending. */
  let pendingRow = null;

  /* Whether the reader is following the bottom is state, kept in lib/follow.js, fed by this
   * element's own scroll events — not a sample taken at the moment a row is appended. That module's
   * header has the browser session this came out of and the reasoning; the short of it is that a
   * row which grows after it was placed used to leave the view stranded above the bottom for the
   * rest of the conversation. */
  const follow = createFollow({
    distanceFromBottom: () => root.scrollHeight - root.scrollTop - root.clientHeight,
    scrollPosition: () => root.scrollTop,
    scrollToBottom: () => { root.scrollTop = root.scrollHeight; },
  });
  // Passive: this listener only reads geometry, and saying so lets the browser scroll without
  // waiting to find out whether the handler will cancel it.
  root.addEventListener("scroll", () => follow.scrolled(), { passive: true });

  /* Rows that grow after they were placed.
   *
   * A ResizeObserver rather than a MutationObserver, because the three things that strand the view
   * are not all mutations of this tree: tools-ask filling in a question row after placing its
   * header is (a MutationObserver would catch it), but an `<img>` in a message finishing its
   * download and a mermaid diagram finishing its layout change the box without changing the
   * markup, and a MutationObserver sees neither. The box is what actually moved the bottom, so the
   * box is what is watched — which is also what makes this general rather than a special case for
   * whichever contributed renderer happened to be caught doing it first.
   *
   * There is no feedback loop to guard against: the catch-up sets `scrollTop`, which moves no box
   * and resizes nothing, so it cannot re-enter this callback. The callback ignores its entries and
   * asks once per batch rather than once per row. */
  const growth = new ResizeObserver(() => follow.grew());
  /** The rows `growth` is watching, oldest first, so the window above can be kept to its bound. */
  const watched = [];

  reset();

  function reset() {
    clear(root);
    growth.disconnect();
    watched.length = 0;
    follow.reset();
    live = null;
    pendingRow = null;
    showEmpty();
  }

  function showEmpty() {
    if (root.childElementCount) return;
    root.append(el("p", { class: "transcript-empty" }, "No messages yet — say something to start."));
  }
  function clearEmpty() {
    root.querySelector(".transcript-empty")?.remove();
  }

  /** Appends a prebuilt node (a `<div>` or a `<details>`) as a transcript row, and watches it for
   *  changing size later. The catch-up is the same one the growth observer makes: whether to follow
   *  was decided by the reader's own scrolling, so appending needs no measurement of its own. */
  function place(node) {
    clearEmpty();
    root.append(node);
    growth.observe(node);
    watched.push(node);
    if (watched.length > limits.watchedRows) growth.unobserve(watched.shift());
    follow.placed();
    return node;
  }

  /* A face for the two kinds that have a speaker, parked in the gutter beside
   * the row (lib/avatar.js draws it, app.css places it). Tool cards and notes
   * get none: nobody said them.
   *
   * The reader's own name arrives in the same frame that opens the connection,
   * before any transcript is drawn, so in practice it is always known by the
   * time a row needs it; the fallback is there for the one frame where it is
   * not, and reads as a word rather than as a blank tile. */
  function faceFor(kind) {
    if (kind === "assistant") return avatarFor("agent", store.agent.name);
    return kind === "user" ? avatarFor("person", store.user?.name || "You") : null;
  }

  function row(kind, ...children) {
    return place(el("div", { class: `msg is-${kind}` }, faceFor(kind), children));
  }

  /* The images that went with a message.
   *
   * `url` is whatever handed them over: a `data:` URL for a row this client has just drawn from the file
   * still in the page, and a same-origin path for one the host replayed (render.ts mints it). The policy
   * this surface is served under allows both and nothing else, so a row can be drawn the same way in
   * either case. A row with no usable URL still names its file rather than drawing an empty frame —
   * knowing a picture was sent matters more than seeing it. */
  function attachmentsOf(list) {
    const files = Array.isArray(list) ? list : [];
    if (!files.length) return null;
    return el(
      "div",
      { class: "msg-files" },
      files.map((file) =>
        el(
          "figure",
          { class: "msg-file", title: file.name || "" },
          file.url ? el("img", { class: "msg-file-thumb", src: file.url, alt: file.name || "" }) : null,
          el("figcaption", { class: "msg-file-name" }, file.name || "Image")
        )
      )
    );
  }

  /** The person's own message, drawn immediately on send with a pending mark.
   *
   *  The mark is cleared by the host's own echo of the message — the `user` frame the stream now
   *  carries for every `input` — which arrives as soon as the turn starts rather than when it ends.
   *  `settleLocal`/`failLocal` remain for `accepted` and for a send that failed, and settling twice
   *  is harmless. Before the stream was widened there was no echo, the optimistic row was the only
   *  one, and `accepted` was the only signal; now both exist, and drawing both is what put every
   *  message on the screen twice. */
  function addLocal(text, files) {
    live = null;
    const note = el("span", { class: "pending-note" }, "Sending…");
    // A message may be nothing but pictures, and an empty bubble under them reads as a mistake.
    pendingRow = row("user", attachmentsOf(files), text ? el("div", { class: "msg-text" }, text) : null, note);
    pendingRow.classList.add("is-pending");
  }

  function settleLocal() {
    if (!pendingRow) return;
    pendingRow.classList.remove("is-pending");
    pendingRow.querySelector(".pending-note")?.remove();
    pendingRow = null;
  }

  function failLocal() {
    if (!pendingRow) return;
    pendingRow.classList.replace("is-pending", "is-failed");
    const note = pendingRow.querySelector(".pending-note");
    if (note) note.textContent = "Not sent";
    pendingRow = null;
  }

  /** Begins (or continues) the streaming bubble for the reply in flight. */
  function openLive() {
    if (live) return live;
    const reasoningBody = el("div", { class: "msg-reasoning-body" });
    const reasoningEl = el("details", { class: "msg-reasoning" }, el("summary", {}, "Thinking…"), reasoningBody);
    reasoningEl.hidden = true;
    const textEl = el("div", { class: "msg-text is-live" });
    live = { node: row("assistant", reasoningEl, textEl), textEl, reasoningEl, reasoningBody, text: "", reasoning: "" };
    return live;
  }

  /** Collapses the reasoning disclosure and swaps its summary once the answer
   *  it preceded is settled — legacy's `settleReasoning()`. */
  function settleReasoning(bubble) {
    if (!bubble.reasoning) return;
    bubble.reasoningEl.open = false;
    bubble.reasoningEl.querySelector("summary").textContent = "Thought for a moment";
  }

  /** Finishes the streaming bubble in place: its text becomes markdown and it stops being live.
   *  Unlike `assistant`, it keeps what was streamed rather than replacing it, because there is no
   *  canonical message for an iteration that ended in a tool call. */
  function settleLive() {
    if (!live) return;
    const bubble = live;
    live = null;
    settleReasoning(bubble);
    bubble.textEl.classList.remove("is-live");
    if (!bubble.text) return;
    clear(bubble.textEl);
    bubble.textEl.append(...renderMarkdown(bubble.text));
  }

  const RENDERERS = {
    user(frame) {
      /* The host's echo of a message. If this client drew it optimistically a moment ago, this frame
       * is that same message coming back settled, not a second one — a conversation admits one turn
       * at a time (wire.ts's `#turns`), so a row still waiting can only be this. Otherwise it came
       * from somewhere this client is not: another tab, another device, or a conversation reopened. */
      if (pendingRow) { settleLocal(); return; }
      row("user", attachmentsOf(frame.attachments), frame.text ? el("div", { class: "msg-text" }, frame.text) : null);
    },
    delta(frame) {
      const bubble = openLive();
      bubble.text += frame.text || "";
      bubble.textEl.textContent = bubble.text;
    },
    reasoning(frame) {
      const bubble = openLive();
      bubble.reasoning += frame.text || "";
      bubble.reasoningEl.hidden = false;
      bubble.reasoningEl.open = true;
      bubble.reasoningBody.textContent = bubble.reasoning;
    },
    assistant(frame) {
      const bubble = openLive();
      settleReasoning(bubble);
      clear(bubble.textEl);
      bubble.textEl.classList.remove("is-live");
      bubble.textEl.append(...renderMarkdown(frame.text || ""));
      live = null;
    },
    "tool-call"(frame) {
      /* A call ends the message that asked for it.
       *
       * A turn can run several model exchanges — say something, call a tool, say something else —
       * and only the last of them produces an `assistant` frame, because `output` carries the turn's
       * final message and nothing before it. Leaving the streaming bubble open across a call meant
       * the next iteration's text landed in the same bubble, `assistant` then cleared it and wrote
       * the final answer over the top, and everything the model said before the call disappeared —
       * while the tool row, appended after the bubble that was already on screen, ended up below the
       * answer it came before. Settling here is what keeps the transcript in the order it happened. */
      settleLive();
      const args = safeJson(frame.args);
      const node = place(
        el(
          "details",
          { class: "msg is-tool is-running", open: true },
          el(
            "summary",
            { class: "msg-tool-head" },
            el("span", { class: "msg-tool-name mono" }, frame.name || "tool"),
            el("span", { class: "msg-tool-status" }, "Running…")
          ),
          args ? el("pre", { class: "msg-tool-args" }, args) : null
        )
      );
      node.dataset.tool = frame.id || "";
    },
    "tool-result"(frame) {
      // Matched to its call by id, when the call's row is still on screen —
      // the summary lands right under the invocation it belongs to, and the
      // card collapses now that there is nothing left running. If the call
      // scrolled out of the live set (a very long transcript), the result
      // still gets its own row rather than being dropped.
      const call = frame.id ? root.querySelector(`[data-tool="${cssEscape(frame.id)}"]`) : null;
      const resultEl = el(
        "div",
        { class: `msg-tool-result${frame.ok === false ? " is-error" : ""}` },
        frame.summary || (frame.ok === false ? "Failed" : "Done")
      );
      if (call) {
        call.classList.remove("is-running");
        call.querySelector(".msg-tool-status").textContent = frame.ok === false ? "Failed" : "Done";
        call.append(resultEl);
        call.open = false;
      } else {
        place(el("details", { class: "msg is-tool" }, resultEl));
      }
    },
    note(frame) {
      row("note", frame.text || "");
    },
    incident(frame) {
      row("note", frame.text || "").classList.add("is-incident");
    },
    "turn-finished"(frame) {
      if (live) settleReasoning(live);
      live = null;
      // A turn that stopped abnormally is worth a line; an ordinary finish is
      // not — the arrival of the assistant message already said "done".
      if (frame.code === undefined) return;
      row("note", `Stopped: ${frame.stopped_by || "error"}`).classList.add("is-error");
    },
  };

  /** Applies one `{type:'event', session, kind, ...}` frame. Frames for a
   *  conversation other than this pane's are the caller's to route — this
   *  instance only ever draws into the transcript it was built for, whether
   *  or not that tab is the one currently showing. */
  function applyEvent(frame) {
    // A package that contributed a renderer for this kind draws it; the built-in table is the
    // fallback, so a contributor can add a kind without the surface knowing what it means. The
    // choice — including the rule that a contributor which declines or throws falls through rather
    // than losing the event — is lib/dispatch.js's, which is where it is covered by tests.
    const choice = chooseTranscriptRow(rendererFor(frame.kind), RENDERERS[frame.kind], frame, { el });
    for (const error of choice.failures) console.error(`a contributed renderer for ${frame.kind} rows failed`, error);
    if (choice.row === "contributed") { place(choice.node); return; }
    choice.builtin?.(frame);
  }

  /** The chip for a turn that just finished: what it spent, and a plain word for a stop that was not
   *  an ordinary finish. Called by app.js right after the `turn-finished` frame has been drawn, with
   *  the phrases lib/usage.js worked out; nothing is drawn when there is nothing to say. */
  function showUsage(parts) {
    if (!parts.length) return;
    place(el("div", { class: "msg msg-usage" }, ...parts.map((part) => el("span", {}, part))));
  }

  function restore(history) {
    reset();
    if (history.truncated) row("note", "Showing the most recent saved messages; earlier messages remain in conversation storage.");
    for (const message of history.messages || []) {
      const text = (message.content || []).filter(part => part.type === "text").map(part => part.text).join("");
      if (message.role === "user") RENDERERS.user({ text });
      else if (message.role === "assistant" && text) RENDERERS.assistant({ text });
      else if (text) RENDERERS.note({ text });
    }
  }

  return { reset, addLocal, settleLocal, failLocal, applyEvent, showUsage, restore };
}

function safeJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}
