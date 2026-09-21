// The dense ranking of groups against a query, through the shared embeddings library in @thetis/skills. What
// is embedded for a group is its id, brief, tags, the tool names with underscores split, and the first
// sentence of each tool description; the vector is cached under the home by the hash of that text. Nothing
// here throws: without a key, a bench vector file or a working endpoint, `denseRank` answers null and one
// note says why, and the routing stays lexical.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { benchVectorsFor, cosine, embed, embeddingConfig, firstSentence, keyOf, queryHashOf, queryTextOf, readCache, writeCache } from "@thetis/skills";

export const CACHE_PATH = "tool-groups/vectors.json";
export const VECTORS_DIR = fileURLToPath(new URL("../bench/vectors/", import.meta.url));
const CORPUS_PATH = "bench/corpus.json";

/** The text a group is embedded as. The same function feeds scripts/embed-corpus.mjs, so the hashes agree. */
export function indexTextOf(group) {
  return [
    group.id,
    group.brief ?? "",
    (group.tags ?? []).join(" "),
    (group.tools ?? []).map((t) => t.name.replace(/_/g, " ")).join(" "),
    ...(group.tools ?? []).map((t) => firstSentence(t.description ?? "")),
  ]
    .filter(Boolean)
    .join("\n");
}

export const contentHashOf = (group) => createHash("sha256").update(indexTextOf(group)).digest("hex");

const round = (x) => Math.round(x * 1e6) / 1e6;

/** The corpus digest the bench left under the home, or null outside a bench. */
export async function benchCorpusSha(env) {
  try {
    const raw = JSON.parse(await env.readFile(CORPUS_PATH));
    return typeof raw?.sha256 === "string" ? raw.sha256 : null;
  } catch {
    return null;
  }
}

/** The bench vector file for the corpus under the home, when there is one for this model and size. */
export async function benchFileFor(env, cfg, dir = VECTORS_DIR) {
  const sha = await benchCorpusSha(env);
  const file = sha ? benchVectorsFor(sha, dir) : null;
  return file && file.model === cfg.model && file.dimensions === cfg.dimensions ? file : null;
}

/** Whether the dense path can be tried at all: a key, or a bench file to read from. */
export async function denseAvailable(env, config, dir = VECTORS_DIR) {
  const cfg = embeddingConfig(config);
  return !!cfg.apiKey || !!(await benchFileFor(env, cfg, dir));
}

/**
 * Copies the corpus's vectors from the bench file into the cache under the home, so the first bench turn
 * ranks densely without a key. Idempotent: nothing is written when every vector is already there.
 */
export async function seedVectors(env, groups, config = {}, dir = VECTORS_DIR) {
  const cfg = embeddingConfig(config);
  const file = await benchFileFor(env, cfg, dir);
  if (!file) return 0;
  const live = new Set(groups.map(contentHashOf));
  const cache = await readCache(env, CACHE_PATH);
  let added = 0;
  for (const [hash, vector] of Object.entries(file.vectors)) {
    if (!live.has(hash) || !Array.isArray(vector)) continue;
    const key = keyOf(file.model, file.dimensions, hash);
    if (cache[key]) continue;
    cache[key] = vector;
    added++;
  }
  if (added) await writeCache(env, cache, live, CACHE_PATH);
  return added;
}

/** Vectors for every group as a map of id to vector, embedding what the cache lacks when there is a key. */
async function vectorsFor(env, groups, cfg, fetchImpl) {
  const cache = await readCache(env, CACHE_PATH);
  const vectors = new Map();
  const missing = [];
  for (const g of groups) {
    const v = cache[keyOf(cfg.model, cfg.dimensions, contentHashOf(g))];
    if (v) vectors.set(g.id, v);
    else missing.push(g);
  }
  if (!missing.length) return { vectors, note: null };
  // Without a key the groups that have a vector are still ranked; the rest cannot be admitted densely, and a note says so.
  if (!cfg.apiKey) return vectors.size ? { vectors, note: `no embeddings key: ${missing.length} of ${groups.length} groups have no vector and are not ranked densely` } : { vectors: null, note: `no embeddings key: ${missing.length} of ${groups.length} groups have no vector, routing is lexical` };
  try {
    const got = await embed(missing.map(indexTextOf), cfg, fetchImpl);
    missing.forEach((g, i) => {
      cache[keyOf(cfg.model, cfg.dimensions, contentHashOf(g))] = got[i];
      vectors.set(g.id, got[i]);
    });
    await writeCache(env, cache, new Set(groups.map(contentHashOf)), CACHE_PATH);
    return { vectors, note: null };
  } catch (e) {
    return { vectors: null, note: `embeddings unavailable (${e?.message ?? e}); routing is lexical` };
  }
}

/** The query's vector: from the bench file when the query is one of the suite's, else from the endpoint. */
async function queryVectorFor(env, query, cfg, fetchImpl, dir) {
  const file = await benchFileFor(env, cfg, dir);
  const fromFile = file?.queries?.[queryHashOf(query)];
  if (Array.isArray(fromFile)) return { vector: fromFile, note: null };
  if (!cfg.apiKey) return { vector: null, note: "no embeddings key: the query has no vector, routing is lexical" };
  try {
    const [v] = await embed([queryTextOf(query)], cfg, fetchImpl);
    return { vector: v, note: null };
  } catch (e) {
    return { vector: null, note: `embeddings unavailable (${e?.message ?? e}); routing is lexical` };
  }
}

/**
 * Cosine of the query against every group that has a vector, best first, ties by id: `{ hits, note }` with
 * `hits` null when the dense path was not available this turn. Deterministic for the same groups, vectors and query.
 */
export async function denseRank(env, groups, query, config = {}, deps = {}) {
  const cfg = embeddingConfig(config);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const q = queryTextOf(query);
  if (!groups.length || !q.trim()) return { hits: null, note: null };
  const got = await vectorsFor(env, groups, cfg, fetchImpl);
  if (!got.vectors) return { hits: null, note: got.note };
  const qv = await queryVectorFor(env, q, cfg, fetchImpl, deps.vectorsDir ?? VECTORS_DIR);
  if (!qv.vector) return { hits: null, note: qv.note };
  const hits = [];
  for (const g of groups) {
    const v = got.vectors.get(g.id);
    if (v) hits.push({ id: g.id, score: round(cosine(qv.vector, v)) });
  }
  return { hits: hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)), note: got.note };
}
