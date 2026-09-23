import { contentText } from "@thetis/runtime/lib/content";
// The routing decision, made once per conversation, and the prompt section that tells the model about it.
// Three signals are unioned, not ranked, because they fail in different places: the always-on core, the
// skill edges (a pinned or universal skill tagged `tool-group:<id>`), and the tag match on the first message.
// When those admit nothing beyond the core and vectors are available, the dense ranking admits the top few.
// Every admission records why, so a panel can explain an attached group rather than present it as a fact.
import { fuse, loadSkills, STATE as SKILLS_STATE } from "@thetis/skills";
import { lexicalRank, orderIds, routable, SKILL_TAG_PREFIX } from "./groups.js";

export const REASON = Object.freeze({ alwaysOn: "always-on", configured: "configured", skill: "skill", tag: "tag", dense: "dense", fusion: "fusion", search: "search", call: "call" });

/**
 * `denseThreshold` measured on tool-recall@1 (21 groups, 75 tasks, text-embedding-3-small): the gold groups' cosine against
 * their query has median 0.337 and 10th percentile 0.20; the controls' best group never exceeds 0.253. At 0.25, 80% of the
 * gold groups pass and 5 of the 6 controls get nothing; at 0.3 it is 58% and all 6. A group wrongly withheld costs a
 * capability and one admitted needlessly costs tokens, so the floor sits low.
 */
const DEFAULTS = Object.freeze({ routeThreshold: 0.15, denseFallback: 2, denseMode: "fallback", denseThreshold: 0.25, fusionWeight: 0.7, listAlwaysOn: false });
const MODES = new Set(["off", "fallback", "fusion"]);

/** The package's configuration with the defaults filled in and the types checked. */
export function configOf(config = {}) {
  const num = (v, d, min = 0) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    routeThreshold: num(config.routeThreshold, DEFAULTS.routeThreshold),
    denseFallback: Math.floor(num(config.denseFallback, DEFAULTS.denseFallback)),
    denseMode: MODES.has(config.denseMode) ? config.denseMode : DEFAULTS.denseMode,
    denseThreshold: Number.isFinite(Number(config.denseThreshold)) ? Number(config.denseThreshold) : DEFAULTS.denseThreshold,
    fusionWeight: Math.min(1, num(config.fusionWeight, DEFAULTS.fusionWeight)),
    alwaysOn: Array.isArray(config.alwaysOn) ? config.alwaysOn.filter((id) => typeof id === "string") : [],
    listAlwaysOn: config.listAlwaysOn === true,
  };
}

/** The first user message of the conversation, as the router sees it. */
export function queryOf(conversation, clean = (s) => s) {
  const first = (conversation ?? []).find((m) => m?.role === "user");
  const content = contentText(first?.content);
  return clean(content);
}

/**
 * The group ids the pinned and universal skills point at through `tool-group:<id>` tags. Reads the skills
 * loader's state under `harness["@thetis/skills"]` and tolerates its absence: no loader, no edges.
 */
export function skillEdges(env, packages, harness, known) {
  const state = harness?.[SKILLS_STATE];
  if (!state || typeof state !== "object") return { ids: [], notes: [] };
  const wanted = new Set([...(Array.isArray(state.universal) ? state.universal : []), ...(Array.isArray(state.pinned) ? state.pinned.map((p) => p?.id) : [])].filter((id) => typeof id === "string"));
  if (!wanted.size) return { ids: [], notes: [] };
  const ids = [];
  const notes = [];
  let skills = [];
  try {
    skills = loadSkills(env, packages);
  } catch {
    return { ids: [], notes: [] };
  }
  for (const s of skills) {
    if (!wanted.has(s.id)) continue;
    for (const tag of s.tags ?? []) {
      if (!tag.startsWith(SKILL_TAG_PREFIX)) continue;
      const id = tag.slice(SKILL_TAG_PREFIX.length);
      if (!known.has(id)) notes.push(`skill ${s.id} points at unknown tool group ${id}`);
      else if (!ids.includes(id)) ids.push(id);
    }
  }
  return { ids, notes };
}

/**
 * Decides the active set for a conversation: `{ active, why, mode, notes, ranked }`. `dense` is an async
 * `(groups) => { hits, note }` over the routable groups, called only when the mode asks for it. Pure apart
 * from that call, so the tests drive it with a fake.
 */
