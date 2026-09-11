/* The package explorer: everything added here, and what each one brings.
 *
 * A table on the left and one package's detail on the right, which is the shape this list wants: the
 * columns answer "what is here" at a glance and the column beside them answers "what is this" without
 * losing your place in the list.
 *
 * Two things the table says are reported, never offered as controls. Who a package runs for — only
 * you, or everyone — is the package's own declaration, and it is the real axis behind the two ways to
 * add a version rather than a preference someone sets. Whether a package may reach the internet is
 * fixed when it is added and cannot be changed afterwards, which is exactly why it is worth a column.
 *
 * The ways to add a version are drawn from what this deployment offers and nothing else. An update is
 * not a smaller kind of adding one: it works out a whole new set of versions and switches the setup
 * over in one go, the same as any other change — which is why both go through the same screen and the
 * same confirming action, and why nothing in the wording here suggests otherwise. Where a deployment
 * offers neither, no button is drawn: a control that would always refuse is worse than none.
 */

import { el } from "../lib/dom.js";
import { installChoices, packageRows } from "../lib/operator.js";

/** Renders the explorer. `state` carries the described setup, the filter and which row is selected;
 *  the caller owns it so the selection survives a redraw. */
export function renderPackages(state, { offered, onSelect, onFilter, onAdd }) {
  const rows = packageRows(state.packages, state.filter);
  const selected = rows.find((row) => row.name === state.selected) || rows[0] || null;

  const search = el("input", {
    type: "text",
    value: state.filter || "",
    placeholder: "Filter packages",
    "aria-label": "Filter packages",
    autocomplete: "off",
    spellcheck: "false",
    onInput: (event) => onFilter(event.currentTarget.value),
  });

  const head = el(
    "div",
    { class: "sec" },
    el(
      "div",
      {},
      el("h3", { class: "panel-section-title" }, "Added here"),
      el("p", { class: "panel-section-note" }, `${String(rows.length)} ${rows.length === 1 ? "package" : "packages"}`)
    ),
    el("div", { class: "sec-aside" }, el("div", { class: "srch" }, search))
  );

  const table = el(
    "div",
    { class: "tbl-wrap" },
    el(
      "table",
      { class: "tbl" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Package"),
          el("th", {}, "Version"),
          el("th", {}, "Runs for"),
          el("th", {}, "Internet")
        )
      ),
      el("tbody", {}, rows.map((row) => packageRow(row, selected, onSelect)))
    )
  );

  return el(
    "div",
    { class: "cols" },
    el("div", { class: "colscroll" }, head, rows.length ? table : el("div", { class: "panel-note" }, "Nothing to show yet.")),
    el("div", { class: "colscroll" }, selected ? detail(selected, offered, onAdd) : null)
  );
}

function packageRow(row, selected, onSelect) {
  return el(
    "tr",
    {
      class: selected && selected.name === row.name ? "is-sel" : "",
      tabindex: "0",
      onClick: () => onSelect(row.name),
      onKeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(row.name);
        }
      },
    },
    el("td", { class: "pk-name" }, row.name),
    el("td", { class: "pk-ver" }, row.version || "—"),
    el("td", {}, row.scope ? el("span", { class: "pill" }, row.scopeLabel) : el("span", { class: "quiet" }, "—")),
    el("td", {}, row.internet ? el("span", { class: "pill pill-warn" }, "Yes") : el("span", { class: "quiet" }, "No"))
  );
}

function detail(row, offered, onAdd) {
  const facts = [];
  for (const [label, value] of [
    ["version", row.version || "—"],
    ["runs for", row.scope ? row.scopeLabel : "no service of its own"],
    ["internet", row.internet ? "yes" : "no"],
  ]) {
    facts.push(el("dt", {}, label), el("dd", {}, value));
  }

  const lists = [];
  if (row.gives.length) lists.push(listing("What it brings", row.gives, "pill pill-on"));
  if (row.needs.length) lists.push(listing("What it needs", row.needs, "pill"));

  return el(
    "div",
    { class: "det" },
    el("div", { class: "det-head" }, el("div", { class: "det-name" }, row.name)),
    el(
      "div",
      { class: "det-body" },
      el("dl", { class: "kv" }, facts),
      ...lists,
      addBlock(row, offered, onAdd)
    )
  );
}

function listing(title, values, pill) {
  return el(
    "div",
    { class: "det-sec" },
    el("div", { class: "det-sec-t" }, title),
    el("div", { class: "taglist" }, values.map((value) => el("span", { class: pill }, value)))
  );
}

/* The two ways to put a version in place, side by side, so the difference between them is the thing
 * being read rather than something hidden behind a menu. Both go through the same screen afterwards,
 * because they are the same change made for a different number of people. */
function addBlock(row, offered, onAdd) {
  const choices = installChoices(offered);
  if (!choices.length) return null;
  return el(
    "div",
    { class: "install" },
    el("div", { class: "install-head" }, el("span", { class: "install-t" }, "Put a version in place")),
    el(
      "div",
      { class: "install-body" },
      choices.map((choice) =>
        el(
          "div",
          { class: "opt" },
          el(
            "div",
            { class: "opt-top" },
            el("span", { class: `opt-scope is-${choice.scope}` }, choice.label)
          ),
          el("div", { class: "opt-note" }, choice.note),
          el(
            "div",
            { class: "btn-row" },
            el(
              "button",
              {
                type: "button",
                class: choice.scope === "deployment" ? "btn btn-warn" : "btn btn-primary",
                onClick: (event) => onAdd(event.currentTarget, row, choice),
              },
              choice.scope === "deployment" ? "Make it the default" : "Put it in place"
            )
          )
        )
      )
    )
  );
}
