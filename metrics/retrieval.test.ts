/** Pin sample gating and exact mutation agreement independently of model opinions; SK-012, SK-013. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieval, invariance, ablation } from './retrieval.ts';

await test('SK-012 nDCG@4 includes a deterministic interval and is ungated below 150 pairs', () => {
  for (const pairs of [149, 150]) {
    const gold = Array.from({ length: pairs }, (_, index) => ({ query: `query-${String(index)}`, skills: ['gold'] }));
    const result = retrieval(gold, gold, 'private-heldout'); assert.ok(result.ok);
    assert.deepEqual(result.value.ndcg, { mean: 1, lower: 1, upper: 1 }); assert.equal(result.value.gated, pairs >= 150);
    assert.deepEqual(result, retrieval(gold, gold, 'private-heldout'));
  }
  const shifted = retrieval([{ query: 'q', skills: ['gold'] }], [{ query: 'q', skills: ['other', 'gold'] }], 'seed');
  assert.ok(shifted.ok); assert.equal(shifted.value.ndcg.mean, 1 / Math.log2(3));
});
await test('SK-013 invariance requires both top tool and top skill agreement in at least ninety percent', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ originalTool: 'read', mutatedTool: index === 0 ? 'write' : 'read', originalSkill: 'surgery', mutatedSkill: 'surgery' }));
  const passing = invariance(rows); assert.ok(passing.ok); assert.equal(passing.value.meets, true);
  const second = rows[1]; assert.ok(second); second.mutatedSkill = 'other';
  const failing = invariance(rows); assert.ok(failing.ok); assert.equal(failing.value.meets, false);
  assert.equal(invariance([]).ok, false); assert.equal(ablation([], 'tool', 'read').ok, false);
});
