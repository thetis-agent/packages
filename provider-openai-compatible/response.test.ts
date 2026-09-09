/** Bound vendor-owned call identities before retaining fragmented calls; PR-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseState, settings } from './response.ts';

await test('PR-006 fragmented tool identities refuse unbounded ids and call pools', () => {
  const state = new ResponseState({ id: 'fixture', contextWindow: 1024, maxOutput: 128, tools: true, images: false, seed: true, cache: 'none' });
  const frame = (index: number, id = `call-${String(index)}`) => ({ choices: [{ delta: { tool_calls: [{ index, id, function: { name: 'tool', arguments: '{}' } }] } }] });
  assert.ok(!state.consume(frame(0, 'x'.repeat(settings.identityBytes + 1))).ok);
  for (let index = 0; index < settings.calls; index += 1) assert.ok(state.consume(frame(index)).ok);
  assert.ok(!state.consume(frame(settings.calls)).ok);
  assert.ok(state.consume(frame(0)).ok);
});
