// This loader's use of the shared embeddings library in @thetis/skills: the cache file it owns under the home,
// and what is embedded for a skill. The request, the cache format and the cosine live in the library, so a
// second retriever (tool groups) shares one implementation and one configuration shape.
import { EMBED_DEFAULTS, EMBED_BATCH, EMBED_TIMEOUT_MS, QUERY_CLIP, embeddingConfig, keyOf, hashOfKey, queryTextOf, queryHashOf, round6, cosine, embed, readCache as readCacheAt, writeCache as writeCacheAt } from "@thetis/skills";

export const DEFAULTS = EMBED_DEFAULTS;
export const BATCH = EMBED_BATCH;
export const TIMEOUT_MS = EMBED_TIMEOUT_MS;
export const CACHE_PATH = "skills-hybrid/vectors.json";
export { QUERY_CLIP, embeddingConfig, keyOf, hashOfKey, queryTextOf, queryHashOf, round6, cosine, embed };

/** What is embedded for a skill: the same fields retrieval indexes, and nothing from the body. */
export const indexTextOf = (skill) => [skill.name ?? "", skill.description ?? "", (skill.tags ?? []).join(" ")].filter(Boolean).join("\n");

/** The cache under the home as an object of key to vector, or empty when the file is missing or unreadable. */
export const readCache = (env) => readCacheAt(env, CACHE_PATH);

/** Writes the cache with every key whose content hash no live skill has removed. Keys are sorted, so the file is stable. */
export const writeCache = (env, cache, liveHashes) => writeCacheAt(env, cache, liveHashes, CACHE_PATH);
