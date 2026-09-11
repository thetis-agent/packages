/* What a person watches while a change is applied, and the action that starts one.
 *
 * A change here is one transaction, not a sequence of edits: replies in progress are allowed to
 * finish, a restore point is saved, the new version goes in, everything is started and checked, and
 * only then does anything switch over. That is what makes it safe to undo, and it is why this screen
 * exists at all — the alternative is a spinner over a system that is doing six distinguishable things
 * and could stop at any of them.
 *
 * The screen is driven by asking the environment how it is doing, over and over, while a change is in
 * flight. lib/operator.js folds those answers into how far it has got, and it does so monotonically:
 * an answer can be missed entirely, and the connection itself can drop and come back mid-change,
 * because the last step switches over the thing serving this page. A missed answer must cost a tick of
 * detail, never a screen that appears to go backwards.
 *
 * `confirmChange` is the other half, and it is the part ADR 0050 made the page responsible for: before
 * anything commits, show what is about to change and take a distinct second action for it. It is
 * deliberately not a double-click — the facts have to be on screen between the two presses.
 */

import { el } from "../lib/dom.js";
import { popover } from "../lib/toast.js";
import { changeView } from "../lib/operator.js";

const MARKS = { done: "✓", live: "●", todo: "" };

/** One change in flight, as a block the control panel drops into its content pane. `onDone` is offered
 *  only once there is nothing left to watch: a change that has landed still deserves to be read before
 *  the screen goes away, so it is dismissed rather than snatched back. */
export function renderChange(progress, { onDone } = {}) {
  const view = changeView(progress);
  const steps = view.steps.map((step, index) =>
    el(
      "div",
      { class: `step is-${step.mark}` },
      el("span", { class: "step-mark" }, step.mark === "todo" ? String(index + 1) : MARKS[step.mark]),
      el(
        "div",
        { class: "step-copy" },
        el("div", { class: "step-name" }, step.name),
        el("div", { class: "step-note" }, step.note)
      )
    )
  );

  return el(
    "div",
    { class: "change" },
    el(
      "div",
      { class: `change-head is-${view.tone}` },
      el("h3", { class: "change-headline" }, view.headline),
      view.note && el("p", { class: "change-note" }, view.note)
    ),
    el("div", { class: "steps" }, steps),
    /* No way to call it off is drawn, because there is none to draw: once this has begun it runs to
     * either the new version or the one you had, and a button that could only pretend to stop it would
     * be the worst control on the page. */
    view.tone === "busy"
      ? el("div", { class: "warnbox" }, el("span", {}, "Your conversations are paused. They carry on where they left off."))
      : null,
    onDone && view.tone !== "busy"
      ? el("div", { class: "btn-row" }, el("button", { type: "button", class: "ghost-btn", onClick: onDone }, "Back to the control panel"))
      : null
  );
}

/**
 * The confirming action.
 *
 * `facts` is a list of `[label, value]` pairs naming exactly what is about to change — which version,
 * for whom, what the checks said. They are rendered next to the question rather than summarised into
 * it, because "explicit" means the person saw the particulars and not that they pressed twice.
 */
export function confirmChange(anchor, { message, facts = [], detail, confirmLabel, danger = false, onConfirm }) {
  const rows = [];
  for (const [label, value] of facts) rows.push(el("dt", {}, label), el("dd", {}, value));
  popover(anchor, {
    message,
    detail: el(
      "div",
      { class: "confirm-body" },
      rows.length ? el("dl", { class: "popover-facts" }, rows) : null,
      detail && el("p", { class: "confirm-detail" }, detail)
    ),
    confirmLabel,
    danger,
    onConfirm,
  });
}
