/* Drawing for the Tools inspector. surface/fold.js decides what is true; this decides how it reads.
 *
 * The DOM helpers arrive as an argument rather than an import so that panel.js stays the one module
 * that touches `/lib/surface.js` — the seam contract/surface names — and so every branch below can be
 * exercised against a recording stand-in in view.test.ts. Nothing here sets a `style` attribute: the
 * surface is served under `default-src 'self'` with no `unsafe-inline` (lib/assets' csp).
 */

export const limits = {
  /** Characters of an argument schema shown before it is cut; a schema is a reading aid, not a dump. */
  chars: 4000,
  /** Deny entries spelled out in the banner before the rest are counted instead. */
  denied: 12,
};

/** Each flag a tool declares, in a plain reading, with the longer explanation on hover. A flag that
 *  is false says nothing: a badge for every absent property is a wall, not an answer. */
const FLAGS = [
  ["readOnly", "read-only", "Declared as changing nothing, so it survives a read-only mode."],
  ["endsTurn", "ends turn", "Calling it finishes the turn; the loop does not iterate after it."],
  ["destructive", "destructive", "Declared as able to destroy something it cannot put back."],
  ["derived", "derived", "Declared by the package rather than reviewed; an untrusted source loses its read-only claim (packages/core/dispatcher.ts)."],
];

/** Why a named tool is missing from this turn's offer. Every reading is something the stream said. */
const WHY = {
  denied: ["denied", "Named in this conversation's deny list, so the loop never offered it."],
  "read-only": ["not read-only", "This conversation is read-only and the tool does not declare itself read-only, so it was withheld before the offer."],
  gone: ["withdrawn", "Offered earlier in this conversation and absent from the latest offer; its package no longer offers it."],
};

function note(dom, text, tone) {
  return dom.el("p", { class: `ti-note${tone ? ` is-${tone}` : ""}` }, text);
}

function json(value) {
  let text;
  try { text = JSON.stringify(value, null, 2) ?? "undefined"; }
  catch { return "[unserialisable]"; }
  return text.length > limits.chars ? `${text.slice(0, limits.chars)}\n…` : text;
}

function badge(dom, label, hint, tone) {
  return dom.el("span", { class: `ti-badge${tone ? ` is-${tone}` : ""}`, title: hint }, label);
}

function flags(dom, tool) {
  return FLAGS.filter(([key]) => tool[key] === true).map(([key, label, hint]) => badge(dom, label, hint, key === "destructive" ? "danger" : ""));
}

/** How often a tool has actually been called in this environment, when the package has been asked.
 *  Absent until the answer arrives and absent for a tool nothing has called, because a badge reading
 *  "used 0×" is noise: the list is already the set of things that have not been used. */
function used(dom, count) {
  if (!count) return null;
  return badge(dom, `used ${String(count)}×`, "Calls this environment has finished since it started, across every conversation in it.", "used");
}

/** One offered tool: what it does, who provides it, what it declares, and the arguments it takes. */
export function card(dom, tool, count) {
  return dom.el("article", { class: "ti-card" },
    dom.el("div", { class: "ti-head" },
      dom.el("h3", { class: "ti-name" }, tool.name),
      dom.el("div", { class: "ti-badges" }, [...flags(dom, tool), used(dom, count)].filter(Boolean))),
    tool.description ? dom.el("p", { class: "ti-desc" }, tool.description) : null,
    tool.data.length ? note(dom, `Reports ${tool.data.join(", ")}.`) : null,
    dom.el("details", { class: "ti-more" },
      dom.el("summary", { class: "ti-summary" }, "Arguments"),
      dom.el("pre", { class: "ti-pre" }, json(tool.schema))));
}

/** One withheld tool. Named, never hidden: naming it is a true answer to what this conversation can
 *  do, and a panel that showed only the survivors would read as though nothing had been held back. */
export function withheldCard(dom, row) {
  const [label, hint] = WHY[row.why] ?? [row.why, ""];
  return dom.el("article", { class: "ti-card is-withheld" },
    dom.el("div", { class: "ti-head" },
      dom.el("h3", { class: "ti-name" }, row.name),
      dom.el("div", { class: "ti-badges" }, badge(dom, label, hint, "withheld"))),
    row.tool?.description ? dom.el("p", { class: "ti-desc" }, row.tool.description) : null,
    row.entry !== row.name ? note(dom, `Denied as ${row.entry}.`) : null);
}

/** What the mode is doing, said once at the top rather than left to be inferred from the list.
 *
 * The second line is the honest limit of this panel: an offer carries only the tools that survived
 * the mode (packages/core/dispatcher.ts filters before emitting), so a tool this conversation has
 * never been offered cannot be named here at all. */
function banner(dom, described) {
  const mode = described.mode;
  const rows = [note(dom, mode.readOnly
    ? "This conversation is read-only: a tool that does not declare itself read-only is withheld before the model sees it."
    : "This conversation can call tools that change things.")];
  if (mode.deny.length) {
    const shown = mode.deny.slice(0, limits.denied);
    const rest = mode.deny.length - shown.length;
    rows.push(note(dom, `Denied by name: ${shown.join(", ")}${rest > 0 ? `, and ${String(rest)} more` : ""}.`));
  }
  if (mode.readOnly) rows.push(note(dom, "Only tools this conversation has been offered at some point can be named below; one withheld from its first turn leaves no trace on this wire.", "dim"));
  return dom.el("div", { class: "ti-banner" }, rows);
}

export function subtitle(described) {
  if (!described.known) return undefined;
  const counts = described.counts;
  const parts = [`${String(counts.offered)} offered from ${String(counts.sources)} package${counts.sources === 1 ? "" : "s"}`];
  if (counts.withheld) parts.push(`${String(counts.withheld)} withheld`);
  parts.push(described.mode.readOnly ? "read-only" : "read-write");
  return parts.join(" · ");
}

/** Which source groups the person left open, so a redraw mid-turn does not fold them shut. */
export function blocks(described, dom, open, usage = {}) {
  if (!described.known) return [dom.el("div", { class: "panel-note" }, "No offer seen yet — send a message to see what this conversation can call.")];
  const rows = [banner(dom, described)];
  for (const group of described.sources) {
    rows.push(dom.collapsibleSection({
      title: group.source, mono: true, count: group.tools.length, open: open.has(group.source),
      note: `Offered by ${group.source}.`,
      onToggle: (isOpen) => { if (isOpen) open.add(group.source); else open.delete(group.source); },
    }, group.tools.map(tool => card(dom, tool, usage[tool.name]))));
  }
  if (described.withheld.length) {
    rows.push(dom.section({ title: "withheld", count: described.withheld.length, note: "Named rather than hidden: a withheld tool is still part of the answer to what this conversation can do." }));
    rows.push(...described.withheld.map(row => withheldCard(dom, row)));
  }
  if (!described.counts.offered) rows.push(dom.el("div", { class: "panel-note" }, "No tools are offered in this mode."));
  return rows;
}
