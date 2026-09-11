/** Guard the per-turn and per-conversation usage arithmetic the transcript chip reads; contract/turn-events, ADR 0019.
 *
 * One turn makes one `model.end` per model round trip, so the number a person sees is a sum this
 * surface computed, not a number the host sent — which makes the summing worth pinning. So is the
 * wording: `stop` reasons reach the wire in the provider's own vocabulary and a person should never
 * read `content_filter`, and a cost may be absent entirely, in which case the chip must show tokens
 * rather than a price nobody reported.
 *
 * Loaded the way dispatch.test.ts loads its module — a dynamic import taken as `unknown` and narrowed
 * — because `assets/lib/usage.js` is browser JavaScript the surface serves as an asset, with no build
 * step. It touches no DOM on purpose, which is what lets every branch below run under `node --test`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

type Counters = Record<string, number>;
type Turn = { calls: number; counters: Counters; stop: string };
type Total = { turns: number; calls: number; counters: Counters };
type Ledger = {
  blankTurn: () => Turn;
  blankTotal: () => Total;
  addCall: (turn: Turn, usage: unknown, stop: unknown) => Turn;
  addTurn: (total: Total, turn: Turn) => Total;
  turnSummary: (turn: Turn, end?: Record<string, unknown>) => string[];
  conversationSummary: (total: Total) => { text: string; detail: string } | null;
  stopNote: (stop: unknown) => string;
  count: (value: number) => string;
  money: (value: number) => string;
};

const here = dirname(fileURLToPath(import.meta.url));
const loaded: unknown = await import(pathToFileURL(join(here, 'assets/lib/usage.js')).href);
assert.ok(isObject(loaded), 'assets/lib/usage.js should load as a module namespace object.');
for (const name of ['blankTurn', 'blankTotal', 'addCall', 'addTurn', 'turnSummary', 'conversationSummary', 'stopNote', 'count', 'money']) {
  assert.equal(typeof loaded[name], 'function', `assets/lib/usage.js should export ${name} as a function.`);
}
const usage = loaded as unknown as Ledger;

/** A turn of `n` model round trips, each reporting the same counters. */
function turnOf(rounds: readonly { usage: Counters; stop: string }[]): Turn {
  return rounds.reduce((turn, round) => usage.addCall(turn, round.usage, round.stop), usage.blankTurn());
}

await test('a turn with several model round trips sums their counters into one reading', () => {
  const turn = turnOf([
    { usage: { in: 1200, out: 40, cost: 0.01 }, stop: 'tool_calls' },
    { usage: { in: 1800, out: 60, cost: 0.02 }, stop: 'tool_calls' },
    { usage: { in: 2000, out: 500, cost: 0.03 }, stop: 'end' },
  ]);
  assert.equal(turn.calls, 3);
  assert.deepEqual(turn.counters, { in: 5000, out: 600, cost: 0.06 });
  const parts = usage.turnSummary(turn, { iterations: 3, compactions: 0 });
  assert.deepEqual(parts, ['3 steps', '5k tokens in', '600 out', '$0.06 this turn']);
});

/** The chip is drawn once, on `turn-finished`; nine round trips must not become nine chips, which is
 *  the whole reason the counters are summed here rather than rendered per frame. */
await test('nine model round trips still produce one chip', () => {
  const turn = turnOf(Array.from({ length: 9 }, () => ({ usage: { in: 100, out: 10 }, stop: 'tool_calls' })));
  assert.equal(turn.calls, 9);
  const parts = usage.turnSummary(turn, { iterations: 9, compactions: 0 });
  assert.equal(parts.filter(part => part.includes('tokens in')).length, 1);
  assert.deepEqual(parts, ['9 steps', '900 tokens in', '90 out']);
});

/** Counters are an open map per contract/turn-events `$defs/modelEnd`; a provider naming something
 *  this surface has never heard of must still be added up rather than dropped or crashed on. */
await test('counters this surface does not name are summed anyway, and non-numbers are ignored', () => {
  const turn = turnOf([
    { usage: { in: 10, cached: 5, reasoning: 2 }, stop: 'end' },
    { usage: { in: 10, cached: 5, nonsense: Number.NaN } as Counters, stop: 'end' },
  ]);
  assert.deepEqual(turn.counters, { in: 20, cached: 10, reasoning: 2 });
});

