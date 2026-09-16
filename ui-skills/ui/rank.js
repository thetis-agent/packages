/* Okapi BM25 for the search box, in the page. The gateway serves an extension only the files under its own
 * `ui/` directory, so the library's ranker (`@thetis/skills`, lib/rank.js) cannot be imported here; this is
 * the same algorithm on the same text (name, description, tags), with the same constants, the same stop
 * words and the same tie rule, and the package's tests hold the two to identical answers. Keep them in
 * step: a change in the library's tokenizer or scoring belongs here too. */

const K1 = 1.2;
const B = 0.75;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "you", "your", "are", "from", "how", "what", "can", "should", "when", "use", "using", "into", "out", "its", "not", "but", "was", "were", "has", "have", "had", "will", "would", "than", "then", "them", "they", "their", "there", "here", "also", "any", "all", "one", "two", "our", "who", "why", "where", "which"]);

/** Lowercase tokens of two or more characters, split on anything that is not a letter or a digit, without stop words. */
export const tokens = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

const textOf = (s) => `${s.name ?? ""} ${s.description ?? ""} ${(s.tags ?? []).join(" ")}`;

/** An index over the rows: term counts per document, document frequencies, and the average length. */
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

/** The top `k` rows for `query` as `[{ id, score }]`, scores above zero only, ties by id. */
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
    if (score > 0) out.push({ id: doc.id, score: Math.round(score * 1e6) / 1e6 });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}
