/** Keep retrieval and mutation scores deterministic, with held-out sample limits visible; SK-012, SK-013. */
import { bootstrap } from '../../lib/evaluation/index.ts';
import type { Interval, Row } from '../../lib/evaluation/index.ts';
import { failure } from '../../lib/result/index.ts';
import type { Result } from '../../lib/result/index.ts';

export const retrievalLimits = { queries: 256, ranking: 64, minimumPairs: 150, variants: 65536 };
export interface Gold { query: string; skills: readonly string[] }
export interface Ranking { query: string; skills: readonly string[] }
export interface Invariance { fraction: number; meets: boolean; variants: number }

function ndcg(gold: ReadonlySet<string>, ranking: readonly string[]): number {
  let actual = 0; let ideal = 0;
  for (let index = 0; index < Math.min(4, gold.size); index++) ideal += 1 / Math.log2(index + 2);
  const seen = new Set<string>();
  for (const [index, item] of ranking.slice(0, 4).entries()) {
    if (gold.has(item) && !seen.has(item)) actual += 1 / Math.log2(index + 2);
    seen.add(item);
  }
  return ideal ? actual / ideal : 0;
}

export function retrieval(gold: readonly Gold[], rankings: readonly Ranking[], seed: string): Result<{ ndcg: Interval; gated: boolean; pairs: number }, 'invalid-args' | 'budget'> {
  if (!gold.length || gold.length !== rankings.length) return failure('invalid-args', 'Every retrieval query requires one gold set and ranking.');
  if (gold.length > retrievalLimits.queries || rankings.some(row => row.skills.length > retrievalLimits.ranking)) return failure('budget', 'The retrieval measurement exceeds its query or ranking limit.');
  const index = new Map(rankings.map(row => [row.query, row.skills])); const queries = new Set<string>(); const values: number[] = [];
  for (const row of gold) {
    const ranking = index.get(row.query);
    if (!ranking || queries.has(row.query)) return failure('invalid-args', 'The retrieval measurement contains a duplicate or missing query.');
    queries.add(row.query); values.push(ndcg(new Set(row.skills), ranking));
  }
  return { ok: true, value: { ndcg: bootstrap(values, seed), gated: gold.length >= retrievalLimits.minimumPairs, pairs: gold.length } };
}

export function invariance(variants: readonly { originalTool: string; mutatedTool: string; originalSkill: string; mutatedSkill: string }[]): Result<Invariance, 'invalid-args' | 'budget'> {
  if (!variants.length) return failure('invalid-args', 'Invariance requires at least one mutated variant.');
  if (variants.length > retrievalLimits.variants) return failure('budget', 'The invariance measurement exceeds its variant limit.');
  const fraction = variants.filter(row => row.originalTool === row.mutatedTool && row.originalSkill === row.mutatedSkill).length / variants.length;
  return { ok: true, value: { fraction, meets: fraction >= 0.9, variants: variants.length } };
}

export function ablation(rows: readonly Row[], kind: 'tool' | 'skill', item: string): Result<Interval, 'invalid-args' | 'budget'> {
  if (rows.length > 8192) return failure('budget', 'The ablation measurement exceeds its row limit.');
  const base = new Map(rows.filter(row => !row.ablation).map(row => [JSON.stringify([row.task, row.run, row.arm, row.scorer]), row.pass]));
  const tasks = new Map<string, number[]>();
  for (const row of rows) {
    if (row.ablation?.kind !== kind || row.ablation.item !== item || row.required_by?.length) continue;
    const full = base.get(JSON.stringify([row.task, row.run, row.arm, row.scorer]));
    if (full === undefined) return failure('invalid-args', 'An ablated row has no paired complete run.');
    const values = tasks.get(row.task) ?? []; values.push((Number(full) - Number(row.pass)) * 100); tasks.set(row.task, values);
  }
  if (!tasks.size) return failure('invalid-args', 'The item has no eligible ablation tasks.');
  return { ok: true, value: bootstrap([...tasks.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length), `${kind}:${item}`) };
}
