/* One conversation's transcript. Draws saved messages and applies live turn events on top:
 * `text` grows a live bubble under a caret, `tool.call` opens a card that `tool.result` fills and settles,
 * `message` settles the bubble into rendered markdown with a usage footnote, `error` becomes a note.
 * Consecutive tool cards sit in one run with a count, so a long stretch of calls reads as one thing. */

import { fmtDuration } from "../lib/activity.js";
import { avatarFor } from "../lib/avatar.js";
import { clear, el, icon } from "../lib/dom.js";
import { gist, usageLine } from "../lib/transcript-format.js";
import { renderMarkdown } from "../lib/markdown.js";
import { store } from "../lib/store.js";
import { createAskTracker } from "./ask.js";
import { isTodoTool, lastPlanText, parsePlan, planLine } from "./plan.js";

const RESULT_PREVIEW = 4000;
const RUN_FOLD = 4; // a restored run of more tool calls than this starts folded
const DOWN = ["M5 8l5 5 5-5"];
const ASK_TOOL = "ask_user";

export function mountTranscript(root, { onNew, onAnswer }) {
  let live = null;        // { node, textEl, text }
  let settled = null;     // the last settled bubble: { node, text }, so the message event can add its usage
  let pendingRow = null;  // the reader's own message awaiting the server's echo
  let run = null;         // the open run of tool cards, or null
  const asks = createAskTracker(); // ask_user forms drawn in place of a tool card
  const todoArgs = new Map(); // todo_* call id -> its args, held from tool.call to tool.result
  let follow = true;
  const jump = el("button", { type: "button", class: "jump-latest", title: "Jump to the latest message", onClick: () => { follow = true; root.scrollTop = root.scrollHeight; draw(); } }, icon(DOWN, { size: 14, width: 2 }), "Latest");
  jump.hidden = true;
  root.parentElement.append(jump);

  root.addEventListener("scroll", () => {
    follow = root.scrollHeight - root.scrollTop - root.clientHeight < 64;
    draw();
  }, { passive: true });

  function draw() {
    jump.hidden = follow || root.scrollHeight <= root.clientHeight + 8;
  }

  function catchUp() {
    if (follow) root.scrollTop = root.scrollHeight;
    else draw();
  }

  function place(node, into = root) {
    root.querySelector(".transcript-empty")?.remove();
    into.append(node);
    catchUp();
    return node;
  }

  function reset() {
    clear(root);
    live = null;
    settled = null;
    pendingRow = null;
    run = null;
    asks.reset();
    todoArgs.clear();
    follow = true;
    draw();
  }

  function showEmpty(kind) {
    reset();
    root.append(
      el(
        "div",
        { class: "transcript-empty" },
        el("span", { class: "empty-mark", "aria-hidden": "true" }, mark()),
        kind === "none"
          ? [el("span", {}, "No conversation open."), el("button", { type: "button", class: "ghost-btn is-primary", onClick: () => onNew() }, "Start a conversation")]
          : el("span", {}, "No messages yet — say something to start.")
      )
    );
  }

  function mark() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 32 32");
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [k, v] of Object.entries({ cx: 16, cy: 16, r: 9, fill: "none", stroke: "currentColor", "stroke-width": 2.5 })) ring.setAttribute(k, v);
    const core = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [k, v] of Object.entries({ cx: 16, cy: 16, r: 3, fill: "currentColor" })) core.setAttribute(k, v);
    svg.append(ring, core);
    return svg;
  }

  function face(kind) {
    if (kind === "assistant") return avatarFor("agent", "Thetis");
    return kind === "user" ? avatarFor("person", store.get("user")?.user || "You") : null;
  }

  function row(kind, ...children) {
    run = null;
    return place(el("div", { class: `msg is-${kind}` }, face(kind), children));
  }

  function userRow(text) {
    // Whatever was asked has now been replied to, one way or another — live or on replay.
    asks.lockAll();
    return row("user", el("div", { class: "msg-text" }, text));
  }

  function note(text, tone) {
    const node = row("note", el("span", { class: "note-dot" }), el("span", {}, text));
    if (tone) node.classList.add(`is-${tone}`);
    return node;
  }

  // ---- the todo plan: one quiet line per todo_* call, the chip and its popover say the rest ----

  /** A todo_* result updates the page's plan for the open session and draws its one-line note. */
  function todoResultRow(id, name, result) {
    const plan = parsePlan(result);
    if (plan) store.setPlan(store.get("current"), plan);
    const args = todoArgs.get(id) || {};
    todoArgs.delete(id);
    if (plan) note(planLine(name, args, plan), "quiet");
  }

  function openLive() {
    if (live) return live;
    const textEl = el("div", { class: "msg-text is-live" });
    live = { node: row("assistant", textEl), textEl, text: "" };
    return live;
  }

  /** Settles the live bubble: markdown replaces the raw stream. Drops it when nothing was said. */
  function settleLive(finalText, usage) {
    if (!live) return;
    const bubble = live;
    live = null;
    const text = finalText ?? bubble.text;
    bubble.textEl.classList.remove("is-live");
    if (!text.trim()) return bubble.node.remove();
    clear(bubble.textEl).append(...renderMarkdown(text));
    settled = { node: bubble.node, text };
    const foot = usageLine(usage, liveModel());
    if (foot) bubble.node.append(foot);
    catchUp();
  }

  function assistantRow(text, usage, model) {
    if (!text.trim()) return;
    const textEl = el("div", { class: "msg-text" }, ...renderMarkdown(text));
    row("assistant", textEl, usageLine(usage, model));
  }

  /** The model the open conversation answers with, for the footnote of a live reply. */
  function liveModel() {
    return store.modelFor(store.get("current"));
  }

  /**
   * The `message` event of a reply that asked for tools arrives after its text was settled by the first
   * `tool.call`. Its usage goes onto that bubble; drawing the text again would show it twice.
   */
  function assistantMessage(content, usage) {
    if (live) return settleLive(content || live.text, usage);
    if (settled && settled.text.trim() === (content || "").trim()) {
      const foot = usageLine(usage, liveModel());
      if (foot && !settled.node.querySelector(".msg-usage")) settled.node.append(foot);
      return;
    }
    assistantRow(content || "", usage, liveModel());
  }

  // ---- tool cards, in runs ----

  function openRun(restoring) {
    if (run) return run;
    const count = el("span", { class: "tool-run-count" });
    const tally = el("span", { class: "tool-run-tally" });
    const node = el("details", { class: "tool-run", open: "" }, el("summary", { class: "tool-run-head" }, count, tally), el("div", { class: "tool-run-body" }));
    run = { node, count, tally, names: new Map(), n: 0, restoring };
    place(node);
    return run;
  }

  function tallyRun() {
    if (!run) return;
    run.count.textContent = `${run.n} ${run.n === 1 ? "tool call" : "tool calls"}`;
    const parts = [...run.names].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name));
    run.tally.textContent = parts.slice(0, 4).join(" · ") + (parts.length > 4 ? " · …" : "");
    if (run.restoring && run.n > RUN_FOLD) run.node.open = false;
  }

  /** A turn that ends while a tool runs leaves its card without a result; say so rather than leave it pulsing. */
  function settleTools(status = "stopped") {
    for (const card of root.querySelectorAll("details.tool.is-running, details.tool[data-await]")) {
      card.classList.remove("is-running");
      card.removeAttribute("data-await");
      card.querySelector(".tool-status").textContent = status;
      card.open = false;
    }
  }

  function toolCard(call, running, restoring = false) {
    let args = "";
    try {
      args = JSON.stringify(call.args ?? {}, null, 2);
    } catch {
      args = "";
    }
    const r = openRun(restoring);
    r.n += 1;
    r.names.set(call.name || "tool", (r.names.get(call.name || "tool") ?? 0) + 1);
    const node = el(
      "details",
      { class: `tool${running ? " is-running" : ""}`, "data-tool": call.id || "", "data-since": running ? String(Date.now()) : null, "data-await": restoring ? "" : null },
      el(
        "summary",
        { class: "tool-head" },
        el("span", { class: "tool-name" }, call.name || "tool"),
        el("span", { class: "tool-gist", title: gist(call.args, 400) }, gist(call.args, 90)),
        el("span", { class: "tool-took" }),
        el("span", { class: "tool-status" }, running ? "running" : "…")
      ),
      args && args !== "{}" ? [el("div", { class: "tool-label" }, "arguments"), el("pre", { class: "tool-pre" }, args)] : null
    );
    r.node.querySelector(".tool-run-body").append(node);
    tallyRun();
    catchUp();
    return node;
  }

  /** Draws an ask_user call as a form; false means the caller should fall back to a tool card. */
  function askRow(call) {
    run = null; // the ask card is a message-level row, like a chat bubble, not part of a tool run
    return asks.draw(call, { place, onAnswer });
  }

  function toolResult(id, name, result) {
    const failed = /^error:/i.test(result || "");
    const card = id ? root.querySelector(`details.tool[data-tool="${cssEscape(id)}"]`) : null;
    if (!card) {
      const node = toolCard({ id, name, args: {} }, false, !live && !pendingRow);
      node.append(...resultSection(result || "", failed));
      node.classList.toggle("is-bad", failed);
      node.querySelector(".tool-status").textContent = failed ? "failed" : "done";
      return;
    }
    card.classList.remove("is-running");
    card.removeAttribute("data-await");
    card.classList.toggle("is-bad", failed);
    card.querySelector(".tool-status").textContent = failed ? "failed" : "done";
    const since = Number(card.dataset.since);
    if (since) card.querySelector(".tool-took").textContent = fmtDuration(Date.now() - since);
    card.append(...resultSection(result || "", failed));
    card.open = false;
    catchUp();
  }

  function resultSection(text, failed) {
    const label = el("div", { class: "tool-label" }, failed ? "error" : "result");
    if (text.length <= RESULT_PREVIEW) return [label, el("pre", { class: `tool-pre${failed ? " is-error" : ""}` }, text)];
    const pre = el("pre", { class: `tool-pre${failed ? " is-error" : ""}` }, `${text.slice(0, RESULT_PREVIEW)}\n…`);
    const more = el("button", { type: "button", class: "tool-more", onClick: () => { pre.textContent = text; more.remove(); } }, `show all ${Math.max(1, Math.round(text.length / 1024))} KB`);
    return [label, pre, more];
  }

  // ---- the reader's own message ----

  function addLocal(text) {
    live = null;
    pendingRow = userRow(text);
    pendingRow.classList.add("is-pending");
    pendingRow.append(el("span", { class: "pending-note" }, "Sending…"));
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
    const n = pendingRow.querySelector(".pending-note");
    if (n) n.textContent = "Not sent";
    pendingRow = null;
  }

  /** A saved message from the session record. `usage` is what the gateway recorded for it, if anything. */
  function drawMessage(message, usage) {
    if (message.role === "user") return userRow(message.content);
    if (message.role === "assistant") {
      assistantRow(message.content || "", usage);
      for (const call of message.toolCalls ?? []) {
        if (call.name === ASK_TOOL && askRow(call)) continue;
        if (isTodoTool(call.name)) { todoArgs.set(call.id, call.args || {}); continue; }
        toolCard(call, false, true);
      }
      return;
    }
    if (message.role === "tool") {
      // The ask form already says everything the result would; the result itself
      // (the fixed "questions recorded" text) is not something a reader needs to see.
      if (message.name === ASK_TOOL && !root.querySelector(`details.tool[data-tool="${cssEscape(message.toolCallId)}"]`)) return;
      if (isTodoTool(message.name)) return todoResultRow(message.toolCallId, message.name, message.content);
      return toolResult(message.toolCallId, message.name, message.content);
    }
    if (message.content) note(message.content);
  }

  /** One live turn event. `input` accompanies `turn.start`. */
  function applyEvent(event, input) {
    switch (event.type) {
      case "turn.start":
        if (pendingRow) settleLocal();
        else if (input) userRow(input);
        break;
      case "text": {
        const bubble = openLive();
        bubble.text += event.delta || "";
        bubble.textEl.textContent = bubble.text;
        catchUp();
        break;
      }
      case "tool.call":
        settleLive();
        // The form stands in for the tool row entirely; showing both would put
        // the same questions on screen twice, once as raw JSON.
        if (event.call?.name === ASK_TOOL && askRow(event.call)) break;
        // A todo_* call draws no card at all; its result draws the one quiet line.
        if (isTodoTool(event.call?.name)) { run = null; todoArgs.set(event.call.id, event.call.args || {}); break; }
        toolCard(event.call, true);
        break;
      case "tool.result":
        // The card already said everything the result would; skip it unless the
        // call somehow never got its own row (a malformed call fell through to
        // the ordinary tool card, which does want its result shown).
        if (event.name === ASK_TOOL && !root.querySelector(`details.tool[data-tool="${cssEscape(event.id)}"]`)) break;
        if (isTodoTool(event.name)) { todoResultRow(event.id, event.name, event.result); break; }
        toolResult(event.id, event.name, event.result);
        break;
      case "message":
        if (event.message?.role !== "assistant") break;
        assistantMessage(event.message.content, event.usage);
        break;
      case "error":
        settleLive();
        settleTools(event.code === "cancelled" ? "stopped" : "no result");
        if (event.code === "cancelled") note("Stopped.", "quiet");
        else note(`The turn failed: ${event.message || "no reason given"}`, "error");
        break;
      case "turn.end":
        settleLive();
        settleTools();
        failLocal();
        run = null;
        break;
      default:
        break;
    }
  }

  function seedPlan(record) {
    const text = lastPlanText(record);
    store.setPlan(store.get("current"), text ? parsePlan(text) : null);
  }

  /** Rebuilds from a session record, including the turn in progress if there is one. */
  function restore(record) {
    reset();
    seedPlan(record);
    (record.conversation ?? []).forEach((message, index) => drawMessage(message, record.usage?.[index]));
    settleTools("no result");
    run = null;
    if (record.turn) {
      userRow(record.turn.input);
      for (const { event } of record.turn.events ?? []) applyEvent(event);
    }
    if (!root.childElementCount) showEmpty("empty");
    root.scrollTop = root.scrollHeight;
    follow = true;
    draw();
  }

  showEmpty("none");
  return { reset, showEmpty, restore, applyEvent, addLocal, settleLocal, failLocal };
}



function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}
