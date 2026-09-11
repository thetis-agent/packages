/** Exercise the Tools inspector's fold against contract-shaped offers.
 *
 * Every fixture is validated against contracts/turn-events before it is folded, so the panel is
 * tested on the contract's own shape rather than a convenient invention.
 *
 * The wire does not carry `offer` yet, and three separate gates say so: lib/session/index.ts only
 * observes `['token', 'output', 'end']`, lib/session/schema.json validates eight kinds and not this
 * one, and gateway-web/render.ts maps envelopes onto browser frames for those same eight. Contract-
 * shaped payloads are therefore the level at which this panel can honestly be verified today, and this
 * file says so rather than implying an end-to-end run nobody made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schemas } from '@/lib/schema/index.ts';
import { apply, blank, describe, forConversation, limits } from './surface/fold.js';
import type { Frame, State } from './surface/fold.js';

const schemas = new Schemas(); await schemas.load();
const validOffer = schemas.validator<Record<string, unknown>>('turn-events', 'offer');
const validTool = schemas.validator<Record<string, unknown>>('turn-events', 'toolDef');

function tool(name: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { name, description: `The ${name} tool.`, schema: { type: 'object' }, readOnly: true, endsTurn: false, source: 'tools-files@1.0.0', ...extra };
}

const offer = { mode: { readOnly: false, deny: [] }, tools: [
  tool('read_file'),
  tool('write_file', { readOnly: false, destructive: true, data: { path: 'string' } }),
  tool('web_search', { source: 'tools-exa@1.0.0', derived: true, endsTurn: true }),
] };

await test('the fixtures are the contract shapes, not this panel\'s convenience', () => {
  assert.ok(validOffer(offer));
  for (const item of offer.tools) assert.ok(validTool(item), JSON.stringify(item));
});

/** Binds a value the fold may legitimately not have yet, so the assertions below read as plain
 *  property access rather than a chain of optionals that would hide a missing branch. */
function must<Value>(value: Value | undefined): Value {
  assert.ok(value !== undefined);
  return value;
}

function folded(...frames: readonly Frame[]): State {
  const state = blank();
  for (const frame of frames) apply(state, frame);
  return state;
}

await test('an offer is grouped by the package that provides each tool, flattened or in an envelope', () => {
  const flat = describe(folded({ kind: 'offer', session: 'c1', ...offer }));
  const wrapped = describe(folded({ kind: 'offer', session: 'c1', payload: offer }));
  assert.deepEqual(flat, wrapped);
  assert.ok(flat.known);
  assert.deepEqual(flat.sources.map(group => [group.source, group.tools.map(item => item.name)]),
    [['tools-exa@1.0.0', ['web_search']], ['tools-files@1.0.0', ['read_file', 'write_file']]]);
  assert.deepEqual(flat.counts, { offered: 3, sources: 2, withheld: 0 });
});

await test('every flag a tool declares is read back, and an absent one is false rather than missing', () => {
  const tools = must(describe(folded({ kind: 'offer', session: 'c1', ...offer })).sources[1]).tools;
  assert.deepEqual(tools[0], { name: 'read_file', description: 'The read_file tool.', source: 'tools-files@1.0.0', schema: { type: 'object' }, readOnly: true, endsTurn: false, destructive: false, derived: false, data: [] });
  assert.deepEqual(must(tools[1]).data, ['path']);
  assert.equal(must(tools[1]).destructive, true);
});

await test('a tool with no source is grouped as unattributed rather than dropped', () => {
  const nameless = { mode: { readOnly: false, deny: [] }, tools: [{ ...tool('probe'), source: '' }] };
  assert.equal(must(describe(folded({ kind: 'offer', session: 'c1', ...nameless })).sources[0]).source, 'unattributed');
});

await test('before any offer the panel says it does not know, rather than saying there are none', () => {
  const described = describe(blank());
  assert.equal(described.known, false);
  assert.deepEqual(described.counts, { offered: 0, sources: 0, withheld: 0 });
});

await test('a deny entry names a withheld tool, by bare name or by source/name', () => {
  const denied = { mode: { readOnly: false, deny: ['delete_file', 'tools-files/rename_file'] }, tools: offer.tools };
  const described = describe(folded({ kind: 'offer', session: 'c1', ...denied }));
  assert.deepEqual(described.withheld.map(row => [row.name, row.entry, row.why]),
    [['delete_file', 'delete_file', 'denied'], ['rename_file', 'tools-files/rename_file', 'denied']]);
  assert.equal(described.counts.withheld, 2);
});

