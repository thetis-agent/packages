/** Probe mutation invariants across seeds and overlapping vocabulary; SK-013, EV-001. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutate, vocabulary } from './mutate.ts';
import type { Task } from '@/lib/evaluation/index.ts';

const task: Task = { id: 'task', family: 'skill', request: 'Alice performs careful surgery with 12 files at {path}; malice stays.', mutable: { names: ['Alice', 'careful', 'surgery'], numbers: ['12'], path: 'path' }, requires: [], required: [], gold: { tools: [], skills: [] }, budget: { cost: 1, iterations: 3 }, checks: 'private/checks', fixture: 'fixture' };
await test('SK-013 mutator property: every seed preserves card vocabulary and is reproducible', () => {
  const stoplist = vocabulary([{ name: 'careful', description: 'surgery', tags: [] }]); assert.ok(stoplist.ok);
  for (let run = 0; run < 256; run++) {
    const a = mutate(task, 'private-seed', run, stoplist.value); const b = mutate(task, 'private-seed', run, stoplist.value);
    assert.ok(a.ok); assert.deepEqual(a, b); assert.notEqual(a.value.request, task.request);
    assert.match(a.value.request, /careful surgery/u); assert.match(a.value.request, /malice stays/u); assert.ok(!a.value.request.includes('Alice'));
  }
  assert.notDeepEqual(mutate(task, 'private-seed', 1, stoplist.value), mutate(task, 'private-seed', 2, stoplist.value));
});
await test('EV-001 unmutatable tasks and oversized inputs are refused rather than running originals', () => {
  const unchanged = mutate({ ...task, mutable: { names: ['careful'] } }, 'seed', 0, new Set(['careful']));
  assert.ok(!unchanged.ok); assert.equal(unchanged.error.code, 'invalid-args');
  const oversized = mutate({ ...task, request: 'x'.repeat(65537) }, 'seed', 0, new Set());
  assert.ok(!oversized.ok); assert.equal(oversized.error.code, 'budget');
});
await test('EV-001 declared names retain distinct identities across large mutation cards', () => {
  const names = Array.from({ length: 100 }, (_, index) => `Name${String(index)}`);
  const result = mutate({ ...task, request: names.join(' '), mutable: { names } }, 'seed', 0, new Set()); assert.ok(result.ok);
  assert.equal(new Set(Object.values(result.value.replacements)).size, names.length);
});
