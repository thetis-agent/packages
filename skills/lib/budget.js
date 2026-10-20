// The always-on budget: what skills put in every prompt of every conversation, before anything is retrieved
// or loaded. That is the catalogue (a header and one brief per top-level skill) and the bodies of the
// universal skills. Every installed pack and every skill the agent writes under the home adds to it, so it
// grows without anyone deciding it should; the budget is where that growth stops and says so. Characters,
// not bytes or tokens: it is what a person can count in the text, and the loaders that use it render plain
// strings.
import { brief } from "./skill.js";

/**
 * 64,000 characters. Production on 2026-10-19 put 1,558 characters in every prompt (a header and 9 briefs, no
 * universal skill), so nothing there is dropped; the bench corpus caps@1 (287 top-level skills) needs about
 * 46,500, so skill-recall@1 keeps its numbers. Eight universal bodies at the 64 KiB body limit would be 512 KiB:
 * that is the growth this stops.
 */
export const DEFAULT_ALWAYS_ON = 64000;

/** `config.alwaysOnBudget` as a whole positive number of characters, else the default. */
export function alwaysOnBudgetOf(config) {
  const v = Math.floor(Number(config?.alwaysOnBudget));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ALWAYS_ON;
}

const universalItem = (s) => `## ${s.id}\n${s.body.trimEnd()}\n`;

/** The universal section, as every loader renders it. */
export const universalSection = (heading, skills) => `${heading}\n\n${skills.map(universalItem).join("\n")}`;

/**
 * Fits the always-on text to `budget` characters. `catalogue` is the skills that get a brief, in the order they
 * are shown; `universal` the skills whose bodies go in, by id. Over budget, universal bodies go first, from the
 * last id back, then briefs from the end of the catalogue; the headers go with the last of their entries. A
 * universal skill whose body is dropped is ordinary from then on: its brief stays, and it can be loaded,
 * retrieved or fetched like any other.
 *
 * Returns `{ catalogue, universal, blocks, used, total, budget, dropped: [{ id, part: "body" | "brief" }] }`:
 * the kept lists, the blocks to put in the prompt in order, the characters they take joined by a blank line,
 * the characters everything would have taken, and every drop in the order it was made. Lengths come from
 * prefix sums, not a render per drop, so a large catalogue costs one pass.
 */
export function fitAlwaysOn({ header, heading, catalogue, universal, budget }) {
  const briefs = catalogue.map((s) => brief(s));
  const items = universal.map(universalItem);
  const sumBriefs = prefixSums(briefs);
  const sumItems = prefixSums(items);
  // The length of the blocks with the first `b` briefs and `i` bodies, joined the way the loaders join them.
  const sizeOf = (b, i) => {
    const parts = [];
    if (b) parts.push(header.length + 2 + sumBriefs[b] + b - 1);
    if (i) parts.push(heading.length + 2 + sumItems[i] + i - 1);
    return parts.reduce((n, p) => n + p, 0) + Math.max(0, parts.length - 1) * 2;
  };
  let nItems = items.length;
  let nBriefs = briefs.length;
  const total = sizeOf(nBriefs, nItems);
  let used = total;
  const dropped = [];
  while (used > budget && nItems) {
    nItems--;
    dropped.push({ id: universal[nItems].id, part: "body" });
    used = sizeOf(nBriefs, nItems);
  }
  while (used > budget && nBriefs) {
    nBriefs--;
    dropped.push({ id: catalogue[nBriefs].id, part: "brief" });
    used = sizeOf(nBriefs, nItems);
  }
  const blocks = [];
  if (nBriefs) blocks.push(`${header}\n\n${briefs.slice(0, nBriefs).join("\n")}`);
  if (nItems) blocks.push(`${heading}\n\n${items.slice(0, nItems).join("\n")}`);
  return { catalogue: catalogue.slice(0, nBriefs), universal: universal.slice(0, nItems), blocks, used, total, budget, dropped };
}

function prefixSums(list) {
  const out = [0];
  for (const s of list) out.push(out[out.length - 1] + s.length);
  return out;
}

/**
 * The loader note naming every drop, or null when nothing was dropped. A drop's `part` is `body` (a universal
 * body), `brief` (a catalogue line) or `skill` (the whole skill, for a loader that has no other level).
 */
export function budgetNote(fit, unit = "characters") {
  if (!fit.dropped.length) return null;
  const of = (part) => fit.dropped.filter((d) => d.part === part).map((d) => d.id);
  const [bodies, briefs, whole] = [of("body"), of("brief"), of("skill")];
  const parts = [];
  if (bodies.length) parts.push(`the universal body of ${bodies.join(", ")} (now loaded on request)`);
  if (briefs.length) parts.push(`the brief of ${briefs.join(", ")}`);
  if (whole.length) parts.push(whole.join(", "));
  return `over the always-on budget (${fit.total} of ${fit.budget} ${unit}): left out ${parts.join("; ")}`;
}
