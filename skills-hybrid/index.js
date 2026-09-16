// Briefs always, a few cards retrieved for the conversation, the rest behind search and fetch. The retrieval
// runs once, on the first user message, and the result is pinned in the harness by id and content hash, so
// the prompt prefix does not move on later turns; a pack update mid-conversation re-renders a pinned card
// from the new text but keeps its place.
import { selectSkills, brief, card, renderBody, packagesOf, loadSkills, STATE, importCorpus as importShared, claim, readMap, corpusIds } from "@thetis/skills";
import { embeddingConfig, keyOf, queryTextOf, readCache, writeCache } from "./lib/embed.js";
import { benchVectorsFor, VECTORS_DIR } from "./lib/vectors.js";
import { retrieve } from "./lib/retrieve.js";
import { DEFAULT_PIN, RANKED } from "./lib/rank.js";

export const SELF = "@thetis/skills-hybrid";

const SHORTS = "# Skills\nOne line per skill: a pointer, not the content. skill_search finds a skill by what you are trying to do; skill_fetch reads one in full. Fetch before relying on a skill.";
const RETRIEVED = "# Skills retrieved for this conversation\nThese matched the first message. A card is a pointer, not the content: call skill_fetch with the id before relying on a skill.";

const section = (heading, skills) => `${heading}\n\n${skills.map((s) => `## ${s.id}\n${s.body.trimEnd()}\n`).join("\n")}`;

/** The first user message of the conversation, as the ranker sees it. */
export function queryOf(ctx) {
  const first = (ctx.conversation ?? []).find((m) => m?.role === "user");
  const content = typeof first?.content === "string" ? first.content : Array.isArray(first?.content) ? first.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : "";
  return queryTextOf(content);
}

const pinLimitOf = (config) => (Number.isInteger(Number(config?.pinLimit)) && Number(config.pinLimit) >= 0 ? Number(config.pinLimit) : DEFAULT_PIN);

/**
 * The corpus's vectors from `bench/vectors/<sha>.json` into the cache under the home, so the first turn ranks
 * densely without a key. Idempotent: nothing is written when every vector is already there.
 */
export async function seedVectors(ctx, dir = VECTORS_DIR) {
  const map = readMap(ctx.env);
  const file = map ? benchVectorsFor(map.sha256, dir) : null;
  if (!file) return 0;
  const live = new Set(loadSkills(ctx.env, ctx.packages).map((s) => s.contentHash));
  const cache = await readCache(ctx.env);
  let added = 0;
  for (const [hash, vector] of Object.entries(file.skills)) {
    if (!live.has(hash) || !Array.isArray(vector)) continue;
    const key = keyOf(file.model, file.dimensions, hash);
    if (cache[key]) continue;
    cache[key] = vector;
    added++;
  }
  if (added) await writeCache(ctx.env, cache, live);
  return added;
}

/** bench: the shared importer, then the corpus's vectors into the cache. */
export async function importCorpus(ctx) {
  const out = await importShared(ctx, SELF);
  await seedVectors(ctx);
  return out;
}

