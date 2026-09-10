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

import { clear, el } from "../lib/dom.js";
import { renderMarkdown } from "../lib/markdown.js";
import { rendererFor } from "../lib/surface.js";

export function mountTranscriptInto(root) {
  /** The bubble currently receiving `delta`/`reasoning` text for the turn in
   *  flight, or null between turns. Replaced with the rendered final text when
   *  `assistant` arrives, so streaming never double-renders markdown. */
  let live = null;
  /** The most recently sent local row, still waiting on `accepted` (or an
   *  `error`) to say whether it actually went. There is at most one: the
   *  composer refuses a second send while one is pending. */
  let pendingRow = null;

  reset();

  function atBottom() {
    return root.scrollHeight - root.scrollTop - root.clientHeight < 48;
  }
  function toBottom() {
    root.scrollTop = root.scrollHeight;
  }

  function reset() {
    clear(root);
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

  /** Appends a prebuilt node (a `<div>` or a `<details>`) as a transcript row. */
  function place(node) {
    const stick = atBottom();
    clearEmpty();
    root.append(node);
    if (stick) toBottom();
    return node;
  }

  function row(kind, ...children) {
    return place(el("div", { class: `msg is-${kind}` }, children));
  }

  /** The person's own message, drawn immediately on send with a pending mark
   *  that `settleLocal`/`failLocal` clears once the socket says what happened
   *  — `accepted`, this wire's actual send-acknowledgement, standing in for
   *  the legacy `input`-echo settle (the running kernel does not emit `input`
   *  events onto this wire; render.ts's own doc comment says so). */
  function addLocal(text) {
    live = null;
    const note = el("span", { class: "pending-note" }, "Sending…");
    pendingRow = row("user", el("div", { class: "msg-text" }, text), note);
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

  const RENDERERS = {
    user(frame) {
      // An echo of a message this client did not itself just draw — another
      // tab, another device. Rare today (see the module doc), handled anyway.
      row("user", el("div", { class: "msg-text" }, frame.text || ""));
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
    // fallback, so a contributor can add a kind without the surface knowing what it means.
    const contributed = rendererFor(frame.kind);
    if (contributed) {
      const node = contributed(frame, { el });
      if (node) { place(node); return; }
    }
    RENDERERS[frame.kind]?.(frame);
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

  return { reset, addLocal, settleLocal, failLocal, applyEvent, restore };
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
