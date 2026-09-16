/* Shared pieces of the control panel: tables, badges, fields, buttons, a confirm popover, a directory
 * picker, and key/value lists. Everything is built with el(); nothing here knows what a package or a
 * person is. */

import { el, icon, onClickOutside } from "./dom.js";

export { pickDirectory } from "./dir-picker.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];

/** A table. `columns` is [{ key, label, render?(row), width? }]; `rows` are plain objects. */
export function table(columns, rows, { onRow, selectedKey, rowKey = (r) => r.name, empty = "Nothing here." } = {}) {
  const head = el("tr", {}, ...columns.map((c) => el("th", { style: c.width ? `width:${c.width}` : null }, c.label)));
  const body = rows.map((row) =>
    el(
      "tr",
      { class: `${onRow ? "is-clickable" : ""}${selectedKey != null && rowKey(row) === selectedKey ? " is-selected" : ""}`, tabindex: onRow ? 0 : null, onClick: onRow ? () => onRow(row) : null, onKeydown: onRow ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRow(row); } } : null },
      ...columns.map((c) => el("td", {}, c.render ? c.render(row) : String(row[c.key] ?? "")))
    )
  );
  return el("div", { class: "table-wrap" }, rows.length ? el("table", { class: "table" }, el("thead", {}, head), el("tbody", {}, ...body)) : el("div", { class: "table-empty" }, empty));
}

/** Appends children, skipping null and false, the way el() does. */
export function put(node, ...children) {
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

export function badge(text, tone = "dim") {
  return el("span", { class: `badge is-${tone}` }, text);
}

export function tags(items, tone = "dim", empty = "none") {
  if (!items.length) return el("span", { class: "text-faint" }, empty);
  return el("div", { class: "tags" }, ...items.map((t) => badge(t, tone)));
}

/** A labelled input. `input` is any element; the label wraps it. */
export function field(label, input, hint) {
  return el("label", { class: "field" }, el("span", { class: "field-label" }, label), input, hint && el("span", { class: "field-hint" }, hint));
}

export function button(label, { tone = "quiet", onClick, title, type = "button", disabled } = {}) {
  return el("button", { type, class: `btn is-${tone}`, title, disabled, onClick }, label);
}

/** A definition list of [label, value] pairs. Values may be nodes. */
export function kv(pairs) {
  return el("dl", { class: "kv" }, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? "—")]));
}

export function card(title, ...children) {
  return el("div", { class: "card" }, title && el("div", { class: "card-head" }, title), el("div", { class: "card-body" }, ...children));
}

export function heading(label, note) {
  return el("div", { class: "section-head" }, el("span", { class: "section-label" }, label), note && el("span", { class: "section-note" }, note));
}

/** Marks a node busy: dims it and shows a note. Returns a function that restores it. */
export function busy(node, text) {
  node.classList.add("is-busy");
  const note = el("div", { class: "busy-note" }, el("span", { class: "busy-dot" }), text);
  node.append(note);
  return () => {
    node.classList.remove("is-busy");
    note.remove();
  };
}

/**
 * A confirm popover anchored to a control. `lines` are [label, value] facts the person should read before
 * confirming; `note` is one sentence on what happens next. Resolves true on confirm, false otherwise.
 */
export function confirm(anchor, { title, lines = [], note, confirmLabel = "Confirm", tone = "primary" }) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stop();
      pop.remove();
      document.removeEventListener("keydown", onKey);
      done(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    const pop = el(
      "div",
      { class: "popover", role: "dialog", "aria-label": title },
      el("div", { class: "popover-head" }, el("span", {}, title), el("button", { type: "button", class: "icon-btn sm", title: "Cancel", "aria-label": "Cancel", onClick: () => finish(false) }, icon(X, { size: 11, width: 1.9 }))),
      lines.length ? kv(lines) : null,
      note && el("p", { class: "popover-note" }, note),
      el("div", { class: "popover-actions" }, button("Cancel", { onClick: () => finish(false) }), button(confirmLabel, { tone, onClick: () => finish(true) }))
    );
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`;
    const below = r.bottom + 8;
    pop.style.top = `${below + pop.offsetHeight > window.innerHeight - 12 ? Math.max(12, r.top - pop.offsetHeight - 8) : below}px`;
    const stop = onClickOutside(pop, () => finish(false));
    document.addEventListener("keydown", onKey);
    pop.querySelector(".btn.is-" + tone)?.focus();
  });
}

export function when(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
