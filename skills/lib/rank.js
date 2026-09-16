// Ranking over what retrieval sees: Okapi BM25 (k1 1.2, b 0.75) over name, description and tags, weighted
// reciprocal rank fusion for a dense list beside it, and the two parent rules. Ties are broken by id, so the
// same skills and the same query give the same order on every machine: a retriever that answers
// differently on identical input cannot be compared with anything.
import { parentOf } from "./skill.js";

const K1 = 1.2;
const B = 0.75;
const RRF_K = 60;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "you", "your", "are", "from", "how", "what", "can", "should", "when", "use", "using", "into", "out", "its", "not", "but", "was", "were", "has", "have", "had", "will", "would", "than", "then", "them", "they", "their", "there", "here", "also", "any", "all", "one", "two", "our", "who", "why", "where", "which"]);

/** Lowercase tokens of two or more characters, split on anything that is not a letter or a digit, without stop words. */
export const tokens = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

const textOf = (s) => `${s.name ?? ""} ${s.description ?? ""} ${(s.tags ?? []).join(" ")}`;

/** An index over the skills: term counts per document, document frequencies, and the average length. */
export function bm25Index(skills) {
  const docs = [];
  const df = new Map();
  let total = 0;
  for (const s of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    const terms = tokens(textOf(s));
    const counts = new Map();
    for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ id: s.id, length: terms.length, counts });
    total += terms.length;
  }
  return { docs, df, n: docs.length, avg: docs.length ? total / docs.length : 0 };
}

/** The top `k` skills for `query` as `[{ id, score }]`, scores above zero only, ties by id. */
export function bm25Search(index, query, k = 10) {
  const terms = [...new Set(tokens(query))];
  const out = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const t of terms) {
      const f = doc.counts.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / (index.avg || 1))));
    }
    if (score > 0) out.push({ id: doc.id, score: round(score) });
  }
  return out.sort(byScoreThenId).slice(0, k);
}

const round = (x) => Math.round(x * 1e6) / 1e6;
const byScoreThenId = (a, b) => b.score - a.score || a.id.localeCompare(b.id);

/**
 * Weighted reciprocal rank fusion, K = 60. `dense` and `lexical` are ranked lists of `{ id }` (best first);
 * `weight` is the dense share, 0 to 1. A list that is empty contributes nothing, so a lexical-only run is
 * the lexical order unchanged.
 */
export function fuse(dense, lexical, weight = 0.7) {
  const w = Math.min(1, Math.max(0, Number(weight) || 0));
  const scores = new Map();
  const add = (list, share) => {
    (list ?? []).forEach((hit, i) => {
      const id = typeof hit === "string" ? hit : hit.id;
      scores.set(id, (scores.get(id) ?? 0) + share / (RRF_K + i + 1));
    });
  };
  add(dense, w);
  add(lexical, 1 - w);
  return [...scores].map(([id, score]) => ({ id, score: round(score) })).sort(byScoreThenId);
}

/**
 * A child whose parent is also in the pool is absorbed into the parent: the parent keeps the better of the
 * two scores and the child leaves. Raises hit@1, lowers nDCG on gold that credits both.
 */
export function absorb(skills, ranked) {
  const ids = new Set(skills.map((s) => s.id));
  const inPool = new Set(ranked.map((h) => h.id));
  const best = new Map(ranked.map((h) => [h.id, h.score]));
  for (const hit of ranked) {
    const parent = parentOf(hit.id);
    if (parent && ids.has(parent) && inPool.has(parent)) best.set(parent, Math.max(best.get(parent), hit.score));
  }
  return ranked
    .filter((h) => {
      const parent = parentOf(h.id);
      return !(parent && ids.has(parent) && inPool.has(parent));
    })
    .map((h) => ({ ...h, score: best.get(h.id) }))
    .sort(byScoreThenId);
}

/** The parent of a lone child is promoted into the pool at 0.99 of the child's score; the pool is cut to `limit`. */
export function promote(skills, ranked, limit = ranked.length) {
  const ids = new Set(skills.map((s) => s.id));
  const inPool = new Set(ranked.map((h) => h.id));
  const out = [...ranked];
  for (const hit of ranked) {
    const parent = parentOf(hit.id);
    if (!parent || !ids.has(parent) || inPool.has(parent)) continue;
    inPool.add(parent);
    out.push({ id: parent, score: round(hit.score * 0.99), how: "promoted" });
  }
  return out.sort(byScoreThenId).slice(0, limit);
}

/** The ids nearest a misspelt name: shared tokens first, then edit distance. For a tool's error message. */
export function closest(skills, query, n = 5) {
  const q = String(query ?? "").toLowerCase();
  const qt = tokens(q);
  const near = (a, b) => a === b || (a.length > 2 && b.startsWith(a)) || (b.length > 2 && a.startsWith(b));
  return [...skills]
    .map((s) => {
      const st = tokens(s.id);
      const shared = qt.filter((t) => st.some((u) => near(t, u))).length;
      const name = s.id.split("/").pop();
      return { id: s.id, shared, distance: Math.min(levenshtein(q, s.id), levenshtein(q, name)) };
    })
    .sort((a, b) => b.shared - a.shared || a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((x) => x.id);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
