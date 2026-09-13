/* Toasts: outcomes and refusals, in the corner. Errors stay until dismissed; the rest fade. */

import { el, icon } from "./dom.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
let host = null;

export function toast(message, { tone = "info", action } = {}) {
  if (!host) {
    host = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(host);
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
