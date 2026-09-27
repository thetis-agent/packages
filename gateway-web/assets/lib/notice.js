/* Notices: the persistent cards in the bottom-right corner, above the toasts. A toast says what just
 * happened and fades; a notice says what is true until it is not ("Thetis restarts in 20 s", "Updates for
 * 3 extensions", "Thetis was updated · Refresh") and stays until its owner closes it or the person dismisses
 * it. One card per id: a second `notice(id, …)` replaces the first in place, so a countdown or a progress
 * sequence is one card that changes, never a pile. The corner is one column shared with the toasts, so the
 * two never overlap. */

import { el, icon } from "./dom.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
const cards = new Map(); // id -> { node, spec }
let corner = null;
let host = null;

/** The column both notices and toasts live in: notices first, so the toasts sit under them at the bottom. */
export function cornerHost() {
  if (!corner) {
    corner = el("div", { class: "corner" });
    host = el("div", { class: "notice-host", role: "region", "aria-label": "Notices" });
    corner.append(host);
    document.body.append(corner);
  }
  return corner;
}

function drawProgress(progress) {
  const steps = Array.isArray(progress?.steps) ? progress.steps : [];
  const at = Number(progress?.at) || 0;
  return el(
    "ol",
    { class: "notice-steps" },
    steps.map((step, i) => {
      const state = i < at ? "done" : i === at ? (progress.failed ? "failed" : "now") : "later";
      return el("li", { class: `notice-step is-${state}` }, String(step));
    })
  );
}

function drawCard(id, spec) {
  const tone = ["info", "warn", "error", "ok"].includes(spec.tone) ? spec.tone : "info";
  const body = spec.body instanceof Node ? spec.body : spec.body ? el("p", { class: "notice-body" }, String(spec.body)) : null;
  const actions = (spec.actions ?? []).map((action) => {
    const button = el("button", { type: "button", class: `notice-action${action.primary ? " is-primary" : ""}` }, action.label);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action.run?.();
      } catch (err) {
        console.error(`the notice "${id}" action "${action.label}" failed:`, err);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  });
  const dismiss = spec.dismissible === false
    ? null
    : el("button", { type: "button", class: "notice-x", title: "Dismiss", "aria-label": "Dismiss", onClick: () => { close(id); try { spec.onDismiss?.(); } catch (err) { console.error(err); } } }, icon(X, { size: 11, width: 1.9 }));
  return el(
    "div",
    { class: `notice is-${tone}`, "data-notice": id, role: tone === "error" ? "alert" : "status" },
    el("div", { class: "notice-head" }, el("span", { class: "notice-title" }, String(spec.title ?? "")), dismiss),
    body,
    spec.progress ? drawProgress(spec.progress) : null,
    actions.length ? el("div", { class: "notice-actions" }, actions) : null
  );
}

function put(id, spec) {
  cornerHost();
  const node = drawCard(id, spec);
  const had = cards.get(id);
  if (had) had.node.replaceWith(node);
  else host.append(node);
  cards.set(id, { node, spec });
}

/** Removes the card with this id; closing one that is not there is not an error. */
export function close(id) {
  const had = cards.get(id);
  if (!had) return;
  had.node.remove();
  cards.delete(id);
}

/**
 * Shows or replaces the card `id`. `spec`: `{ title, body?, tone?, actions?: [{ label, run, primary? }],
 * progress?: { steps, at, failed? }, dismissible? = true, onDismiss? }`. Answers `{ update(partial), close() }`;
 * `update` merges into what the card says now, so a caller changes only what changed.
 */
export function notice(id, spec) {
  const key = String(id);
  put(key, { ...spec });
  return Object.freeze({
    /** A card the person dismissed stays dismissed: an update to it is dropped, not a way back on screen. */
    update(partial) {
      const now = cards.get(key);
      if (now) put(key, { ...now.spec, ...partial });
    },
    close: () => close(key),
  });
}
notice.close = close;
/** Whether a card with this id is showing. */
notice.has = (id) => cards.has(String(id));
