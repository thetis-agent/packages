// Seeded resampling and paired comparison. A bench run is deterministic, so the uncertainty that matters is
// which tasks are in the suite, not how many times each was run: every interval here is a bootstrap over
// tasks. Ported from thetis-agent.v2 runtime/lib/evaluation/metrics.ts and random.ts.
import { createHash, createHmac } from "node:crypto";

export const limits = { bootstrapSamples: 2000, tasks: 4096 };

export interface Interval {
  mean: number;
  lower: number;
  upper: number;
  /** Half the width of the interval: the smallest difference this many tasks can resolve. */
  mde: number;
  n: number;
}

/** A pairwise verdict that a mean cannot hide: one pathological task is visible here. */
export interface Paired {
  interval: Interval;
  wins: number;
  ties: number;
  losses: number;
  /** Two-sided sign-flip permutation test on the paired differences. */
  p: number;
}

export function seedOf(parts: readonly (string | number)[]): string {
  return createHmac("sha256", "thetis/bench/v1").update(JSON.stringify(parts)).digest("hex");
}

/** xorshift32 from a seed. Deterministic across machines and Node versions. */
export function random(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at] as number;
}

/** Percentile bootstrap over the values, which are per-task. Seeded, so a rerun gives the same interval. */
export function bootstrap(values: readonly number[], seed: string, samples = limits.bootstrapSamples): Interval {
  if (!values.length) throw new Error("bootstrap needs at least one value");
  if (values.length > limits.tasks) throw new Error(`bootstrap over ${values.length} values exceeds the limit`);
  if (values.some((v) => !Number.isFinite(v))) throw new Error("bootstrap values must all be finite");
  const draw = random(seed);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[Math.floor(draw() * values.length)] as number;
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const lower = quantile(means, 0.025);
  const upper = quantile(means, 0.975);
  return { mean: mean(values), lower, upper, mde: (upper - lower) / 2, n: values.length };
}

/**
 * The paired difference between two arms on the same tasks. Pairing cancels the constant floor — the guide,
 * the package list, the fence round trip — which is what makes two mechanisms of different shape comparable.
 */
export function paired(arm: readonly number[], base: readonly number[], seed: string, samples = limits.bootstrapSamples): Paired {
  if (arm.length !== base.length) throw new Error("paired comparison needs one value per task in both arms");
  const diffs = arm.map((v, i) => v - (base[i] as number));
  return {
    interval: bootstrap(diffs, seed, samples),
    wins: diffs.filter((d) => d > 0).length,
    ties: diffs.filter((d) => d === 0).length,
    losses: diffs.filter((d) => d < 0).length,
    p: signFlip(diffs, `${seed}:signflip`, samples),
  };
}

/**
 * Two-sided sign-flip permutation test. Under the null the sign of each paired difference is a coin flip, so
 * resampling signs gives the null distribution of the mean without assuming anything about its shape.
 */
export function signFlip(diffs: readonly number[], seed: string, samples = limits.bootstrapSamples): number {
  const observed = Math.abs(mean(diffs));
  if (!diffs.length) return 1;
  const draw = random(seed);
  let atLeast = 0;
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (const d of diffs) total += draw() < 0.5 ? -d : d;
    if (Math.abs(total / diffs.length) >= observed) atLeast++;
  }
  return (atLeast + 1) / (samples + 1);
}

/**
 * Where an arm sits between the floor and the ceiling. Reporting this beside a raw number is what lets two
 * suites of different difficulty be read side by side.
 */
export function normalisedGain(arm: number, floor: number, ceiling: number): number | null {
  const span = ceiling - floor;
  return Math.abs(span) < 1e-12 ? null : (arm - floor) / span;
}
