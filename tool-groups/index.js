// Tool groups: the tool list scoped to what a conversation looks like it needs. `route` (prompt phase)
// decides once, on the first user message, and pins the decision in the harness; on every later turn it reads
// the pin back, merges what tool_search loaded and what a stray call admitted, and never routes again.
// `scope` (call phase, after every tools-phase step) drops the tools of groups that are not active. A call to
// a dropped tool is still honoured by the kernel, because scoping is an attention and token optimisation,
// never a permission boundary; the group is loaded from the next turn.
// The query is the first user message without the harness's [Turn context: ...] line, as @thetis/runtime/contracts
// defines it; `queryTextOf` applies that rule and the predecessor's 2000-character clip.
import { fuse, packagesOf, firstSentence, queryTextOf as withoutTurnContext } from "@thetis/skills";
import { deriveGroups, catalogueOf, lexicalRank, orderIds, routable, SEARCH_TOOL, SELF, STATE } from "./lib/groups.js";
import { configOf, queryOf, routeOnce, REASON, section, skillEdges, strayCalls, projectDisabled, catalogueLines } from "./lib/route.js";
import { denseRank, denseAvailable, seedVectors, VECTORS_DIR } from "./lib/dense.js";
import { readDoc, writeDoc, addLoaded } from "./lib/store.js";
import { importCorpus as importBench, benchReport as reportBench } from "./lib/bench.js";

export { SELF, STATE, SEARCH_TOOL };

const pinOf = (harness) => (harness?.[STATE] && typeof harness[STATE] === "object" && Array.isArray(harness[STATE].active) ? harness[STATE] : null);

/** The routing's dense ranker over the routable groups, bound to this turn's env and configuration. */
const denseFor = (env, query, config, deps) => async (groups) => denseRank(env, groups, query, config, deps);

/**
 * prompt: route once, then pin; on later turns, read the pin back and grow it. Appends the `# Tool groups`
 * section, byte-stable across turns except when the active set or the catalogue grows.
 */
export async function route(ctx, deps = {}) {
  const config = ctx.config ?? {};
  const { groups, byTool } = deriveGroups(ctx.packages, config);
  const known = new Set(groups.map((g) => g.id));
  const prev = pinOf(ctx.harness);
  const doc = await readDoc(ctx.env, ctx.session?.id);
  const notes = [];
  let active;
  let why;
  let mode;
  let ranked;

  if (prev) {
    // Reused, never re-routed: the prefix stays where the first turn put it.
    why = { ...(prev.why && typeof prev.why === "object" ? prev.why : {}) };
    for (const id of prev.active) if (!known.has(id)) notes.push(`tool group ${id} is no longer installed; dropped from the pin`);
    active = prev.active.filter((id) => known.has(id));
    for (const id of active) if (!(id in why)) why[id] = REASON.alwaysOn;
    mode = prev.mode ?? "pinned";
    ranked = Array.isArray(prev.ranked) ? prev.ranked : [];
  } else {
    const query = queryOf(ctx.conversation, withoutTurnContext);
    const edges = skillEdges(ctx.env, ctx.packages, ctx.harness, known);
    notes.push(...edges.notes);
    const dense = (await denseAvailable(ctx.env, config, deps.vectorsDir)) ? denseFor(ctx.env, query, config, deps) : null;
    const routed = await routeOnce({ groups, query, skillIds: edges.ids, config, dense });
    if (!dense && configOf(config).denseMode !== "off" && !routed.active.some((id) => routable(groups).some((g) => g.id === id))) {
      notes.push("no embeddings key: the dense fallback is skipped, routing is lexical");
    }
    active = routed.active;
    why = routed.why;
    mode = routed.mode;
    ranked = routed.ranked;
    notes.push(...routed.notes);
  }

  // Always-on groups are forced back in whatever the pin says: tool_search must never be losable.
  for (const g of groups) if (g.alwaysOn && !active.includes(g.id)) (active.push(g.id), (why[g.id] = g.configured ? REASON.configured : REASON.alwaysOn));
  // What tool_search loaded since the pin, then what a call to a withheld tool admitted.
  for (const [id, reason] of Object.entries(doc.loaded)) if (known.has(id) && !active.includes(id)) (active.push(id), (why[id] = reason || REASON.search));
  for (const id of strayCalls(ctx.conversation, byTool, groups, active)) (active.push(id), (why[id] = REASON.call));
  active = orderIds(groups, active);
  for (const id of Object.keys(why)) if (!active.includes(id)) delete why[id];

  const state = { active, why, catalogue: catalogueOf(groups), mode, ranked, notes };
  const harness = { ...ctx.harness, [STATE]: state };
  if (doc.active.join("\n") !== active.join("\n")) await writeDoc(ctx.env, ctx.session?.id, { ...doc, active });

  const text = section(groups, active, config);
  if (!text) return { harness };
  return { call: { ...ctx.call, system: [ctx.call.system, text].filter(Boolean).join("\n\n") }, harness };
}

