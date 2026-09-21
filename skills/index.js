// @thetis/skills: the format, the sources, the ranker and the one tool every loader shares. Nothing runs at
// import; a loader or a dock imports what it needs and calls it on a turn.
export { parseFrontmatter, splitDocument, yamlString } from "./lib/frontmatter.js";
export { parseSkill, lint, brief, card, renderBody, firstSentence, restOfDescription, contentHashOf, isSkillId, parentOf, LIMITS, NAME_RE } from "./lib/skill.js";
export { loadSkills, sourcesOf, excludedFor, selectSkills, clearCache } from "./lib/load.js";
export { tokens, bm25Index, bm25Search, fuse, absorb, promote, closest } from "./lib/rank.js";
export { fetchSkill, packagesOf, slice, SLICE } from "./lib/fetch.js";
export { importCorpus, claim, readMap, corpusIds, slugOf, skillFileOf, bodyOf, STATE, BENCH_KEY } from "./lib/bench.js";
export { DEFAULTS as EMBED_DEFAULTS, BATCH as EMBED_BATCH, TIMEOUT_MS as EMBED_TIMEOUT_MS, QUERY_CLIP, embeddingConfig, keyOf, hashOfKey, queryTextOf, queryHashOf, round6, cosine, readCache, writeCache, embed, hexOf, benchVectorsPath, benchVectorsFor, clearVectorCache } from "./lib/embed.js";
