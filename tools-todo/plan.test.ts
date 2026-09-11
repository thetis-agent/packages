/** The plan's own rules, which is where every decision this package makes actually lives. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { add, empty, limits, mark, order, progress, render, write } from './plan.ts';

const bounds = { ...limits, items: 4, textLength: 16 };

await test('a written plan replaces what was there and keeps minting fresh ids', () => {
  const first = write(empty(), ['one', 'two'], bounds);
  assert.deepEqual(first.items.map(item => item.id), ['t-1', 't-2']);
  const second = write(first, ['three'], bounds);
  // The ids carry on rather than starting again: a person who ticked t-1 must not see a different
  // line called t-1 the next time the agent changes its mind.
  assert.deepEqual(second.items.map(item => item.id), ['t-3']);
  assert.deepEqual(second.items.map(item => item.text), ['three']);
});

await test('items arrive as plain strings or as rows with a stage and a note', () => {
  const plan = write(empty(), ['plain', { text: 'in hand', stage: 'active', note: 'halfway' }, { text: 'done', stage: 'done' }, { stage: 'done' }], bounds);
  assert.deepEqual(plan.items.map(item => item.stage), ['pending', 'active', 'done']);
  assert.equal(plan.items[1]?.note, 'halfway');
  assert.equal(plan.items[0]?.note, undefined);
});

await test('a line is one bounded line, whatever was sent', () => {
  const plan = write(empty(), ['  a\n  very  long   line that runs past the bound  '], bounds);
  assert.equal(plan.items[0]?.text, 'a very long line');
});

await test('the plan refuses to grow past its bound rather than forgetting its top', () => {
  const plan = add(write(empty(), ['one', 'two'], bounds), ['three', 'four', 'five'], bounds);
  assert.equal(plan.items.length, bounds.items);
  assert.equal(plan.items[0]?.text, 'one');
});

await test('only one item is in hand at a time', () => {
  const plan = mark(mark(write(empty(), ['one', 'two'], bounds), ['t-1'], 'active'), ['t-2'], 'active');
  assert.deepEqual(plan.items.map(item => item.stage), ['pending', 'active']);
});

await test('marking done leaves every other line where it was, and counts', () => {
  const plan = mark(write(empty(), ['one', 'two', 'three'], bounds), ['t-1', 't-3'], 'done');
  assert.deepEqual(progress(plan), { done: 2, total: 3 });
  assert.equal(plan.items[1]?.stage, 'pending');
});

await test('a partial order moves what it names and keeps the rest', () => {
  const plan = order(write(empty(), ['one', 'two', 'three'], bounds), ['t-3', 'nothing']);
  assert.deepEqual(plan.items.map(item => item.text), ['three', 'one', 'two']);
});

await test('the model reads a checkbox list with the ids it must name to change one', () => {
  const plan = mark(write(empty(), ['one', 'two'], bounds), ['t-1'], 'done');
  assert.match(render(plan), /^The plan \(1 of 2 done\):\n\[x\] t-1 one\n\[ \] t-2 two$/u);
  assert.equal(render(empty()), 'The plan is empty.');
});
