// Everything, in order, until the budget runs out. The simplest mechanism there is, and the one every other
// has to beat: it never chooses wrongly because it never chooses.
import { loadCorpus, mark, KEY } from "./lib/shared.js";

const SELF = "@flat/skills";

const BUDGET = 96 * 1024;

export async function importCorpus(ctx) {
  // Nothing to build: this mechanism reads the corpus as it is.
  const corpus = await loadCorpus(ctx.env);
  return mark(ctx, SELF, { imported: corpus.records.length, representation: "none: the corpus is read as it stands" });
}

export async function inject(ctx) {
  const corpus = await loadCorpus(ctx.env);
  const injected = [];
  const parts = [];
  let used = 0;
  for (const record of corpus.records) {
    const block = `## ${record.name}\n${record.body}\n`;
    if (used + block.length > BUDGET) break;
    used += block.length;
    parts.push(block);
    injected.push(record.id);
  }
  const system = [ctx.call.system, `# Capabilities\n${parts.join("\n")}`].filter(Boolean).join("\n\n");
  const prev = ctx.harness[KEY] ?? {};
  return {
    call: { ...ctx.call, system },
    harness: { ...ctx.harness, [KEY]: { ...prev, injected, dropped: corpus.records.length - injected.length } },
  };
}

export async function benchReport(ctx) {
  const mine = ctx.harness[KEY] ?? {};
  return mark(ctx, SELF, undefined, {
    direct: mine.injected ?? [],
    offered: [],
    reach: "direct",
    budgetBytes: BUDGET,
    droppedForBudget: mine.dropped ? [`${mine.dropped} records did not fit`] : [],
  });
}
