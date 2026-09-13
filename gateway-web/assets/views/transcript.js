/* One conversation's transcript. Draws saved messages and applies live turn events on top:
 * `text` grows a live bubble under a caret, `tool.call` opens a card that `tool.result` fills and collapses,
 * `message` settles the bubble into rendered markdown, `error` becomes a note. */

import { avatarFor } from "../lib/avatar.js";
import { clear, el } from "../lib/dom.js";
import { renderMarkdown } from "../lib/markdown.js";
import { store } from "../lib/store.js";

export function mountTranscript(root, { onNew }) {
  let live = null;        // { textEl, text }
  let pendingRow = null;  // the reader's own message awaiting the server's echo
  let follow = true;

  root.addEventListener("scroll", () => {
    follow = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
  }, { passive: true });

  function place(node) {
    root.querySelector(".transcript-empty")?.remove();
    root.append(node);
    if (follow) root.scrollTop = root.scrollHeight;
    return node;
  }

  function reset() {
    clear(root);
    live = null;
    pendingRow = null;
    follow = true;
  }

  function showEmpty(kind) {
    reset();
    root.append(
      el(
        "div",
        { class: "transcript-empty" },
        kind === "none"
          ? [el("span", {}, "No conversation open."), el("button", { type: "button", class: "ghost-btn is-primary", onClick: () => onNew() }, "Start a conversation")]
          : el("span", {}, "No messages yet — say something to start.")
      )
    );
  }

  function face(kind) {
    if (kind === "assistant") return avatarFor("agent", "Thetis");
    return kind === "user" ? avatarFor("person", store.get("user")?.user || "You") : null;
  }

  function row(kind, ...children) {
    return place(el("div", { class: `msg is-${kind}` }, face(kind), children));
  }

  function userRow(text) {
    return row("user", el("div", { class: "msg-text" }, text));
  }

  function note(text, error = false) {
    return row("note", text).classList.toggle("is-error", error);
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
    const meta = metaLine(usage);
    if (meta) bubble.textEl.before(meta);
    clear(bubble.textEl).append(...renderMarkdown(text));
    if (follow) root.scrollTop = root.scrollHeight;
  }

  function assistantRow(text, usage) {
    if (!text.trim()) return;
    const textEl = el("div", { class: "msg-text" }, ...renderMarkdown(text));
    row("assistant", metaLine(usage), textEl);
  }

  function toolCard(call, running) {
    let args = "";
    try {
      args = JSON.stringify(call.args ?? {}, null, 2);
    } catch {
      args = "";
    }
    const node = place(
      el(
        "details",
        { class: `msg is-tool${running ? " is-running" : ""}`, open: running || undefined, "data-tool": call.id || "" },
        el("summary", { class: "msg-tool-head" }, el("span", { class: "msg-tool-name" }, call.name || "tool"), el("span", { class: "msg-tool-status" }, running ? "Running…" : "Done")),
        args && args !== "{}" ? el("pre", { class: "msg-tool-args" }, args) : null
      )
    );
    return node;
  }

  function toolResult(id, name, result) {
    const failed = /^error:/.test(result || "");
    const card = id ? root.querySelector(`details[data-tool="${cssEscape(id)}"]`) : null;
    const body = el("div", { class: `msg-tool-result${failed ? " is-error" : ""}` }, clip(result || "", 4000));
    if (card) {
      card.classList.remove("is-running");
      card.querySelector(".msg-tool-status").textContent = failed ? "Failed" : "Done";
      card.append(body);
      card.open = false;
    } else {
      place(el("details", { class: "msg is-tool" }, el("summary", { class: "msg-tool-head" }, el("span", { class: "msg-tool-name" }, name || "tool"), el("span", { class: "msg-tool-status" }, failed ? "Failed" : "Done")), body));
    }
  }

  /** The reader's own message, drawn on send; the turn's `turn.start` echo settles it. */
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
      for (const call of message.toolCalls ?? []) toolCard(call, false);
      return;
    }
    if (message.role === "tool") return toolResult(message.toolCallId, message.name, message.content);
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
        if (follow) root.scrollTop = root.scrollHeight;
        break;
      }
      case "tool.call":
        settleLive();
        toolCard(event.call, true);
        break;
      case "tool.result":
        toolResult(event.id, event.name, event.result);
        break;
      case "message":
        if (event.message?.role !== "assistant") break;
        if (live) settleLive(event.message.content || live.text, event.usage);
        else assistantRow(event.message.content || "", event.usage);
        break;
      case "error":
        settleLive();
        if (event.code === "cancelled") note("Turn stopped.");
        else note(`Error: ${event.message || "the turn failed"}`, true);
        break;
      case "turn.end":
        settleLive();
        failLocal();
        break;
      default:
        break;
    }
  }

  /** Rebuilds from a session record, including the turn in progress if there is one. */
  function restore(record) {
    reset();
    (record.conversation ?? []).forEach((message, index) => drawMessage(message, record.usage?.[index]));
    if (record.turn) {
      userRow(record.turn.input);
      for (const { event } of record.turn.events ?? []) applyEvent(event);
    }
    if (!root.childElementCount) showEmpty("empty");
    root.scrollTop = root.scrollHeight;
    follow = true;
  }

  showEmpty("none");
  return { reset, showEmpty, restore, applyEvent, addLocal, settleLocal, failLocal };
}

/* The accounting header over a reply. Reads the usage by field name; nothing reported means no header. */
function metaLine(usage) {
  if (!usage || typeof usage !== "object") return null;
  const parts = [];
  const prompt = usage.prompt_tokens;
  if (typeof usage.cache_read_tokens === "number" && prompt) parts.push(`cached ${Math.round((usage.cache_read_tokens / prompt) * 100)}%`);
  if (typeof prompt === "number") parts.push(`${compact(prompt)} in`);
  if (typeof usage.completion_tokens === "number") parts.push(`${compact(usage.completion_tokens)} out`);
  if (typeof usage.cost === "number") parts.push(`$${usage.cost.toFixed(4)}`);
  if (!parts.length) return null;
  const title = typeof usage.cache_write_tokens === "number" ? `cache read ${usage.cache_read_tokens ?? 0}, cache write ${usage.cache_write_tokens}, prompt ${prompt ?? 0}` : undefined;
  return el("div", { class: "msg-meta", title }, parts.join(" · "));
}

function compact(n) {
  return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more characters]` : text;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}
