import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrap, mean, normalisedGain, paired, random, seedOf, signFlip } from "../src/metrics/stats.js";
import { bitsOverRandom, overshootBytes, reachOf, score, type Available, type Gold } from "../src/metrics/recall.js";
import { hitAt1, invariance, mrr, ndcg } from "../src/metrics/ranking.js";

const gold = (required: string[], forbidden: string[] = []): Gold => ({
  required: new Set(required),
  helpful: new Set<string>(),
  forbidden: new Set(forbidden),
});

const avail = (direct: string[], catalogue: string[] = [], search: string[] = [], ranked?: string[]): Available => ({
  direct: new Set(direct),
  catalogue: new Set(catalogue),
  search: new Set(search),
  ranked,
});

test("the seeded generator is stable and uniform enough to resample with", () => {
  const a = random("abc");
  const b = random("abc");
  const first = [a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b()]);
  assert.ok(first.every((v) => v >= 0 && v < 1));
  const draw = random("spread");
  let total = 0;
  for (let i = 0; i < 20000; i++) total += draw();
  assert.ok(Math.abs(total / 20000 - 0.5) < 0.02, "mean of the draws should sit near a half");
});

test("a bootstrap interval brackets the mean and is reproducible from its seed", () => {
  const values = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 10 + i);
  const one = bootstrap(values, "seed-1");
  const two = bootstrap(values, "seed-1");
  assert.deepEqual(one, two, "the same seed must give the same interval");
  assert.ok(Math.abs(one.mean - mean(values)) < 1e-12);
  assert.ok(one.lower < one.mean && one.mean < one.upper);
  assert.equal(one.n, 60);
  assert.ok(Math.abs(one.mde - (one.upper - one.lower) / 2) < 1e-12);
  const other = bootstrap(values, "seed-2");
  assert.ok(other.lower !== one.lower || other.upper !== one.upper, "a different seed draws a different sample");
  assert.ok(Math.abs(other.mean - one.mean) < 1e-12, "the point estimate is the data, not the draw");
});

test("a constant sample has no spread", () => {
  const flat = bootstrap([3, 3, 3, 3], "seed");
  assert.equal(flat.mean, 3);
  assert.equal(flat.lower, 3);
  assert.equal(flat.upper, 3);
  assert.equal(flat.mde, 0);
});

test("bootstrap refuses input it cannot honestly summarise", () => {
  assert.throws(() => bootstrap([], "seed"), /at least one value/);
  assert.throws(() => bootstrap([1, Number.NaN], "seed"), /finite/);
});

test("a paired comparison counts wins and losses, not just the mean", () => {
  const arm = [10, 11, 12, 13, 14];
  const base = [9, 10, 13, 12, 13];
  const result = paired(arm, base, "pair");
  assert.equal(result.interval.mean, mean([1, 1, -1, 1, 1]));
  assert.deepEqual([result.wins, result.ties, result.losses], [4, 0, 1]);
});

test("a one-sided difference is significant and a symmetric one is not", () => {
  const diffs = Array.from({ length: 30 }, () => 2);
  assert.ok(signFlip(diffs, "all-positive") < 0.01, "thirty identical gains cannot come from coin flips");
  const balanced = [1, -1, 1, -1, 1, -1, 1, -1];
  assert.ok(signFlip(balanced, "balanced") > 0.5, "a difference of zero is not evidence of anything");
});

test("normalised gain places an arm between the floor and the ceiling", () => {
  assert.equal(normalisedGain(0.5, 0, 1), 0.5);
  assert.equal(normalisedGain(0.2, 0.2, 0.6), 0);
  assert.equal(normalisedGain(0.6, 0.2, 0.6), 1);
  assert.equal(normalisedGain(0.5, 0.4, 0.4), null, "a zero span has no scale to report against");
});

test("reach is every tier, whatever it cost to get there", () => {
  assert.deepEqual([...reachOf(avail(["a"], ["b"], ["c"]))].sort(), ["a", "b", "c"]);
});

test("attaching everything buys recall and pays for it in precision", () => {
  const everything = score(avail(["a", "b", "c", "d", "e"]), gold(["a", "b"]));
  assert.equal(everything.recall_reach, 1);
  assert.equal(everything.completeness, 1);
  assert.equal(everything.undershoot, 0);
  assert.equal(everything.precision_direct, 2 / 5);
  assert.equal(everything.overshoot_count, 1.5, "three extra bodies for two needed");
  assert.equal(everything.fetch_rounds, 0);
});

test("attaching nothing is perfectly precise and perfectly useless", () => {
  const nothing = score(avail([]), gold(["a", "b"]));
  assert.equal(nothing.recall_reach, 0);
  assert.equal(nothing.completeness, 0);
  assert.equal(nothing.undershoot, 1);
  assert.equal(nothing.precision_direct, null, "a rate over an empty set is not zero");
  assert.equal(nothing.overshoot_count, 0);
});

