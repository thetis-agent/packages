/* Branch coverage for assets/lib/activity.js, the one piece of the served UI
 * that is pure enough to test.
 *
 * Run as a child process by activity.test.ts rather than imported from it: the
 * served assets are plain ES modules with no declarations, and this repository
 * type-checks `.ts` only (tsconfig.base.json has no `allowJs`), so a `.ts` test
 * cannot import one without a silencing cast the house rules forbid. Node runs
 * it under its own test runner; the .ts test reports what it said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE, SHEEN_MS, activeSessions, applyActivity, archivedSessions, cancelled, describeState,
  describeStep, fmtAgo, fmtDuration, mergeSessions, previewOf, sortSessions, stampOf, titleOf
} from './assets/lib/activity.js';

const second = 1000, minute = 60 * second, hour = 60 * minute, day = 24 * hour;

await test('the sheen duration matches the --sheen token app.css animates with', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./assets/theme.css', import.meta.url), 'utf8');
  const declared = /--sheen:\s*(\d+)ms/u.exec(css);
  assert.ok(declared, 'theme.css must declare --sheen.');
  assert.equal(Number(declared[1]), SHEEN_MS, 'a row phase computed against a different period drifts.');
});

await test('elapsed time and time-since each take every branch of their scale', () => {
  assert.equal(fmtDuration(-5 * second), '0s');
  assert.equal(fmtDuration(12 * second), '12s');
  assert.equal(fmtDuration(4 * minute), '4m');
  assert.equal(fmtDuration(hour + 12 * minute), '1h 12m');
  assert.equal(fmtDuration(3 * day), '3d');
  assert.equal(fmtAgo(-5 * second), 'now');
  assert.equal(fmtAgo(10 * second), 'now');
  assert.equal(fmtAgo(4 * minute), '4m');
  assert.equal(fmtAgo(3 * hour), '3h');
  assert.equal(fmtAgo(3 * day), '3d');
});

await test('a row reads its stamp, name and preview, and falls back where the host sent none', () => {
  assert.equal(stampOf({ updatedMs: 7, createdMs: 3 }), 7);
  assert.equal(stampOf({ createdMs: 3 }), 3, 'a conversation never spoken to still sorts by when it was made.');
  assert.equal(stampOf({}), 0);
  assert.equal(stampOf(undefined), 0);
  assert.equal(titleOf({ title: 'Ship the sidebar' }), 'Ship the sidebar');
  assert.equal(titleOf({ title: '' }), 'Untitled');
  assert.equal(titleOf({}), 'Untitled');
  assert.equal(titleOf(undefined), 'Untitled', 'a tab whose list reply has not landed still needs a name.');
  assert.equal(previewOf({ preview: 'Done.' }), 'Done.');
  assert.equal(previewOf({}), 'No messages yet');
  assert.equal(previewOf(undefined), 'No messages yet');
});

await test('a working row describes its step, naming a tool bare and a derived step in words', () => {
  assert.deepEqual(describeStep({ step: 'thinking', steps: 1, cost: 0 }), { label: 'Thinking', tool: null, facts: [] });
  assert.deepEqual(describeStep({ step: 'writing', steps: 0, cost: 0 }).label, 'Writing a reply');
  assert.deepEqual(describeStep({ step: 'retrieving', steps: 0, cost: 0 }).label, 'Searching memory');
  assert.deepEqual(describeStep({ steps: 0, cost: 0 }), { label: 'Starting up', tool: null, facts: [] });
  const tool = describeStep({ step: 'web-search', steps: 3, cost: 0.34 });
  assert.deepEqual(tool, { label: null, tool: 'web-search', facts: ['3 steps', '$0.34'] });
  assert.deepEqual(describeStep({ step: 'web-search', steps: 1, cost: 0.004 }).facts, [],
    'one step is not worth saying, and a cost under half a cent rounds to $0.00.');
});

await test('a row hover says what the conversation is doing, in each state', () => {
  assert.equal(describeState({ state: 'working', step: 'thinking', steps: 0, cost: 0 }), 'working — thinking');
  assert.equal(describeState({ state: 'working', step: 'web-search', steps: 0, cost: 0 }), 'working — running web-search');
  assert.equal(describeState({ state: 'failed', outcome: 'crashed' }), 'stopped: crashed');
  assert.equal(describeState({ state: 'failed', outcome: null }), 'stopped: error');
  assert.equal(describeState({ state: 'idle', outcome: 'Stopped by you' }), 'stopped by you');
  assert.equal(describeState(IDLE), null, 'an ordinary idle row has nothing extra to say.');
});

await test('every event kind this wire sends folds into a conversation activity', () => {
  const started = applyActivity(undefined, { kind: 'turn-started' }, 500);
  assert.deepEqual(started, { state: 'working', step: 'starting', steps: 0, sinceMs: 500, outcome: null, cost: 0 });
  assert.equal(applyActivity(started, { kind: 'reasoning' }, 1).step, 'thinking');
  assert.equal(applyActivity(started, { kind: 'delta' }, 1).step, 'writing');
  const called = applyActivity(started, { kind: 'tool-call', name: 'read-file' }, 1);
  assert.deepEqual([called.step, called.steps], ['read-file', 1]);
  assert.equal(applyActivity(started, { kind: 'tool-call' }, 1).step, 'thinking', 'a nameless call is still a step.');
  assert.equal(applyActivity(called, { kind: 'tool-result' }, 1).step, 'thinking');
  assert.equal(applyActivity(started, { kind: 'retrieve' }, 1).step, 'retrieving');
  const spent = applyActivity(started, { kind: 'assistant', usage: { cost: 0.25 } }, 1);
  assert.deepEqual([spent.step, spent.cost], ['writing', 0.25]);
  assert.equal(applyActivity(spent, { kind: 'assistant', usage: { tokens: 4 } }, 1).cost, 0.25,
    'usage without a cost counter must not zero the running total.');
  assert.equal(applyActivity(spent, { kind: 'assistant' }, 1).cost, 0.25);
  assert.equal(applyActivity(called, { kind: 'turn-started' }, 900).steps, 0, 'a new turn starts its tallies over.');
});

await test('a frame that says nothing about the work leaves the activity identically alone', () => {
  const held = applyActivity(undefined, { kind: 'turn-started' }, 500);
  assert.equal(applyActivity(held, { kind: 'user', text: 'hi' }, 1), held, 'returned by identity, so no redraw.');
  assert.equal(applyActivity(held, { kind: 'note' }, 1), held);
  assert.equal(applyActivity(held, { kind: 'a-kind-this-build-never-heard-of' }, 1), held);
  assert.equal(applyActivity(undefined, { kind: 'note' }, 1), IDLE);
});

await test('every end.reason lands the row where it belongs, and an unknown one fails loudly', () => {
  const working = applyActivity(undefined, { kind: 'turn-started' }, 500);
  const end = (frame) => applyActivity(working, { kind: 'turn-finished', ...frame }, 900);
  assert.deepEqual(end({ stopped_by: 'answer' }), IDLE);
  assert.deepEqual(end({ stopped_by: 'cancel' }), { ...IDLE, outcome: 'Stopped by you' });
  assert.deepEqual(end({ stopped_by: 'restart' }), { ...IDLE, outcome: 'Interrupted by a restart' });
  assert.deepEqual(end({ stopped_by: 'limit' }), { ...IDLE, state: 'failed', outcome: 'hit its step limit' });
  assert.deepEqual(end({ stopped_by: 'crash' }), { ...IDLE, state: 'failed', outcome: 'crashed' });
  assert.deepEqual(end({ stopped_by: 'crash', code: 'budget' }), { ...IDLE, state: 'failed', outcome: 'budget' },
    'a coded failure names its code rather than a generic word.');
  assert.deepEqual(end({ stopped_by: 'teleported' }), { ...IDLE, state: 'failed', outcome: 'teleported' },
    'a reason the contract has grown must not be reported as a clean answer.');
  assert.deepEqual(end({}), { ...IDLE, state: 'failed', outcome: 'error' });
  assert.deepEqual(cancelled(), { ...IDLE, outcome: 'Stopped by you' },
    'stopping from this tab settles the row exactly where a cancel frame would.');
});

await test('a stale conversation list never puts an older row back over a newer one', () => {
  const held = [{ id: 'a', title: 'New', updatedMs: 900 }, { id: 'b', title: 'B', updatedMs: 100 }];
  const stale = [{ id: 'a', title: 'Old', updatedMs: 400 }, { id: 'b', title: 'B2', updatedMs: 700 }];
  assert.deepEqual(mergeSessions(held, stale), [{ id: 'a', title: 'New', updatedMs: 900 }, { id: 'b', title: 'B2', updatedMs: 700 }]);
  assert.deepEqual(mergeSessions(held, [{ id: 'a', updatedMs: 900 }]), [{ id: 'a', updatedMs: 900 }],
    'an equal stamp takes the incoming row: the host is the authority on a tie.');
  assert.deepEqual(mergeSessions(held, [{ id: 'c' }]), [{ id: 'c' }],
    'membership comes from the reply — a row the host stopped listing is gone.');
  assert.deepEqual(mergeSessions(undefined, stale), stale);
  assert.deepEqual(mergeSessions([], []), []);
});

await test('the list orders most-recent-first and hides the archive', () => {
  const rows = [{ id: 'old', updatedMs: 100 }, { id: 'new', updatedMs: 900 }, { id: 'made', createdMs: 400 }];
  assert.deepEqual(sortSessions(rows).map((row) => row.id), ['new', 'made', 'old']);
  assert.deepEqual(sortSessions(rows).length, rows.length, 'sorting copies rather than reordering the store.');
  const mixed = [{ id: 'a' }, { id: 'b', archived: true }, { id: 'c', archived: false }];
  assert.deepEqual(activeSessions(mixed).map((row) => row.id), ['a', 'c']);
  assert.deepEqual(archivedSessions(mixed).map((row) => row.id), ['b']);
  assert.deepEqual(activeSessions(undefined), []);
  assert.deepEqual(archivedSessions(undefined), []);
});
