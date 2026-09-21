// The two bench seams. The corpus of tool groups reaches every arm as ordinary packages, installed by the
// bench's own fixture (packages/bench/fixtures/tool-corpus), so this package sees packages and nothing else;
// the importer here only seeds the vector cache from the bench file, and the adapter claims what the pin
// holds. Claims name corpus ids, which are the group ids the fixture declares.
import { claim } from "@thetis/skills";

export const CORPUS_PATH = "bench/corpus.json";

async function corpusIds(env) {
  try {
    const raw = JSON.parse(await env.readFile(CORPUS_PATH));
    return Array.isArray(raw?.records) ? raw.records.map((r) => r.id).filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Seeds the vector cache; returns the import record for `harness["@thetis/bench"]`, or nothing outside a corpus suite. */
export async function importCorpus(ctx, { deriveGroups, seedVectors, VECTORS_DIR }) {
  const ids = await corpusIds(ctx.env);
  if (!ids.length) return;
  const { groups } = deriveGroups(ctx.packages, ctx.config ?? {});
  const present = groups.filter((g) => ids.includes(g.id));
  const t0 = Date.now();
  const seeded = await seedVectors(ctx.env, groups, ctx.config ?? {}, VECTORS_DIR);
  return claim(ctx, "@thetis/tool-groups", {
    imported: present.length,
    representation: `${present.length} of ${ids.length} corpus groups are installed packages; ${seeded} vectors seeded into tool-groups/vectors.json`,
    builtMs: Date.now() - t0,
  });
}

/** The claim: `direct` the active corpus groups (their tool schemas are in the call), `offered` the rest, reach `catalogue`. */
export async function benchReport(ctx, pin) {
  const ids = await corpusIds(ctx.env);
  const active = new Set(pin?.active ?? []);
  const direct = ids.filter((id) => active.has(id));
  return claim(ctx, "@thetis/tool-groups", undefined, {
    direct,
    offered: ids.filter((id) => !active.has(id)),
    reach: "catalogue",
    ...(pin?.ranked?.length ? { ranked: pin.ranked.map((h) => h.id).filter((id) => ids.includes(id)), scores: Object.fromEntries(pin.ranked.filter((h) => ids.includes(h.id)).map((h) => [h.id, h.score])) } : {}),
    mode: pin?.mode ?? "none",
  });
}
