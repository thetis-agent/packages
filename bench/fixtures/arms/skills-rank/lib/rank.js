// A small lexical ranker: Okapi BM25 over each record's name, description and tags. Deliberately plain —
// the point of this fixture is to be a third mechanism with a shape the other two do not have, not to be a
// good retriever. If a real package cannot beat this, that is worth knowing.
const K1 = 1.5;
const B = 0.75;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "you", "your", "are", "from", "how", "what", "can", "should", "when", "use", "using", "into", "out", "its"]);

export const tokens = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

export function index(records) {
  const docs = records.map((r) => ({ id: r.id, terms: tokens(`${r.name} ${r.description} ${r.tags.join(" ")}`) }));
  const df = new Map();
  for (const doc of docs) for (const term of new Set(doc.terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const avg = docs.reduce((n, d) => n + d.terms.length, 0) / Math.max(1, docs.length);
  return { docs, df, avg, n: docs.length };
}

export function search(idx, query, k = 5) {
  const terms = tokens(query);
  const scored = idx.docs.map((doc) => {
    const counts = new Map();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = counts.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (idx.n - (idx.df.get(term) ?? 0) + 0.5) / ((idx.df.get(term) ?? 0) + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.terms.length) / idx.avg)));
    }
    return { id: doc.id, score };
  });
  // Ties broken by id, so the same corpus and the same query always give the same order on every machine.
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}
