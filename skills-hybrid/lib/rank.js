// The hybrid ranking, pure: a dense list from cosine, a lexical list from BM25, fused by weighted reciprocal
// rank fusion, the parent rules, and a `how` per hit that says which list put it there.
import { bm25Index, bm25Search, fuse, absorb, promote, tokens } from "@thetis/skills";
import { cosine } from "./embed.js";

export const POOL = 50;
export const RANKED = 10;
export const DEFAULT_WEIGHT = 0.7;
export const DEFAULT_PIN = 6;
/**
 * The cosine below which a dense hit is not a hit. Measured on skill-recall@1 (287 cards, 90 tasks, text-embedding-3-small):
 * the gold cards' cosine has median 0.475 and 5th percentile 0.28; the controls' best card has median 0.28. At 0.3, 94% of
 * gold cards pass and 7 of the 10 controls get no dense hit at all.
 */
export const DEFAULT_THRESHOLD = 0.3;
/**
 * How many distinct words of the query a skill's text must carry before the words alone are evidence. One word in the
 * name or a tag is enough on its own: those are curated. A word in the description is not: "word" in "word splitting"
 * pinned a MOO parser for "Reply with the single word ok."
 */
export const DEFAULT_MIN_TERMS = 2;

/** Whether the words of `query` are evidence for `skill`: a name or tag word, or `minTerms` words anywhere in its text. */
export function lexicalEvidence(skill, query, minTerms = DEFAULT_MIN_TERMS) {
  const q = new Set(tokens(query));
  if (!q.size) return false;
  const strong = new Set(tokens(`${skill.name ?? ""} ${String(skill.id ?? "").split("/").pop()} ${(skill.tags ?? []).join(" ")}`));
  const weak = new Set(tokens(skill.description ?? ""));
  let s = 0;
  let w = 0;
  for (const t of q) {
    if (strong.has(t)) s++;
    else if (weak.has(t)) w++;
  }
  return s >= 1 || s + w >= minTerms;
}

const round = (x) => Math.round(x * 1e6) / 1e6;

/** Cosine of the query against every skill that has a vector, best first, ties by id, at most `k`. */
export function denseRank(skills, vectors, queryVector, k = POOL) {
  const out = [];
  for (const s of skills) {
    const v = vectors.get(s.id);
    if (!v) continue;
    out.push({ id: s.id, score: round(cosine(queryVector, v)) });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

/**
 * Fuses the two lists, applies the parent rules, cuts to `limit`, and labels each hit: `parent-of-match` when
 * promoted, `dense` when the dense list ranks it at least as well as the lexical one, `lexical` otherwise.
 * Universal skills are never in the result: their bodies are in every prompt already.
 */
export function hybridRank(skills, { dense = [], lexical = [], weight = DEFAULT_WEIGHT, limit = RANKED, universal = new Set() } = {}) {
  const fused = fuse(dense, lexical, weight).filter((h) => !universal.has(h.id));
  const absorbed = absorb(skills, fused);
  const ranked = promote(skills, absorbed, limit).filter((h) => !universal.has(h.id));
  const dRank = new Map(dense.map((h, i) => [h.id, i]));
  const lRank = new Map(lexical.map((h, i) => [h.id, i]));
  return ranked.map((h) => {
    let how;
    if (h.how === "promoted") how = "parent-of-match";
    else if (dRank.has(h.id) && (!lRank.has(h.id) || dRank.get(h.id) <= lRank.get(h.id))) how = "dense";
    else how = "lexical";
    return { id: h.id, score: h.score, how };
  });
}

/** The lexical list for a query over the skills, pool-sized. */
export function lexicalRank(skills, query, k = POOL) {
  return bm25Search(bm25Index(skills), query, k);
}