await test('a deny entry naming a tool that is offered anyway is not reported as withheld', () => {
  const odd = { mode: { readOnly: false, deny: ['read_file'] }, tools: offer.tools };
  assert.deepEqual(describe(folded({ kind: 'offer', session: 'c1', ...odd })).withheld, []);
});

await test('a tool offered earlier and gone once the mode turns read-only is named, with the reason', () => {
  const narrowed = { mode: { readOnly: true, deny: [] }, tools: [tool('read_file')] };
  const described = describe(folded({ kind: 'offer', session: 'c1', ...offer }, { kind: 'offer', session: 'c1', ...narrowed }));
  assert.deepEqual(described.withheld.map(row => [row.name, row.why]), [['web_search', 'gone'], ['write_file', 'read-only']]);
  assert.equal(must(must(described.withheld[1]).tool).description, 'The write_file tool.', 'the earlier definition is kept, so the row can say what it did');
});

await test('a tool that simply stops being offered is withdrawn rather than blamed on the mode', () => {
  const fewer = { mode: { readOnly: false, deny: [] }, tools: [tool('read_file')] };
  const described = describe(folded({ kind: 'offer', session: 'c1', ...offer }, { kind: 'offer', session: 'c1', ...fewer }));
  assert.deepEqual(described.withheld.map(row => row.why), ['gone', 'gone']);
});

await test('a tool named by the deny list is reported once, not twice', () => {
  const both = { mode: { readOnly: false, deny: ['write_file'] }, tools: [tool('read_file')] };
  const described = describe(folded({ kind: 'offer', session: 'c1', ...offer }, { kind: 'offer', session: 'c1', ...both }));
  assert.deepEqual(described.withheld.filter(row => row.name === 'write_file').map(row => row.why), ['denied']);
});

await test('a malformed offer changes nothing', () => {
  assert.equal(describe(folded({ kind: 'offer', session: 'c1', mode: { readOnly: true, deny: [] } })).known, false);
  assert.equal(describe(folded({ kind: 'offer', session: 'c1', tools: [{ description: 'no name' }], mode: {} })).counts.offered, 0);
  assert.equal(describe(folded({ kind: 'notice', session: 'c1', tools: offer.tools })).known, false);
});

await test('an offer with no mode reads as read-write with nothing denied, never as unknown', () => {
  const described = describe(folded({ kind: 'offer', session: 'c1', tools: [tool('read_file')] }));
  assert.deepEqual(described.mode, { readOnly: false, deny: [] });
  assert.ok(described.known);
});

await test('a deny list carrying something that is not a name is ignored', () => {
  const odd = { kind: 'offer', session: 'c1', tools: [tool('read_file')], mode: { readOnly: false, deny: ['ok', 7, null] } };
  assert.deepEqual(describe(folded(odd)).mode.deny, ['ok']);
});

await test('the offered set and the deny list are both bounded', () => {
  const many = Array.from({ length: limits.tools + 5 }, (_, index) => tool(`t${String(index)}`));
  const deny = Array.from({ length: limits.tools + 5 }, (_, index) => `d${String(index)}`);
  const described = describe(folded({ kind: 'offer', session: 'c1', mode: { readOnly: false, deny }, tools: many }));
  assert.equal(described.counts.offered, limits.tools);
  assert.equal(described.mode.deny.length, limits.tools);
  assert.equal(described.counts.withheld, limits.tools);
});

await test('conversations are remembered up to their bound, and never the one being asked for', () => {
  const states = new Map<string, State>();
  for (let index = 0; index < limits.conversations + 4; index += 1) forConversation(states, `c${String(index)}`);
  assert.equal(states.size, limits.conversations);
  const oldest = must([...states.keys()][0]);
  assert.equal(forConversation(states, oldest), states.get(oldest));
  assert.equal(states.size, limits.conversations);
});

await test('each conversation keeps its own offer', () => {
  const states = new Map<string, State>();
  apply(forConversation(states, 'c1'), { kind: 'offer', session: 'c1', ...offer });
  assert.equal(describe(forConversation(states, 'c2')).known, false);
  assert.equal(describe(forConversation(states, 'c1')).counts.offered, 3);
});
