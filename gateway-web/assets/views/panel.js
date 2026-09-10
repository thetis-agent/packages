/* Building blocks for the rail's inspector tabs.
 *
 * Opening, closing and the panel chrome live in rail.js — this module keeps
 * only the two generic renderers every inspector needs: a plain section
 * heading, and one whose rows fold away behind it. The skill/tool/model/
 * branch card renderers that used to live here went with the inspectors
 * that needed them; Environment is the only inspector left, and it draws
 * its own rows.
 */

import { el } from "../lib/dom.js";

/** A section heading, with a sentence saying what the section means. Every
 *  panel that groups its rows needs one: the grouping is the explanation, so it
 *  has to be labelled rather than left as an unexplained gap. */
export function section(spec) {
  return el(
    "div",
    { class: "panel-section" },
    el(
      "div",
      { class: "panel-section-head" },
      el("h3", { class: "panel-section-title" }, spec.title),
      typeof spec.count === "number"
        ? el("span", { class: "panel-section-count" }, String(spec.count))
        : null
    ),
    spec.note && el("p", { class: "panel-section-note" }, spec.note)
  );
}

/** A section whose rows fold away behind its heading.
 *
 * The same heading, count and note as `section`, but as a disclosure holding
 * the rows themselves.
 *
 * @param {object} spec              title, count, note, and `open`
 * @param {Node[]} rows              the group's cards
 * @param {(open:boolean)=>void} [spec.onToggle]  told when the user folds it,
 *   so the caller can remember the state across a redraw
 * @param {Node[]} [spec.aside]      status and controls for the group itself,
 *   laid out on the heading row. A control here must stop its own click from
 *   reaching the summary, or pressing it would fold the group as a side effect.
 * @param {string} [spec.mono]       render the title in the mono face, for a
 *   title that is a literal identifier rather than a display name
 */
export function collapsibleSection(spec, rows) {
  const head = el(
    "summary",
    { class: "panel-group-summary" },
    el(
      "div",
      { class: "panel-section-head" },
      el(
        "h3",
        { class: `panel-section-title${spec.mono ? " mono is-literal" : ""}` },
        spec.title
      ),
      typeof spec.count === "number"
        ? el("span", { class: "panel-section-count" }, String(spec.count))
        : null,
      spec.aside && spec.aside.length
        ? el("div", { class: "panel-section-aside" }, spec.aside.filter(Boolean))
        : null
    ),
    spec.note && el("p", { class: "panel-section-note" }, spec.note)
  );

  const node = el(
    "details",
    { class: "panel-group", open: spec.open === true },
    head,
    el("div", { class: "panel-group-body" }, rows.filter(Boolean))
  );

  if (spec.onToggle) node.addEventListener("toggle", () => spec.onToggle(node.open));
  return node;
}
