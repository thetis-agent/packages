/* Editing a message the person sent, and what it replaced. `mountEditor` turns a user row into a textarea
 * with Cancel and Send; the transcript does the rest (the request, the rows that go, the pending row).
 * `versionsBlock` draws what harness-core kept of the replies an edit replaced: read only, with the work
 * they did counted rather than drawn, and a Copy, because it is the one record of what was said there. */

import { el } from "../lib/dom.js";

export const EDIT_NOTE = "Replies after this are replaced. Changes already made to files and elsewhere stay.";

/**
 * Opens the editor inside `row`, whose own text it hides until it closes. `attachments` are the message's
 * non-text parts, shown as the chips that will be kept. `onSend(text)` is called with what the textarea
 * holds; `onCancel()` when the person lets go. Ctrl/Cmd+Enter sends and Escape cancels. Answers `{ close }`.
 */
export function mountEditor(row, { text = "", attachments = [], onSend, onCancel } = {}) {
  const input = el("textarea", { class: "edit-input", rows: String(Math.min(12, Math.max(2, text.split("\n").length))), "aria-label": "Edit your message" });
  input.value = text;
  const send = () => {
    if (!input.value.trim() && !attachments.length) return;
    close();
    onSend?.(input.value);
  };
  const cancel = () => {
    close();
    onCancel?.();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  const chips = attachments.length
    ? el("div", { class: "edit-attachments" }, ...attachments.map((part) => el("span", { class: "edit-chip", title: "Kept with the message" }, part.data?.name || part.data?.mediaType || "Attachment")))
    : null;
  const box = el(
    "div",
    { class: "edit-box" },
    input,
    chips,
    el("div", { class: "edit-note" }, EDIT_NOTE),
    el("div", { class: "edit-actions" },
      el("button", { type: "button", class: "ghost-btn sm", onClick: cancel }, "Cancel"),
      el("button", { type: "button", class: "ghost-btn sm is-primary", onClick: send }, "Send"))
  );
  row.classList.add("is-editing");
  row.append(box);
  input.focus?.();
  function close() {
    box.remove();
    row.classList.remove("is-editing");
  }
  return { close, input };
}

/** "1 Nov 14:03", in the reader's own time. */
export function editedWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "and 12 tool calls, 2 subagents", or "" when the replaced replies did no work. */
export function workLine(messages) {
  const tools = messages.reduce((n, m) => n + (Number(m.tools) || 0), 0);
  const agents = messages.reduce((n, m) => n + (Number(m.agents) || 0), 0);
  const parts = [];
  if (tools) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
  if (agents) parts.push(`${agents} subagent${agents === 1 ? "" : "s"}`);
  return parts.length ? `and ${parts.join(", ")}` : "";
}

/**
 * The earlier versions of one message, newest first, as `edit-versions` answers them:
 * `[{ at, editedAt, turn, messages: [{ role, text, tools, agents }] }]`. One version is "Before the edit ·
 * <when>"; several are "Earlier versions (n)" with each one's time on it.
 */
export function versionsBlock(versions) {
  const one = versions.length === 1;
  const head = one ? `Before the edit · ${editedWhen(versions[0].editedAt)}` : `Earlier versions (${versions.length})`;
  return el("div", { class: "edit-versions" },
    el("div", { class: "edit-versions-head" }, head),
    ...versions.map((version) => versionNode(version, one)));
}

function versionNode(version, alone) {
  const messages = Array.isArray(version.messages) ? version.messages : [];
  const said = messages.filter((m) => String(m.text ?? "").trim());
  const work = workLine(messages);
  const copy = el("button", { type: "button", class: "md-copy edit-copy", title: "Copy this version" }, "Copy");
  copy.addEventListener("click", () => {
    const text = said.map((m) => m.text).join("\n\n");
    navigator.clipboard?.writeText(text).then(() => flash(copy, "copied"), () => flash(copy, "copy failed"));
  });
  return el("div", { class: "edit-version" },
    alone ? null : el("div", { class: "edit-version-when" }, editedWhen(version.editedAt)),
    ...said.map((m) => el("div", { class: `edit-version-msg is-${m.role === "user" ? "user" : "assistant"}` }, m.text)),
    work ? el("div", { class: "edit-version-work" }, work) : null,
    el("div", { class: "edit-version-actions" }, copy));
}

function flash(button, text) {
  const previous = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = previous), 1200);
}
