// Rank first, inject a few, offer the rest behind a search tool. The only one of the three mechanisms that
// makes a decision the harness can be held to, which is why it is the only one with a ranking to report.
import { loadCorpus, mark, KEY } from "./lib/shared.js";
import { index, search } from "./lib/rank.js";

const SELF = "@rank/skills";
const PIN = 3;

let idx = null;
const indexOf = (corpus) => (idx ??= index(corpus.records));

/** The first user message is the request; later turns keep the same pin so the prompt prefix stays cacheable. */
const requestOf = (ctx) => ctx.conversation.find((m) => m.role === "user")?.content ?? "";

export async function importCorpus(ctx) {
  const corpus = await loadCorpus(ctx.env);
  const built = indexOf(corpus);
  return mark(ctx, SELF, {
    imported: corpus.records.length,
    representation: `BM25 index over ${built.n} records, ${built.df.size} distinct terms`,
  });
}

export async function pin(ctx) {
  const corpus = await loadCorpus(ctx.env);
  const hits = search(indexOf(corpus), requestOf(ctx), PIN);
  const byId = new Map(corpus.records.map((r) => [r.id, r]));
  const bodies = hits.map((h) => `## ${byId.get(h.id).name}\n${byId.get(h.id).body}`).join("\n\n");
  const system = [ctx.call.system, bodies && `# Capabilities for this request\n${bodies}`].filter(Boolean).join("\n\n");
  const prev = ctx.harness[KEY] ?? {};
  return {
    call: { ...ctx.call, system },
    harness: { ...ctx.harness, [KEY]: { ...prev, pinned: hits.map((h) => h.id), scores: Object.fromEntries(hits.map((h) => [h.id, Math.round(h.score * 1000) / 1000])) } },
  };
}

export async function skillSearch(args, env) {
  const corpus = await loadCorpus(env);
  const hits = search(indexOf(corpus), args.query, Number(args.k) || 5);
  const byId = new Map(corpus.records.map((r) => [r.id, r]));
  return hits.map((h) => `${h.id}: ${byId.get(h.id).description}`).join("\n") || "no capability matched";
}

export async function benchReport(ctx) {
  const corpus = await loadCorpus(ctx.env);
  const mine = ctx.harness[KEY] ?? {};
  const pinned = mine.pinned ?? [];
  // A full ranking, not just what was pinned: the ranking is the decision, and the pin is only its first few.
  const ranked = search(indexOf(corpus), requestOf(ctx), 10).map((h) => h.id);
  return mark(ctx, SELF, undefined, {
    direct: pinned,
    offered: corpus.records.map((r) => r.id).filter((id) => !pinned.includes(id)),
    reach: "search",
    ranked,
    scores: mine.scores ?? {},
  });
}