test("the oracle scores every way at once", () => {
  const oracle = score(avail(["a", "b"]), gold(["a", "b"]));
  assert.equal(oracle.recall_reach, 1);
  assert.equal(oracle.precision_direct, 1);
  assert.equal(oracle.f1_direct, 1);
  assert.equal(oracle.overshoot_count, 0);
  assert.equal(oracle.undershoot, 0);
});

test("completeness is all or nothing, where recall is partial credit", () => {
  const most = score(avail(["a", "b"]), gold(["a", "b", "c"]));
  assert.equal(most.recall_reach, 2 / 3);
  assert.equal(most.completeness, 0, "two of the three capabilities cannot finish the task");
});

test("a capability behind a tool counts as reached, and charges a round trip", () => {
  const catalogued = score(avail([], ["a"]), gold(["a"]));
  assert.equal(catalogued.recall_reach, 1);
  assert.equal(catalogued.recall_direct, 0);
  assert.equal(catalogued.fetch_rounds, 1);
  const both = score(avail([], ["a"], ["b"]), gold(["a", "b"]));
  assert.equal(both.fetch_rounds, 2, "two tiers, two trips");
});

test("a forbidden capability is flagged however it was reached", () => {
  assert.equal(score(avail(["x"]), gold(["a"], ["x"])).forbidden_hit, 1);
  assert.equal(score(avail([], [], ["x"]), gold(["a"], ["x"])).forbidden_hit, 1);
  assert.equal(score(avail(["a"]), gold(["a"], ["x"])).forbidden_hit, 0);
});

test("overshoot in bytes charges what was wasted against what was wanted", () => {
  const bytes = (id: string) => ({ a: 100, b: 100, c: 300 })[id] ?? 0;
  assert.equal(overshootBytes(new Set(["a", "c"]), new Set(["a"]), bytes), 3);
  assert.equal(overshootBytes(new Set(["a"]), new Set(["a"]), bytes), 0);
  assert.equal(overshootBytes(new Set(), new Set(["a"]), bytes), 0);
  assert.equal(overshootBytes(new Set(["c"]), new Set(["a"]), bytes), null, "nothing wanted means no scale");
});

test("bits over random does not move when the corpus grows for the same arm", () => {
  const small = bitsOverRandom(1, 1, 10, 100);
  const large = bitsOverRandom(1, 1, 100, 1000);
  assert.equal(small, large, "the same depth ratio is the same evidence");
  assert.ok((bitsOverRandom(1, 1, 4, 100) as number) > (small as number), "finding it in fewer slots is better");
  assert.equal(bitsOverRandom(1, 1, 100, 100), 0, "taking the whole registry is worth nothing");
  assert.equal(bitsOverRandom(0, 1, 10, 100), null);
});

test("ndcg rewards putting the needed capability early", () => {
  const g = new Set(["a"]);
  assert.equal(ndcg(g, ["a", "x", "y", "z"]), 1);
  assert.ok(ndcg(g, ["x", "a", "y", "z"]) < 1);
  assert.ok(ndcg(g, ["x", "a", "y", "z"]) > ndcg(g, ["x", "y", "a", "z"]));
  assert.equal(ndcg(g, ["x", "y", "z", "w", "a"]), 0, "past the cut is not found");
  assert.equal(ndcg(new Set<string>(), ["a"]), 0);
});

test("ndcg of two gold ids at the top is one", () => {
  assert.equal(ndcg(new Set(["a", "b"]), ["a", "b", "x", "y"]), 1);
});

test("hit at one and reciprocal rank read the same list differently", () => {
  const g = new Set(["b"]);
  assert.equal(hitAt1(g, ["b", "a"]), 1);
  assert.equal(hitAt1(g, ["a", "b"]), 0);
  assert.equal(mrr(g, ["a", "b"]), 0.5);
  assert.equal(mrr(g, ["a", "c"]), 0);
  assert.equal(hitAt1(g, []), 0);
});

test("invariance catches a matcher that keys on the words a variant rewrites", () => {
  assert.equal(invariance([{ original: "a", mutated: "a" }, { original: "b", mutated: "b" }]).fraction, 1);
  assert.equal(invariance([{ original: "a", mutated: "a" }, { original: "b", mutated: "c" }]).fraction, 0.5);
  assert.equal(invariance([]).variants, 0);
});

test("a seed is a pure function of its parts", () => {
  assert.equal(seedOf(["suite", 1]), seedOf(["suite", 1]));
  assert.notEqual(seedOf(["suite", 1]), seedOf(["suite", 2]));
});
