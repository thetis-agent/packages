/* Toasts: outcomes and refusals, in the corner, under the notices (lib/notice.js). Errors stay until
 * dismissed; the rest fade. On a phone, while a field has the focus (a key being typed, the keyboard up), the
 * corner moves to the top of the screen, so a toast never covers the field being edited. */

import { el, icon } from "./dom.js";
import { cornerHost } from "./notice.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
let host = null;
let watching = false;

/** Whether the focus is in something a person types into. */
const editing = () => Boolean(document.activeElement?.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable=''], [contenteditable='true']"));

/** Keeps the corner at the top on a phone while a field has the focus, and in its corner otherwise. */
function watchFocus(corner) {
  if (watching || typeof matchMedia !== "function") return;
  watching = true;
  const narrow = matchMedia("(max-width: 600px)");
  const apply = () => corner.classList.toggle("is-top", narrow.matches && editing());
  document.addEventListener("focusin", apply);
  document.addEventListener("focusout", () => setTimeout(apply, 0));
  narrow.addEventListener?.("change", apply);
  apply();
}

export function toast(message, { tone = "info", action } = {}) {
  if (!host) {
    host = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    cornerHost().append(host);
    watchFocus(cornerHost());
  }
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 160);
  };
  const node = el(
    "div",
    { class: `toast is-${tone}` },
    el("span", { class: "toast-text" }, message),
    action && el("button", { type: "button", class: "toast-action", onClick: () => { action.run(); dismiss(); } }, action.label),
    el("button", { type: "button", class: "toast-x", title: "Dismiss", "aria-label": "Dismiss", onClick: dismiss }, icon(X, { size: 11, width: 1.9 }))
  );
  if (tone !== "error") timer = setTimeout(dismiss, action ? 8000 : 5000);
  host.append(node);
  while (host.children.length > 4) host.firstChild.remove();
  return dismiss;
}