export async function routeOnce({ groups, query, skillIds = [], config = {}, dense = null }) {
  const cfg = configOf(config);
  const why = {};
  const notes = [];
  const admit = (id, reason) => {
    if (!(id in why)) why[id] = reason;
  };
  for (const g of groups) if (g.alwaysOn) admit(g.id, g.configured ? REASON.configured : REASON.alwaysOn);
  for (const id of skillIds) if (groups.some((g) => g.id === id)) admit(id, REASON.skill);

  const candidates = routable(groups);
  const lexical = lexicalRank(candidates, query);
  for (const h of lexical) if (h.score >= cfg.routeThreshold && h.score > 0) admit(h.id, REASON.tag);

  let mode = "lexical";
  const ranked = lexical.filter((h) => h.score > 0);
  const routedByEvidence = candidates.some((g) => g.id in why);
  const wantDense = cfg.denseFallback > 0 && candidates.length && query.trim() && (cfg.denseMode === "fusion" || (cfg.denseMode === "fallback" && !routedByEvidence));
  if (wantDense) {
    // No ranker at all (no key, no bench file) is the caller's to explain; a ranker that could not answer says why.
    const got = dense ? await dense(candidates) : null;
    if (got?.hits) {
      mode = cfg.denseMode;
      if (got.note) notes.push(got.note);
      // A cosine below the floor is not evidence: a greeting is closest to some group too.
      const near = new Set(got.hits.filter((h) => cfg.denseThreshold <= 0 || h.score >= cfg.denseThreshold).map((h) => h.id));
      if (cfg.denseMode === "fusion") {
        const matched = new Set(lexical.filter((h) => h.score > 0).map((h) => h.id));
        const fused = fuse(got.hits, lexical.filter((h) => h.score > 0), cfg.fusionWeight);
        for (const h of fused.slice(0, cfg.denseFallback)) if (near.has(h.id) || matched.has(h.id)) admit(h.id, REASON.fusion);
        ranked.splice(0, ranked.length, ...fused);
      } else {
        for (const h of got.hits.filter((h) => near.has(h.id)).slice(0, cfg.denseFallback)) admit(h.id, REASON.dense);
        ranked.splice(0, ranked.length, ...got.hits);
      }
      if (got.hits.length && !near.size) notes.push(`no group is within the dense threshold (${cfg.denseThreshold}); nothing is routed beyond the core`);
    } else if (got?.note) notes.push(got.note);
  } else if (cfg.denseMode === "off" && !routedByEvidence && candidates.length) notes.push("the tags admitted no group and the dense fallback is off");

  return { active: orderIds(groups, Object.keys(why)), why, mode, notes, ranked: ranked.map((h) => ({ id: h.id, score: h.score })) };
}

/** The tool names the session's project switched off, read the way @thetis/projects reads them. Empty without a project. */
export async function projectDisabled(env, sessionId) {
  try {
    const sessions = JSON.parse(await env.readFile("projects/sessions.json"));
    const id = sessions?.[sessionId];
    if (typeof id !== "string") return new Set();
    const project = JSON.parse(await env.readFile(`projects/${id}.json`));
    return new Set(Array.isArray(project?.tools?.disable) ? project.tools.disable.filter((n) => typeof n === "string") : []);
  } catch {
    return new Set();
  }
}

/** Groups admitted by a call to one of their tools: a tool message in the conversation whose group is routable and not active. */
export function strayCalls(conversation, byTool, groups, active) {
  const on = new Set(active);
  const routableIds = new Set(routable(groups).map((g) => g.id));
  const out = [];
  for (const m of conversation ?? []) {
    if (m?.role !== "tool" || typeof m.name !== "string") continue;
    const id = byTool.get(m.name);
    if (id && routableIds.has(id) && !on.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export const HEADING = "# Tool groups";
export const INTRO = "Your tool list is scoped to what this conversation looks like it needs, so a tool you have may not be in it right now. Call tool_search the moment you suspect a tool exists but cannot see it; do not work around the gap. Nothing is ever unloaded.";

/** One line per group with its mark. */
export const catalogueLines = (groups, active) => {
  const on = new Set(active);
  return groups.map((g) => `- \`${g.id}\` [${on.has(g.id) ? "loaded" : "available"}] — ${g.brief}`);
};

/**
 * The prompt section: the intro, then one line per routable group (always-on groups too when configured).
 * Empty when nothing is routable, because then nothing is scoped and the text would be a lie.
 */
export function section(groups, active, config = {}) {
  const listed = configOf(config).listAlwaysOn ? groups : routable(groups);
  if (!routable(groups).length) return "";
  return `${HEADING}\n${INTRO}\n\n${catalogueLines(listed, active).join("\n")}`;
}
