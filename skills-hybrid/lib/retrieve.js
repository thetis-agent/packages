// One ranking of the skills against a query: vectors from the cache, the bench file or the endpoint, the
// lexical list beside them, fused. Nothing here throws: a missing key, a refused call or a malformed answer
// leaves the ranking lexical and says so in one note.
import { readMap } from "@thetis/skills";
import { embed, embeddingConfig, indexTextOf, keyOf, queryHashOf, queryTextOf, readCache, writeCache } from "./embed.js";
import { benchVectorsFor } from "./vectors.js";
import { denseRank, hybridRank, lexicalRank, POOL, DEFAULT_WEIGHT } from "./rank.js";

/**
 * Vectors for every skill as a map of id to vector, embedding what the cache lacks when there is a key.
 * Returns `{ vectors, note }`; `vectors` is null when the dense path is not available for this turn.
 */
export async function vectorsFor(env, skills, cfg, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cache = await readCache(env);
  const vectors = new Map();
  const missing = [];
  for (const s of skills) {
    const v = cache[keyOf(cfg.model, cfg.dimensions, s.contentHash)];
    if (v) vectors.set(s.id, v);
    else missing.push(s);
  }
  if (!missing.length) return { vectors, note: null };
  if (!cfg.apiKey) return { vectors: null, note: `no embeddings key: ${missing.length} of ${skills.length} skills have no vector, ranking is lexical` };
  try {
    const got = await embed(missing.map(indexTextOf), cfg, fetchImpl);
    missing.forEach((s, i) => {
      cache[keyOf(cfg.model, cfg.dimensions, s.contentHash)] = got[i];
      vectors.set(s.id, got[i]);
    });
    await writeCache(env, cache, new Set(skills.map((s) => s.contentHash)));
    return { vectors, note: null };
  } catch (e) {
    return { vectors: null, note: `embeddings unavailable (${e?.message ?? e}); ranking is lexical` };
  }
}

/** The query's vector: from the bench file when the query is one of the suite's, else from the endpoint. Null without either. */
export async function queryVectorFor(env, query, cfg, deps = {}) {
  const map = deps.map === undefined ? readMap(env) : deps.map;
  const file = map ? benchVectorsFor(map.sha256, deps.vectorsDir) : null;
  if (file && file.model === cfg.model && file.dimensions === cfg.dimensions) {
    const v = file.queries?.[queryHashOf(query)];
    if (Array.isArray(v)) return { vector: v, note: null };
  }
  if (!cfg.apiKey) return { vector: null, note: "no embeddings key: the query has no vector, ranking is lexical" };
  try {
    const [v] = await embed([queryTextOf(query)], cfg, deps.fetch ?? globalThis.fetch);
    return { vector: v, note: null };
  } catch (e) {
    return { vector: null, note: `embeddings unavailable (${e?.message ?? e}); ranking is lexical` };
  }
}

/**
 * Ranks `skills` for `query`: `{ hits: [{ id, score, how }], mode: "dense" | "lexical", note }`. `mode` is
 * dense when a fused list was possible. The result is deterministic for the same skills, vectors and query.
 */
export async function retrieve(env, skills, query, config, { limit, universal = new Set(), deps = {} } = {}) {
  const cfg = embeddingConfig(config);
  const weight = Number.isFinite(Number(config?.fusionWeight)) ? Number(config.fusionWeight) : DEFAULT_WEIGHT;
  const q = queryTextOf(query);
  const lexical = lexicalRank(skills, q, POOL);
  let dense = [];
  let note = null;
  let mode = "lexical";
  if (skills.length && q.trim()) {
    const got = await vectorsFor(env, skills, cfg, deps);
    if (got.vectors) {
      const qv = await queryVectorFor(env, q, cfg, deps);
      if (qv.vector) {
        dense = denseRank(skills, got.vectors, qv.vector, POOL);
        mode = "dense";
      } else note = qv.note;
    } else note = got.note;
  }
  const hits = hybridRank(skills, { dense, lexical, weight, limit, universal }).map((h) => (mode === "dense" ? h : { ...h, how: h.how === "parent-of-match" ? h.how : "lexical" }));
  return { hits, mode, note, model: cfg.model, dimensions: cfg.dimensions };
}
