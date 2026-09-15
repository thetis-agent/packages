// Names and descriptions in the prompt, bodies behind a tool. Nothing is in hand until the model asks for it,
// so this mechanism trades a round trip for a prompt that stays small however large the corpus grows.
import { loadCorpus, mark, KEY } from "./lib/shared.js";

const SELF = "@l1/skills";

export async function importCorpus(ctx) {
  const corpus = await loadCorpus(ctx.env);
  return mark(ctx, SELF, {
    imported: corpus.records.length,
    representation: `catalogue of ${corpus.records.length} names and descriptions; bodies stay on disk until asked for`,
  });
}

export async function catalogue(ctx) {
  const corpus = await loadCorpus(ctx.env);
  const lines = corpus.records.map((r) => `- ${r.id}: ${r.name} — ${r.description}`);
  const system = [ctx.call.system, `# Capabilities you can load\nCall load_skill with an id to read one in full.\n${lines.join("\n")}`]
    .filter(Boolean)
    .join("\n\n");
  return { call: { ...ctx.call, system } };
}

export async function loadSkill(args, env) {
  const corpus = await loadCorpus(env);
  const record = corpus.records.find((r) => r.id === args.id);
  return record ? record.body : `error: no capability with the id ${args.id}`;
}

export async function benchReport(ctx) {
  const corpus = await loadCorpus(ctx.env);
  // A body the model already fetched this session is in hand; everything else is one call away.
  const loaded = new Set();
  for (const message of ctx.conversation) {
    if (message.role !== "tool" || message.name !== "load_skill") continue;
    for (const record of corpus.records) if (message.content.includes(record.canary)) loaded.add(record.id);
  }
  return mark(ctx, SELF, undefined, {
    direct: [...loaded],
    offered: corpus.records.map((r) => r.id),
    reach: "catalogue",
  });
}
