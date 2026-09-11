/** The segment that was missing between a stage's `ctx.emit` and the turn boundary; TE-029. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Notice } from '@/contracts/turn-events/types.ts';
import { NoticeQueue, limits } from './notices.ts';

const notice = (conversation: string | undefined, text: string): Notice =>
  ({ source: 'background@1.0.0', ...(conversation === undefined ? {} : { conversation }), content: [{ type: 'text', text }] });

await test('a notice waits for the conversation it names, in the order it arrived', () => {
  const queue = new NoticeQueue();
  assert.equal(queue.add('background@1.0.0', notice('c-1', 'first')), true);
  assert.equal(queue.add('background@1.0.0', notice('c-2', 'other')), true);
  assert.equal(queue.add('background@1.0.0', notice('c-1', 'second')), true);
  assert.deepEqual(queue.take('c-1').map(held => held.notice.content[0]?.['text']), ['first', 'second']);
  // Taken once: the turn boundary that drained them is the one that wrote them into history.
  assert.deepEqual(queue.take('c-1'), []);
  assert.equal(queue.take('c-2').length, 1);
});

await test('a notice that names no conversation is dropped rather than broadcast', () => {
  const queue = new NoticeQueue();
  assert.equal(queue.add('background@1.0.0', notice(undefined, 'nowhere')), false);
  assert.equal(queue.add('background@1.0.0', notice('', 'nowhere')), false);
});

await test('both pools are bounded, and a conversation nobody opens is the one forgotten', () => {
  const queue = new NoticeQueue();
  for (let index = 0; index < limits.perConversation; index++) assert.equal(queue.add('background@1.0.0', notice('c-full', `line ${String(index)}`)), true);
  assert.equal(queue.add('background@1.0.0', notice('c-full', 'one too many')), false);
  const wide = new NoticeQueue();
  for (let index = 0; index <= limits.conversations; index++) wide.add('background@1.0.0', notice(`c-${String(index)}`, 'line'));
  assert.deepEqual(wide.take('c-0'), []);
  assert.equal(wide.take(`c-${String(limits.conversations)}`).length, 1);
});
