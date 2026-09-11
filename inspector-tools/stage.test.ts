/** Guard what this package answers when its own panel asks; contract/surface, ADR 0051.
 *
 * The route a request travels to get here is gateway-web/surface-request.test.ts and
 * core/surface-command.test.ts. What is checked here is the package's own two hooks: that the tally
 * counts finished calls and nothing else, that it is bounded, and that the only name it answers to
 * is the one verb its manifest declares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { CallRequest, Envelope } from '@/contracts/turn-events/types.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Surface } from '@/contracts/surface/types.ts';
import { stages, limits } from './index.ts';

const request = (name: string): CallRequest => ({ id: `id-${name}`, name, args: {}, deadlineMs: 1, mode: { readOnly: false, deny: [] }, roots: [], budget: { resultBytes: 1 } });
const finished = (name: string): Envelope => ({ type: 'call', conversation: 'c1', turn: 1, iteration: 1, seq: 1, payload: { request: { name }, answer: { id: 'x', ok: true } } });
const tally = (): Record<string, number> => {
  const answer = stages.call(request('usage'));
  assert.ok(answer.ok);
  return Object.fromEntries(Object.entries(answer.data ?? {}).map(([name, value]) => [name, Number(value)]));
};

await test('the declared verb is the only name this package answers to', () => {
  for (const name of ['delete', 'Usage', '', 'usage2']) {
    const refused = stages.call(request(name));
    assert.equal(refused.ok, false, name); assert.ok(refused.error);
    assert.equal(refused.error.code, 'not-offered');
    assert.equal(refused.error.message, 'That panel is not allowed to do this.');
  }
  assert.equal(stages.call(request('usage')).ok, true);
});

await test('the manifest declares exactly the verb this package answers, and offers no tool for it', async () => {
  const raw: unknown = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(isObject(raw));
  const surface = raw['surface'] as Surface;
  assert.deepEqual((surface.commands ?? []).map(command => command.verb), ['usage']);
  // No `offer` hook: the model is never told this exists, so the panel is the only route to it.
  assert.equal('offer' in stages, false);
});

await test('a finished call is counted once, per name, across every conversation in the environment', () => {
  const before = tally();
  stages.observe(finished('read')); stages.observe(finished('read'));
  stages.observe({ ...finished('write'), conversation: 'c2' });
  const after = tally();
  assert.equal((after['read'] ?? 0) - (before['read'] ?? 0), 2);
  assert.equal((after['write'] ?? 0) - (before['write'] ?? 0), 1);
});

await test('an envelope that is not a finished call, or carries no name, changes nothing', () => {
  const before = tally();
  stages.observe({ type: 'token', conversation: 'c1', turn: 1, iteration: 1, seq: 1, payload: { text: 'hi' } });
  stages.observe({ type: 'call', conversation: 'c1', turn: 1, iteration: 1, seq: 1, payload: { answer: { id: 'x', ok: true } } });
  stages.observe({ type: 'call', conversation: 'c1', turn: 1, iteration: 1, seq: 1, payload: { request: { name: 2 } } });
  assert.deepEqual(tally(), before);
});

await test('the tally is bounded, so a package that invents names cannot grow it without end', () => {
  for (let index = 0; index <= limits.tools + 8; index++) stages.observe(finished(`invented-${String(index)}`));
  assert.equal(Object.keys(tally()).length, limits.tools);
});