/** prompt: the shorts, the universal bodies, and the cards (or bodies) pinned for this conversation. */
export async function pin(ctx) {
  const config = ctx.config ?? {};
  const { skills, universal, excluded, notes } = await selectSkills(ctx.env, ctx.packages, ctx.session);
  const prev = ctx.harness?.[STATE] && typeof ctx.harness[STATE] === "object" ? ctx.harness[STATE] : null;
  if (prev?.loader && prev.loader !== SELF) notes.push(`another skills loader is installed: ${prev.loader}; both run until one is removed`);
  const top = skills.filter((s) => !s.id.includes("/"));
  const universalIds = new Set(universal.map((s) => s.id));
  const byId = new Map(skills.map((s) => [s.id, s]));
  const pinBodies = config.pinBodies === true;
  const pinLimit = pinLimitOf(config);

  let pinned;
  let ranked;
  let mode;
  if (prev?.loader === SELF && Array.isArray(prev.pinned)) {
    // Reused, never re-ranked: the prefix stays where the first turn put it.
    pinned = [];
    for (const p of prev.pinned) {
      const s = p && typeof p.id === "string" ? byId.get(p.id) : undefined;
      if (!s || universalIds.has(s.id)) {
        notes.push(`pinned skill ${p?.id} is no longer available; dropped from the pin`);
        continue;
      }
      if (s.contentHash !== p.contentHash) notes.push(`pinned skill ${s.id} changed since it was pinned; shown from its new text`);
      pinned.push({ id: s.id, contentHash: s.contentHash, score: p.score, how: p.how });
    }
    ranked = Array.isArray(prev.ranked) ? prev.ranked.filter((r) => r && byId.has(r.id)) : [];
    mode = prev.mode ?? "pinned";
  } else {
    const query = queryOf(ctx);
    const result = query.trim() && skills.length ? await retrieve(ctx.env, skills, query, config, { limit: RANKED, universal: universalIds }) : { hits: [], mode: "lexical", note: null };
    if (result.note) notes.push(result.note);
    ranked = result.hits.map((h) => ({ id: h.id, score: h.score, how: h.how }));
    pinned = ranked.slice(0, pinLimit).map((h) => ({ id: h.id, contentHash: byId.get(h.id).contentHash, score: h.score, how: h.how }));
    mode = result.mode;
  }

  const state = {
    loader: SELF,
    universal: [...universalIds],
    pinned,
    loaded: [],
    catalogue: top.map((s) => s.id),
    dropped: [],
    excluded,
    ranked,
    mode,
    pinBodies,
    notes,
  };
  const harness = { ...ctx.harness, [STATE]: state };
  if (!skills.length) return { harness };

  const blocks = [];
  if (top.length) blocks.push(`${SHORTS}\n\n${top.map(brief).join("\n")}`);
  if (universal.length) blocks.push(section("# Skills always in force", universal));
  const pinnedSkills = pinned.map((p) => byId.get(p.id)).filter(Boolean);
  if (pinnedSkills.length) {
    blocks.push(pinBodies ? section(RETRIEVED, pinnedSkills) : `${RETRIEVED}\n\n${pinnedSkills.map((s) => card(s)).join("\n\n")}`);
  }
  const system = [ctx.call.system, ...blocks].filter(Boolean).join("\n\n");
  return { call: { ...ctx.call, system }, harness };
}

/** `skill_search({ query, k })`: the same ranking as the pin, for one query, without pinning anything. */
export async function skillSearch(args, env) {
  const query = queryTextOf(args?.query);
  if (!query.trim()) throw new Error("query is required: say what you are trying to do, in a sentence");
  const k = Math.min(20, Math.max(1, Math.floor(Number(args?.k)) || 5));
  const { skills, universal } = await selectSkills(env, await packagesOf(env), env.session);
  if (!skills.length) return "no skills are installed";
  const universalIds = new Set(universal.map((s) => s.id));
  const { hits, note } = await retrieve(env, skills, query, env.config ?? {}, { limit: k, universal: universalIds });
  const byId = new Map(skills.map((s) => [s.id, s]));
  const lines = hits.map((h) => `${brief(byId.get(h.id))} [${h.how}, ${h.score}]`);
  if (!lines.length) return `no skill matched; the universal skills in your prompt are ${[...universalIds].map((id) => `\`${id}\``).join(", ") || "none"}`;
  return [...lines, "", "Each line is a pointer. skill_fetch with the id reads the skill before you rely on it.", ...(note ? [`Note: ${note}`] : [])].join("\n");
}

/** bench: universals (and the pinned bodies) are in hand; every other corpus id is a search away; the top 10 is the ranking. */
export async function benchReport(ctx) {
  const state = ctx.harness?.[STATE] && typeof ctx.harness[STATE] === "object" ? ctx.harness[STATE] : {};
  const map = readMap(ctx.env);
  const pinnedIds = state.pinBodies ? (state.pinned ?? []).map((p) => p.id) : [];
  const direct = corpusIds(map, [...(state.universal ?? []), ...pinnedIds]);
  const inHand = new Set(direct);
  const rankedHits = (state.ranked ?? []).slice(0, RANKED);
  const ranked = corpusIds(map, rankedHits.map((h) => h.id));
  const scores = {};
  for (const h of rankedHits) {
    const id = map?.toCorpus.get(h.id);
    if (id) scores[id] = h.score;
  }
  return claim(ctx, SELF, undefined, {
    direct,
    offered: map ? [...map.toSkill.keys()].filter((id) => !inHand.has(id)) : [],
    reach: "search",
    ranked,
    scores,
  });
}

export { embeddingConfig, retrieve };
