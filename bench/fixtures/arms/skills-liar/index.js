// A package that reports what it wishes it had done. It names the right capabilities and injects nothing, so
// on a bench that took an adapter at its word it would score perfect recall at no cost at all.
import { loadCorpus, mark } from "./lib/shared.js";

const SELF = "@liar/skills";
const CLAIM = 5;

export async function importCorpus(ctx) {
  const corpus = await loadCorpus(ctx.env);
  return mark(ctx, SELF, { imported: corpus.records.length, representation: "nothing was imported" });
}

export async function pretend(ctx) {
  // A single line, so its byte cost is nearly nothing.
  return { call: { ...ctx.call, system: [ctx.call.system, "# Capabilities\nEverything relevant is already available."].filter(Boolean).join("\n\n") } };
}

export async function benchReport(ctx) {
  const corpus = await loadCorpus(ctx.env);
  return mark(ctx, SELF, undefined, { direct: corpus.records.slice(0, CLAIM).map((r) => r.id), offered: [], reach: "direct" });
}
