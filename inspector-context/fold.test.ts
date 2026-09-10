/** Exercise the Context inspector's fold against contract-shaped payloads.
 *
 * Every fixture below is validated against contracts/turn-events before it is folded, so what the
 * panel is tested on is the contract's own shape rather than a convenient invention.
 *
 * The wire does not carry `context`, `model.begin` or `model.end` yet, and three separate gates say so:
 * lib/session/index.ts only observes `['token', 'output', 'end']`, lib/session/schema.json validates
 * eight kinds and none of these, and gateway-web/render.ts maps envelopes onto browser frames for those
 * same eight. Contract-shaped payloads are therefore the level at which this panel can honestly be
 * verified today, and this file says so rather than implying an end-to-end run nobody made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schemas } from '@/lib/schema/index.ts';
import { apply, blank, describe, forConversation, limits } from './surface/fold.js';
import type { Frame, State } from './surface/fold.js';

const schemas = new Schemas(); await schemas.load();
const validContext = schemas.validator<Record<string, unknown>>('turn-events', 'context');
const validBegin = schemas.validator<Record<string, unknown>>('turn-events', 'modelBegin');
const validEnd = schemas.validator<Record<string, unknown>>('turn-events', 'modelEnd');

function said(role: string, text: string): Record<string, unknown> {
  return { role, content: [{ type: 'text', text }], source: 'core' };
}

const context = { sections: { system: [said('system', 'You are Thetis.')], skills: [], harness: [], history: [said('user', 'hello'), said('assistant', 'hi')] },
  budget: { window: 128000, reserve: 8000, used: 30000 } };

const begin = { provider: 'provider-mock', model: 'mock-1', request: [
  { type: 'begin', id: 'c1-7', model: 'mock-1', options: { maxTokens: 1024, temperature: 0.2 }, cache: { prefixThrough: 1 } },
  { type: 'message', role: 'system', content: [{ type: 'text', text: 'You are Thetis.' }] },
  { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'tool_call', id: 'k1', name: 'read_file', args: '{"path":"a"}' },
    { type: 'reasoning', text: 'thinking' }, { type: 'image', mime: 'image/png', hash: 'h', path: '/p.png' },
    { type: 'resource', path: '/r', bytes: 4 }, { type: 'artifact', path: '/a', hash: 'h' }] },
  { type: 'tool', name: 'read_file', description: 'Read a file.', schema: { type: 'object' } },
  { type: 'end' },
] };

const ended = { stop: 'end', usage: { cost: 0.0125, in: 1200, out: 300 } };

await test('the fixtures are the contract shapes, not this panel\'s convenience', () => {
  assert.ok(validContext(context));
  assert.ok(validBegin(begin));
  assert.ok(validEnd(ended));
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

await test('a context frame becomes the prompt reading, flattened or in an envelope', () => {
  const flat = describe(folded({ kind: 'context', session: 'c1', ...context })).prompt;
  const wrapped = describe(folded({ kind: 'context', session: 'c1', payload: context })).prompt;
  assert.deepEqual(flat, wrapped);
  assert.ok(flat);
  assert.deepEqual(flat.groups.map(group => [group.name, group.count]), [['system', 1], ['skills', 0], ['harness', 0], ['history', 2]]);
  assert.equal(must(flat.groups[0]).text, 'You are Thetis.');
  assert.deepEqual(flat.budget, { total: 128000, reserve: 8000, used: 30000, available: 120000, share: 0.25 });
});

await test('a budget with nothing available reports no share rather than dividing by zero', () => {
  const prompt = must(describe(folded({ kind: 'context', session: 'c1', sections: context.sections, budget: { window: 8, reserve: 8, used: 4 } })).prompt);
  assert.equal(prompt.budget.share, 0);
  assert.equal(prompt.budget.available, 0);
});

await test('a context frame without sections is ignored rather than half-read', () => {
  assert.equal(describe(folded({ kind: 'context', session: 'c1', budget: {} })).prompt, undefined);
});

await test('model.begin becomes the request reading under either kind spelling', () => {
  for (const kind of ['model-begin', 'model.begin']) {
    const request = describe(folded({ kind, session: 'c1', ...begin })).request;
    assert.ok(request, kind);
    assert.equal(request.provider, 'provider-mock');
    assert.equal(request.model, 'mock-1');
    assert.deepEqual(request.options, { maxTokens: 1024, temperature: 0.2 });
    assert.deepEqual(request.counts, { messages: 3, tools: 1 });
    assert.equal(request.hidden, 0);
    assert.deepEqual(request.messages.map(message => message.cached), [true, true, false]);
    assert.equal(request.cachedThrough, 1);
    assert.equal(must(request.tools[0]).name, 'read_file');
  }
});

await test('every content part the provider contract allows reads as something', () => {
  const text = must(must(describe(folded({ kind: 'model-begin', session: 'c1', ...begin })).request).messages[2]).text;
  assert.match(text, /→ read_file\(\{"path":"a"\}\)/u);
  assert.match(text, /thinking/u);
  assert.match(text, /\[image \/p\.png\]/u);
  assert.match(text, /\[resource \/r\]/u);
  assert.match(text, /\[artifact \/a\]/u);
});

await test('a part from a later contract major is labelled by its type rather than dropped', () => {
  const later = { ...begin, request: [{ type: 'message', role: 'user', content: [{ type: 'video', path: '/v' }] }] };
  const request = must(describe(folded({ kind: 'model-begin', session: 'c1', ...later })).request);
  assert.equal(must(request.messages[0]).text, '[video]');
});

await test('a request with no cache breakpoint says so instead of marking every row cached', () => {
  const uncached = { ...begin, request: [{ type: 'begin', id: 'c1-8', model: 'mock-1' }, { type: 'message', role: 'user', content: [] }, { type: 'end' }] };
  const request = must(describe(folded({ kind: 'model-begin', session: 'c1', ...uncached })).request);
  assert.equal(request.cachedThrough, -1);
  assert.deepEqual(request.messages.map(message => message.cached), [false]);
});

await test('a request longer than its row bound is counted, not drawn', () => {
  const many = { ...begin, request: Array.from({ length: limits.rows + 5 }, () => ({ type: 'message', role: 'user', content: [{ type: 'text', text: 'x' }] })) };
  const request = must(describe(folded({ kind: 'model-begin', session: 'c1', ...many })).request);
  assert.equal(request.counts.messages, limits.rows + 5);
  assert.equal(request.messages.length, limits.rows);
  assert.equal(request.hidden, 5);
});

await test('a message longer than the character bound is cut and says it was', () => {
  const long = { ...begin, request: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'x'.repeat(limits.chars + 10) }] }] };
  const message = must(must(describe(folded({ kind: 'model-begin', session: 'c1', ...long })).request).messages[0]);
  assert.equal(message.chars, limits.chars + 10);
  assert.ok(message.cut);
  assert.ok(message.text.length < limits.chars + 10);
});

await test('a frame the projection had to shorten says so, and one that fits does not', () => {
  const cut = describe(folded({ kind: 'model-begin', session: 'c1', ...begin, truncated: true },
    { kind: 'context', session: 'c1', ...context, truncated: true }));
  assert.equal(must(cut.request).truncated, true);
  assert.equal(must(cut.prompt).truncated, true);
  const whole = describe(folded({ kind: 'model-begin', session: 'c1', ...begin }, { kind: 'context', session: 'c1', ...context }));
  assert.equal(must(whole.request).truncated, false);
  assert.equal(must(whole.prompt).truncated, false);
});

await test('a model.begin without a request array is ignored', () => {
  assert.equal(describe(folded({ kind: 'model-begin', session: 'c1', provider: 'p', model: 'm' })).request, undefined);
});

await test('model.end accumulates the counters the provider actually reported', () => {
  for (const kind of ['model-end', 'model.end']) {
    const usage = describe(folded({ kind, session: 'c1', ...ended }, { kind, session: 'c1', stop: 'tool_calls', usage: { cost: 0.01, in: 100 } })).usage;
    assert.equal(usage.count, 2);
    assert.deepEqual(usage.counters.map(counter => counter.name), ['cost', 'in', 'out']);
    assert.equal(must(usage.counters[1]).total, 1300);
    assert.deepEqual(usage.calls.map(call => call.n), [2, 1], 'newest first');
    assert.equal(must(usage.calls[0]).stop, 'tool_calls');
  }
});

await test('a counter that is not a finite number is not summed', () => {
  const usage = describe(folded({ kind: 'model-end', session: 'c1', stop: 'end', usage: { cost: 1, bad: 'x', worse: Number.NaN } })).usage;
  assert.deepEqual(usage.counters, [{ name: 'cost', total: 1 }]);
});

await test('a model.end with no usage still counts as a call', () => {
  const usage = describe(folded({ kind: 'model-end', session: 'c1', stop: 'cancel' })).usage;
  assert.equal(usage.count, 1);
  assert.deepEqual(usage.counters, []);
  assert.equal(must(usage.calls[0]).stop, 'cancel');
});

await test('the ledger is bounded, and what it drops stays in the totals', () => {
  const frames = Array.from({ length: limits.calls + 3 }, (): Frame => ({ kind: 'model-end', session: 'c1', stop: 'end', usage: { cost: 1 } }));
  const usage = describe(folded(...frames)).usage;
  assert.equal(usage.calls.length, limits.calls);
  assert.equal(usage.forgotten, 3);
  assert.equal(usage.count, limits.calls + 3);
  assert.equal(must(usage.counters[0]).total, limits.calls + 3);
  assert.equal(must(usage.calls[0]).n, limits.calls + 3);
});

await test('a kind this panel does not fold changes nothing', () => {
  const state = folded({ kind: 'delta', session: 'c1', text: 'hi' });
  assert.deepEqual(describe(state), { request: undefined, prompt: undefined, usage: { counters: [], calls: [], forgotten: 0, count: 0 } });
});

await test('conversations are remembered up to their bound, and never the one being asked for', () => {
  const states = new Map<string, State>();
  for (let index = 0; index < limits.conversations + 4; index += 1) forConversation(states, `c${String(index)}`);
  assert.equal(states.size, limits.conversations);
  const oldest = must([...states.keys()][0]);
  const kept = forConversation(states, oldest);
  assert.equal(states.get(oldest), kept);
  assert.equal(states.size, limits.conversations);
});

await test('an existing conversation keeps its own state rather than being reset', () => {
  const states = new Map<string, State>();
  apply(forConversation(states, 'c1'), { kind: 'model-end', session: 'c1', ...ended });
  assert.equal(describe(forConversation(states, 'c1')).usage.count, 1);
});
