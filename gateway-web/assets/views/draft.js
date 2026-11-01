/* The draft's body: a new conversation that does not exist yet, and where it will start. It is the "new"
 * empty state with a heading over it, "New conversation", and under that the space it belongs to, so the
 * project a first message lands in is seen before it is sent. */

import { el } from "../lib/dom.js";
import { emptyState } from "./transcript.js";

/**
 * `spaceName` is the name of the project the draft is in; `null` when it is in no project; `undefined`
 * when nothing provides projects, or "" while the name is not known yet, and then no line is drawn. `onExample(text)` fills the composer.
 */
export function draftState(spaceName, onExample) {
  const node = emptyState("new", null, onExample);
  const where = spaceName === undefined || spaceName === "" ? null : spaceName === null ? "not in a project" : `in ${spaceName}`;
  const head = el(
    "div",
    { class: "draft-head" },
    el("span", { class: "draft-title" }, "New conversation"),
    where ? el("span", { class: "draft-where" }, where) : null
  );
  const mark = node.querySelector(".empty-mark");
  if (mark) mark.after(head);
  else node.prepend(head);
  return node;
}
