/* Small pieces the three views share: chips, icon buttons, the top bar's crumbs, and a chooser popover.
 * Everything is built with ext.dom.el and textContent; nothing here parses markup. */

import { svgIcon } from "./icons.js";
import { runLabel, runTone } from "./runstate.js";

/** A pill: `tone` is dim, accent, ok, warn or err. */
export function chip(ext, text, tone = "dim", { mono = false, pulse = false, title } = {}) {
  const { el } = ext.dom;
  return el("span", { class: `wf-chip is-${tone}${mono ? " is-mono" : ""}`, title }, pulse ? el("span", { class: "wf-pulse", "aria-hidden": "true" }) : null, text);
}

export function stateChip(ext, state) {
  return chip(ext, runLabel(state), runTone(state), { pulse: state === "running" });
}

/** A button that shows only an icon; the label is its accessible name and tooltip. */
export function iconButton(ext, icon, label, onClick, { className = "" } = {}) {
  const { el } = ext.dom;
  return el("button", { type: "button", class: `wf-icon-btn ${className}`.trim(), "aria-label": label, title: label, onClick }, svgIcon(icon, { size: 15 }));
}

/** A shell button with an icon before its text. */
export function button(ext, label, { tone = "quiet", icon, onClick, disabled, title, className = "" } = {}) {
  const { el } = ext.dom;
  return el("button", { type: "button", class: `btn is-${tone} wf-btn ${className}`.trim(), onClick, disabled, title }, icon ? svgIcon(icon, { size: 13 }) : null, label);
}

/** The crumb row at the start of a view's bar: the place mark, then each crumb, the last one current. */
export function crumbs(ext, items) {
  const { el } = ext.dom;
  const out = [el("span", { class: "wf-mark", "aria-hidden": "true" }, svgIcon("workflow", { size: 15 }))];
  items.forEach((item, i) => {
    if (i) out.push(el("span", { class: "wf-crumb-sep", "aria-hidden": "true" }, svgIcon("chevron", { size: 12 })));
    if (item.onClick) out.push(el("button", { type: "button", class: "wf-crumb", onClick: item.onClick }, item.label));
    else if (item.node) out.push(item.node);
    else out.push(el("span", { class: "wf-crumb is-current", "aria-current": "page" }, item.label));
  });
  return el("nav", { class: "wf-crumbs", "aria-label": "Breadcrumb" }, ...out);
}

/**
 * A small menu at a point, for a choice the canvas cannot make alone (which field a connection sets).
 * It has the shell's `popover` class, so the place's Escape closes it rather than the place. `items` are
 * `{ label, note?, run }`; `extra` is an optional node under them. Returns the close function.
 */
export function chooser(ext, { x, y }, { title, items, extra }) {
  const { el } = ext.dom;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    pop.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const onOutside = (e) => {
    if (!pop.contains(e.target)) close();
  };
  const pop = el(
    "div",
    { class: "popover wf-chooser", role: "dialog", "aria-label": title },
    el("div", { class: "popover-head" }, el("span", {}, title), iconButton(ext, "x", "Close", close)),
    el(
      "div",
      { class: "wf-chooser-items", role: "menu" },
      ...items.map((item) =>
        el(
          "button",
          { type: "button", class: "wf-chooser-item", role: "menuitem", onClick: () => { close(); item.run(); } },
          el("span", { class: "wf-chooser-label" }, item.label),
          item.note ? el("span", { class: "wf-chooser-note" }, item.note) : null
        )
      )
    ),
    extra ?? null
  );
  document.body.append(pop);
  const w = Math.min(300, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(x, window.innerWidth - w - 12))}px`;
  pop.style.top = `${Math.max(12, Math.min(y, window.innerHeight - pop.offsetHeight - 12))}px`;
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  pop.querySelector(".wf-chooser-item, input")?.focus();
  return close;
}

/** The feed's state in words, for the line a view shows when its live updates are not live. */
export function feedNote(ext, feed) {
  const { el } = ext.dom;
  if (feed.status === "lost") return el("p", { class: "wf-feed-note", role: "status" }, "Live updates stopped. Trying again…");
  return null;
}