/**
 * call: keep the tools of the active groups, in the order attachTools produced, and never drop tool_search.
 * The names dropped go to `call.hints.withheld`, which the built-in call reads to honour a call to one of
 * them; a tool the session's project switched off is not in that list, so it stays refused.
 */
export async function scope(ctx) {
  const pin = pinOf(ctx.harness);
  if (!pin) return;
  const { groups, byTool } = deriveGroups(ctx.packages, ctx.config ?? {});
  if (!routable(groups).length) return;
  const on = new Set(pin.active);
  const disabled = await projectDisabled(ctx.env, ctx.session?.id);
  const tools = [];
  const withheld = [];
  for (const t of ctx.call.tools ?? []) {
    const id = byTool.get(t.name);
    if (t.name === SEARCH_TOOL || !id || on.has(id)) tools.push(t);
    else if (!disabled.has(t.name)) withheld.push(t.name);
  }
  if (!withheld.length && tools.length === (ctx.call.tools ?? []).length) return;
  const hints = { ...(ctx.call.hints ?? {}) };
  if (withheld.length) hints.withheld = withheld;
  else delete hints.withheld;
  return { call: { ...ctx.call, tools, ...(Object.keys(hints).length ? { hints } : {}) } };
}

const toolLines = (group) => group.tools.map((t) => `  - ${t.name}: ${firstSentence(t.description)}`);

/**
 * `tool_search({ query, load })`: with neither, the catalogue; with a query, every group whose tags match
 * plus the best-ranked one when none does; with `load`, those ids. What it loads is written to storage and
 * merged into the pin on the next turn. A call to a loaded tool by name works at once: the kernel resolves
 * it against the installed packages.
 */
export async function toolSearch(args, env, deps = {}) {
  const config = env.config ?? {};
  const { groups } = deriveGroups(await packagesOf(env), config);
  const candidates = routable(groups);
  const sessionId = env.session?.id;
  const doc = await readDoc(env, sessionId);
  const activeIn = (d) => orderIds(groups, [...groups.filter((g) => g.alwaysOn).map((g) => g.id), ...d.active, ...Object.keys(d.loaded)]);
  const catalogue = () => catalogueLines(candidates, activeIn(doc)).join("\n");
  if (!candidates.length) return "Every tool is in your list already: no group is scoped in this workspace.";

  const query = typeof args?.query === "string" ? withoutTurnContext(args.query).trim() : "";
  const explicit = Array.isArray(args?.load) ? args.load.filter((id) => typeof id === "string").map((id) => id.trim()).filter(Boolean) : [];
  const notes = [];
  let wanted = [];
  if (explicit.length) {
    const unknown = explicit.filter((id) => !groups.some((g) => g.id === id));
    if (unknown.length) throw new Error(`unknown tool group${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. The groups are:\n${catalogue()}`);
    wanted = explicit;
  } else if (query) {
    const lexical = lexicalRank(candidates, query);
    let order = lexical;
    if (await denseAvailable(env, config, deps.vectorsDir)) {
      const dense = await denseRank(env, candidates, query, config, deps);
      if (dense.hits) order = fuse(dense.hits, lexical.filter((h) => h.score > 0), configOf(config).fusionWeight);
      else if (dense.note) notes.push(dense.note);
    } else notes.push("no embeddings key: the ranking is lexical");
    wanted = lexical.filter((h) => h.score > 0).map((h) => h.id);
    if (!wanted.length && order.length) wanted = [order[0].id];
  } else {
    return `Tool groups:\n\n${catalogue()}\n\nCall this again with a query or load to add one.`;
  }

  const { added, doc: after } = await addLoaded(env, sessionId, wanted, REASON.search);
  const loadedNow = activeIn(after);
  if (!added.length) return `Nothing to add: ${wanted.map((id) => `\`${id}\``).join(", ")} ${wanted.length > 1 ? "are" : "is"} already loaded.\n\n${catalogueLines(candidates, loadedNow).join("\n")}`;
  const lines = [`Loaded ${added.map((id) => `\`${id}\``).join(", ")} for the rest of this conversation.`, ""];
  for (const id of added) {
    const g = groups.find((x) => x.id === id);
    lines.push(`\`${g.id}\`: ${g.brief}`, ...toolLines(g));
  }
  lines.push("", "These tools are in your list from the next turn; a call to one of them by name works now.", "", catalogueLines(candidates, loadedNow).join("\n"));
  if (notes.length) lines.push("", ...notes.map((n) => `Note: ${n}`));
  return lines.join("\n");
}

/** bench: the corpus's vectors from `bench/vectors/<corpus sha256>.json` into the cache under the home. */
export async function importCorpus(ctx) {
  return importBench(ctx, { deriveGroups, seedVectors, VECTORS_DIR });
}

/** bench: the active groups are in hand, every other group is a named entry away. */
export async function benchReport(ctx) {
  return reportBench(ctx, pinOf(ctx.harness));
}