await test('a turn whose provider reported no price shows tokens and no price at all', () => {
  const turn = turnOf([{ usage: { in: 4000, out: 250, cost: 0 }, stop: 'end' }]);
  const parts = usage.turnSummary(turn, { iterations: 1, compactions: 0 });
  assert.deepEqual(parts, ['1 step', '4k tokens in', '250 out']);
  assert.ok(!parts.some(part => part.includes('$')), 'no price may appear when the provider reported none.');
});

await test('a turn that reached no model at all draws nothing', () => {
  assert.deepEqual(usage.turnSummary(usage.blankTurn(), { iterations: 0, compactions: 0 }), []);
});

await test('compactions are reported in words, and only when there were any', () => {
  const turn = turnOf([{ usage: { in: 1, out: 1 }, stop: 'end' }]);
  assert.ok(!usage.turnSummary(turn, { iterations: 1, compactions: 0 }).some(part => part.includes('summarised')));
  assert.ok(usage.turnSummary(turn, { iterations: 1, compactions: 1 }).includes('summarised once to save room'));
  assert.ok(usage.turnSummary(turn, { iterations: 1, compactions: 3 }).includes('summarised 3 times to save room'));
});

/** An ordinary finish already said "done" by arriving; the stop reasons that are not ordinary are the
 *  ones a person needs, and none of them may reach the screen in the provider's spelling. */
await test('stop reasons read as plain words, and ordinary finishes say nothing', () => {
  for (const quiet of ['end', 'tool_calls', 'cancel', '', undefined, 42]) assert.equal(usage.stopNote(quiet), '');
  assert.equal(usage.stopNote('length'), "cut off at the model's length limit");
  assert.equal(usage.stopNote('refusal'), 'the model declined to answer');
  assert.equal(usage.stopNote('content_filter'), "stopped by the model's safety filter");
  assert.equal(usage.stopNote('something_new'), 'ended early — something_new');
});

await test('a turn that ended abnormally carries the reason into its chip, even several rounds later', () => {
  const turn = turnOf([
    { usage: { in: 10, out: 10 }, stop: 'tool_calls' },
    { usage: { in: 10, out: 10 }, stop: 'length' },
    { usage: { in: 10, out: 10 }, stop: 'tool_calls' },
  ]);
  assert.equal(turn.stop, 'length', 'a clean round must not overwrite the reason a previous one stopped for.');
  assert.ok(usage.turnSummary(turn, { iterations: 3, compactions: 0 }).includes("cut off at the model's length limit"));
});

await test('a conversation total accumulates the turns folded into it and reads as one calm line', () => {
  let total = usage.blankTotal();
  assert.equal(usage.conversationSummary(total), null, 'a conversation nothing was spent on shows nothing.');
  total = usage.addTurn(total, turnOf([{ usage: { in: 12000, out: 3000, cost: 0.4 }, stop: 'end' }]));
  total = usage.addTurn(total, turnOf([{ usage: { in: 6400, out: 100, cost: 0.1 }, stop: 'end' }]));
  assert.equal(total.turns, 2); assert.equal(total.calls, 2);
  const summary = usage.conversationSummary(total); assert.ok(summary);
  assert.equal(summary.text, '21.5k tokens · $0.50');
  assert.equal(summary.detail, '18.4k in, 3.1k out over 2 turns, counted since this page opened');
});

await test('counts and prices are rounded for reading, and a fraction of a cent is not rounded away to free', () => {
  assert.equal(usage.count(0), '0'); assert.equal(usage.count(999), '999'); assert.equal(usage.count(1000), '1k');
  assert.equal(usage.count(18449), '18.4k'); assert.equal(usage.count(2100000), '2.1M');
  assert.equal(usage.money(0), ''); assert.equal(usage.money(-1), '');
  assert.equal(usage.money(0.42), '$0.42'); assert.equal(usage.money(0.0004), '$0.0004');
});

/** The ledger is read straight out of the store and must never be written through: app.js keeps one
 *  shared empty ledger for every unspent conversation, the way activity.js keeps one IDLE. */
await test('folding never writes through to the ledger it was given', () => {
  const turn = usage.blankTurn(); const total = usage.blankTotal();
  usage.addTurn(usage.addTurn(total, usage.addCall(turn, { in: 5 }, 'end')), turn);
  assert.deepEqual(turn, { calls: 0, counters: {}, stop: '' });
  assert.deepEqual(total, { turns: 0, calls: 0, counters: {} });
});
