// The group table, derived from the installed packages, and the lexical routing over it. Every tool belongs
// to exactly one group. A package that declares tools is one group by default; a manifest can name the group
// (`thetis.toolGroup`) and a tool can sit in another (`group` on the tool). A group whose tools all come from
// packages everyone has is core and always on: the core is what the guide teaches, and a tool it names must
// never be missing. The routing is the predecessor's: lowercase alphanumeric runs, a score of m/(m+1) over the
// distinct tags present, adjacency for a multi-word tag, no stemming.
import { firstSentence } from "@thetis/skills";

export const SELF = "@thetis/tool-groups";
/** The harness key the pin lives under. */
export const STATE = SELF;
export const SEARCH_TOOL = "tool_search";
/** The tag prefix a skill uses to point at a tool group. */
export const SKILL_TAG_PREFIX = "tool-group:";

/** `packages` may be a PackageQuery (`ctx.packages`), an array of PackageInfo (`env.kernel.packages.list()`), or nothing. */
export function packageList(packages) {
  if (!packages) return [];
  if (Array.isArray(packages)) return packages;
  if (typeof packages.list === "function") return packages.list();
  return [];
}

const unscoped = (name) => String(name).replace(/^@[^/]+\//, "");
const scoped = (name) => String(name).replace(/^@/, "");
const asId = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
const asTags = (v) => (Array.isArray(v) ? [...new Set(v.filter((t) => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean))] : []);

/**
 * The groups of these packages, in install order, and the tool name to group id map. `config.alwaysOn` names
 * ids that are on for every conversation whatever the packages say.
 */
export function deriveGroups(packages, config = {}) {
  const list = packageList(packages).filter((p) => p && typeof p.name === "string" && Array.isArray(p.thetis?.tools) && p.thetis.tools.length);
  const configured = new Set(asTags(config.alwaysOn));
  // Two packages with the same unscoped name keep their scope, so neither hides the other.
  const counts = new Map();
  for (const p of list) counts.set(unscoped(p.name), (counts.get(unscoped(p.name)) ?? 0) + 1);

  const groups = [];
  const byId = new Map();
  const byTool = new Map();
  const ensure = (id, seed) => {
    let g = byId.get(id);
    if (!g) {
      g = { id, brief: "", tags: [], alwaysOn: false, tools: [], packages: [], declared: false, everyone: true };
      byId.set(id, g);
      groups.push(g);
    }
    if (seed) {
      if (!g.declared && seed.declared) g.declared = true;
      if (seed.brief && (!g.brief || seed.declared)) g.brief = seed.brief;
      if (seed.tags?.length && (seed.declared || !g.tags.length)) g.tags = [...new Set([...g.tags, ...seed.tags])];
      if (seed.alwaysOn) g.alwaysOn = true;
    }
    return g;
  };

  for (const p of list) {
    const decl = p.thetis.toolGroup && typeof p.thetis.toolGroup === "object" ? p.thetis.toolGroup : null;
    const own = asId(decl?.id) || ((counts.get(unscoped(p.name)) ?? 0) > 1 ? scoped(p.name) : unscoped(p.name));
    const seed = {
      declared: !!decl,
      brief: asId(decl?.brief) || firstSentence(p.description ?? ""),
      tags: asTags(decl?.tags),
      alwaysOn: decl?.alwaysOn === true || p.name === SELF,
    };
    ensure(own, seed).packages.push(p.name);
    for (const t of p.thetis.tools) {
      if (!t || typeof t.name !== "string") continue;
      // The first package with a name wins, as attachTools does.
      if (byTool.has(t.name)) continue;
      const id = asId(t.group) || own;
      const g = id === own ? ensure(own) : ensure(id, { declared: false, brief: firstSentence(t.description ?? ""), tags: [], alwaysOn: false });
      if (id !== own && !g.packages.includes(p.name)) g.packages.push(p.name);
      g.tools.push({ name: t.name, description: String(t.description ?? ""), package: p.name });
      if (p.everyone !== true) g.everyone = false;
      byTool.set(t.name, id);
    }
  }
  for (const g of groups) {
    if (!g.tools.length) g.everyone = false;
    // Always on by what the packages are: declared so, installed for everyone, or holding the escape hatch.
    const byPackages = g.alwaysOn || g.everyone || g.tools.some((t) => t.name === SEARCH_TOOL);
    g.alwaysOn = byPackages || configured.has(g.id);
    // `configured` says the configuration alone made it so; the routing reports that as its reason.
    g.configured = !byPackages && configured.has(g.id);
    delete g.everyone;
  }
  return { groups, byTool };
}

/** The groups the routing decides about: everything that is not always on. */
export const routable = (groups) => groups.filter((g) => !g.alwaysOn);

/** Ids in table order, unknown ids dropped. What keeps the tool list byte-stable whatever order evidence arrived in. */
export const orderIds = (groups, ids) => {
  const wanted = new Set(ids);
  return groups.filter((g) => wanted.has(g.id)).map((g) => g.id);
};

/** The catalogue as the pin keeps it. */
export const catalogueOf = (groups) => groups.map((g) => ({ id: g.id, brief: g.brief, tools: g.tools.map((t) => t.name), alwaysOn: g.alwaysOn }));

// --- routing ------------------------------------------------------------------------------------------------

/** Lowercase alphanumeric runs. No stemming: "spawning" is not "spawn". */
export const tokens = (text) =>
  String(text ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => t.toLowerCase());

/** Whether one tag occurs in the tokenised query; a multi-word tag must appear as consecutive tokens. */
export function tagPresent(tag, queryTokens) {
  const parts = tokens(tag);
  if (!parts.length) return false;
  if (parts.length === 1) return queryTokens.includes(parts[0]);
  for (let i = 0; i + parts.length <= queryTokens.length; i++) {
    if (parts.every((p, j) => queryTokens[i + j] === p)) return true;
  }
  return false;
}

/** m/(m+1) over the distinct tags present: one match is 0.5, more add less, never 1. Zero without tags. */
export function score(group, queryTokens) {
  const tags = group.tags ?? [];
  if (!tags.length) return 0;
  const m = tags.filter((t) => tagPresent(t, queryTokens)).length;
  return m / (m + 1);
}

/** Every group scored against a query, best first, ties by id. The threshold is the caller's business. */
export function lexicalRank(groups, query) {
  const q = tokens(query);
  return groups.map((g) => ({ id: g.id, score: score(g, q) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
