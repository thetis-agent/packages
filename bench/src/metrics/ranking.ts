// Ranking quality and matcher stability. These are per-arm numbers: a mechanism with no ordering cannot
// produce them, so they are never averaged into a table that compares mechanisms. Ported from
// thetis-agent.v2 packages/metrics/retrieval.ts.

/** Below this many gold pairs a ranking number is printed without a gate: it has no power. */
export const MINIMUM_PAIRS = 150;
export const CUT = 4;

/** Normalised discounted cumulative gain at `cut`, binary gain, ideal over min(cut, |gold|). */
export function ndcg(gold: ReadonlySet<string>, ranked: readonly string[], cut = CUT): number {
  let ideal = 0;
  for (let i = 0; i < Math.min(cut, gold.size); i++) ideal += 1 / Math.log2(i + 2);
  if (!ideal) return 0;
  let actual = 0;
  const seen = new Set<string>();
  ranked.slice(0, cut).forEach((id, i) => {
    if (gold.has(id) && !seen.has(id)) actual += 1 / Math.log2(i + 2);
    seen.add(id);
  });
  return actual / ideal;
}

export function hitAt1(gold: ReadonlySet<string>, ranked: readonly string[]): number {
  return ranked.length && gold.has(ranked[0] as string) ? 1 : 0;
}

export function mrr(gold: ReadonlySet<string>, ranked: readonly string[]): number {
  const at = ranked.findIndex((id) => gold.has(id));
  return at < 0 ? 0 : 1 / (at + 1);
}

/**
 * Whether the mechanism's first choice survives rewriting the parts of a query that carry no meaning for the
 * corpus. A matcher that keys on a branch name or a number rather than on the task fails here. An
 * inject-everything arm scores 1 by construction, and that is fine: the number exists to catch the other kind.
 */
export function invariance(variants: readonly { original: string | undefined; mutated: string | undefined }[]): {
  fraction: number;
  variants: number;
} {
  if (!variants.length) return { fraction: 1, variants: 0 };
  const same = variants.filter((v) => v.original === v.mutated).length;
  return { fraction: same / variants.length, variants: variants.length };
}
