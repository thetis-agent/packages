/** Pin every turn-event-to-wire-frame mapping against hand-built envelopes; ADR 0019, KS-020. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render, limits } from './render.ts';
import type { EventBatch } from './render.ts';
import type * as TurnEvents from '@/contracts/turn-events/types.ts';

const conversation = 'c1';
function envelope(type: TurnEvents.Envelope['type'], payload: Record<string, unknown>): TurnEvents.Envelope {
  return { type, conversation, turn: 1, iteration: 1, seq: 1, payload };
}
function batch(...events: TurnEvents.Envelope[]): EventBatch { return { conversation, events }; }

await test('token batches into a single delta frame, unchanged (KS-020)', () => {
  const frames = render(batch(envelope('token', { text: 'Hel' }), envelope('token', { text: 'lo' })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'delta', text: 'Hello' }]);
});

await test('output renders an assistant frame with usage', () => {
  const frames = render(batch(envelope('output', { message: { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }], source: 'model' }, usage: { in: 1, out: 2 } })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'assistant', text: 'Hi.', usage: { in: 1, out: 2 } }]);
});

await test('end renders a turn-finished frame, unchanged', () => {
  const frames = render(batch(envelope('end', { reason: 'answer', iterations: 3, compactions: 0 })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'turn-finished', stopped_by: 'answer', iterations: 3, compactions: 0 }]);
});

await test('end preserves an optional code field when present', () => {
  const frames = render(batch(envelope('end', { reason: 'crash', iterations: 1, compactions: 0, code: 'io' })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'turn-finished', stopped_by: 'crash', iterations: 1, compactions: 0, code: 'io' }]);
});

await test('input renders a user frame', () => {
  const frames = render(batch(envelope('input', { text: 'Hello there', attachments: [] })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'user', text: 'Hello there' }]);
});

/* A turn that carried images must still show them when the conversation is reopened, so the projection
 * has to survive: the recorded input names a file under the person's own state, and the frame has to name
 * something a browser can ask for instead. The address is minted here because this is the only place that
 * knows both halves of it; everything else about the row is checked rather than trusted, because a
 * conversation's recorded events outlive whatever wrote them. */
const stored = `${'ab'.repeat(32)}.png`;
function attachment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'sunset.png', mime: 'image/png', bytes: 2048, hash: `sha256:${'ab'.repeat(32)}`, path: `/state/attachments/${conversation}/${stored}`, ...over };
}

await test('an input that carried images renders them beside the text, addressed where the surface can fetch them', () => {
  const frames = render(batch(envelope('input', { text: 'look at this', attachments: [attachment()] })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'user', text: 'look at this',
    attachments: [{ name: 'sunset.png', mime: 'image/png', bytes: 2048, url: `./api/attachments/${conversation}/${stored}` }] }]);
});

await test('a message that was nothing but images still renders them', () => {
  const frames = render(batch(envelope('input', { text: '', attachments: [attachment(), attachment({ name: 'other.png' })] })));
  const frame = frames[0]; assert.ok(frame);
  assert.equal(frame['text'], '');
  assert.ok(Array.isArray(frame['attachments'])); assert.equal(frame['attachments'].length, 2);
});

await test('a recorded attachment this gateway could not have written, or would not serve, is dropped rather than linked to', () => {
  const bad = [
    attachment({ path: '/etc/passwd' }),
    attachment({ path: `/state/attachments/${conversation}/notes.txt` }),
    attachment({ path: `/state/attachments/${conversation}/${stored}`, mime: 'image/svg+xml' }),
    attachment({ path: 42 }),
    'not an attachment at all',
  ];
  const frames = render(batch(envelope('input', { text: 'hi', attachments: bad })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'user', text: 'hi' }],
    'nothing survivable means no attachments field at all, so the transcript draws the row it always drew.');
});

await test('a recorded input with more images than may be attached renders only as many as may be', () => {
  const many = Array.from({ length: 20 }, (_, index) => attachment({ name: `n${String(index)}.png` }));
  const frame = render(batch(envelope('input', { text: 'hi', attachments: many })))[0]; assert.ok(frame);
  assert.ok(Array.isArray(frame['attachments'])); assert.equal(frame['attachments'].length, 8);
});

await test('an attachment name longer than a name is cut to one, and a missing one falls back to the stored file', () => {
  const frame = render(batch(envelope('input', { text: 'hi', attachments: [attachment({ name: 'x'.repeat(500) }), attachment({ name: 7 })] })))[0];
  assert.ok(frame); assert.ok(Array.isArray(frame['attachments']));
  const shown: unknown[] = frame['attachments'];
  const long: unknown = shown[0]; const absent: unknown = shown[1];
  assert.ok(isRecord(long) && typeof long['name'] === 'string' && long['name'].length === limits.nameLength);
  assert.ok(isRecord(absent)); assert.equal(absent['name'], stored);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

await test('a call envelope without ok renders a tool-call frame (request)', () => {
  const frames = render(batch(envelope('call', {
    id: 'call-1', name: 'read_file', args: { path: '/a' }, deadlineMs: 1000,
    mode: { readOnly: true, deny: [] }, roots: [], budget: { resultBytes: 1024 },
  })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'tool-call', id: 'call-1', name: 'read_file', args: { path: '/a' } }]);
});

await test('a call envelope with ok:true renders a tool-result frame carrying the answer text', () => {
  const frames = render(batch(envelope('call', { id: 'call-1', ok: true, content: [{ type: 'text', text: 'contents' }] })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'tool-result', id: 'call-1', ok: true, summary: 'contents' }]);
});

await test('a call envelope with ok:false renders a tool-result frame carrying the error message', () => {
  const frames = render(batch(envelope('call', { id: 'call-1', ok: false, error: { code: 'not-found', message: 'The file does not exist.' } })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'tool-result', id: 'call-1', ok: false, summary: 'The file does not exist.' }]);
});

await test('a tool-result summary is capped at limits.summaryBytes', () => {
  const long = 'x'.repeat(limits.summaryBytes + 500);
  const frames = render(batch(envelope('call', { id: 'call-1', ok: true, content: [{ type: 'text', text: long }] })));
  assert.equal(frames.length, 1);
  const [frame] = frames; assert.ok(frame);
  assert.equal(Buffer.byteLength(String(frame['summary']), 'utf8'), limits.summaryBytes);
});

await test('notice renders a note frame', () => {
  const frames = render(batch(envelope('notice', { source: 'skill', content: [{ type: 'text', text: 'Watch out.' }] })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'note', text: 'Watch out.' }]);
});

await test('model.event delta.reasoning batches into a single reasoning frame', () => {
  const frames = render(batch(
    envelope('model.event', { event: { type: 'delta.reasoning', text: 'Think' } }),
    envelope('model.event', { event: { type: 'delta.reasoning', text: 'ing.' } }),
  ));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'reasoning', text: 'Thinking.' }]);
});

await test('model.event variants other than delta.reasoning render nothing', () => {
  const frames = render(batch(envelope('model.event', { event: { type: 'start', id: 'r1', model: 'x' } })));
  assert.deepEqual(frames, []);
});

await test('interleaved reasoning and token deltas flush in arrival order, each as its own frame', () => {
  const frames = render(batch(
    envelope('model.event', { event: { type: 'delta.reasoning', text: 'thinking' } }),
    envelope('token', { text: 'answer' }),
    envelope('model.event', { event: { type: 'delta.reasoning', text: 'more' } }),
  ));
  assert.deepEqual(frames, [
    { type: 'event', session: conversation, kind: 'reasoning', text: 'thinking' },
    { type: 'event', session: conversation, kind: 'delta', text: 'answer' },
    { type: 'event', session: conversation, kind: 'reasoning', text: 'more' },
  ]);
});

await test('a trailing batched delta and reasoning both flush at the end of the batch', () => {
  const frames = render(batch(envelope('token', { text: 'tail' }), envelope('model.event', { event: { type: 'delta.reasoning', text: 'trail' } })));
  assert.deepEqual(frames, [
    { type: 'event', session: conversation, kind: 'delta', text: 'tail' },
    { type: 'event', session: conversation, kind: 'reasoning', text: 'trail' },
  ]);
});

/* The regression that widening lib/session/schema.json first exposed. core emits one `model.event`
 * per provider event, so once those reached the gateway a token run interleaved with them flushed
 * after every single token: one `delta` frame per token instead of one per batch (KS-020). The
 * non-reasoning branch must skip without reaching flush(). */
await test('a non-reasoning model.event does not break token batching (KS-020)', () => {
  const frames = render(batch(
    envelope('token', { text: 'Hel' }),
    envelope('model.event', { event: { type: 'delta.text', text: 'Hel' } }),
    envelope('token', { text: 'lo' }),
    envelope('model.event', { event: { type: 'delta.text', text: 'lo' } })
  ));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'delta', text: 'Hello' }]);
});

await test('a reasoning model.event still batches into one reasoning frame, after the delta', () => {
  const frames = render(batch(
    envelope('token', { text: 'Hi' }),
    envelope('model.event', { event: { type: 'delta.reasoning', text: 'th' } }),
    envelope('model.event', { event: { type: 'delta.reasoning', text: 'ink' } })
  ));
  assert.deepEqual(frames, [
    { type: 'event', session: conversation, kind: 'delta', text: 'Hi' },
    { type: 'event', session: conversation, kind: 'reasoning', text: 'think' }
  ]);
});

/* The four kinds the Context and Tools inspectors read. Shapes are the ones those panels were built
 * and tested against; the panel's own fixtures are validated against contract/turn-events, so these
 * assertions and those fixtures answer to the same authority from opposite sides of the wire. */
await test('context projects its section split and budget verbatim', () => {
  const sections = { system: [], skills: [], harness: [], history: [] };
  const budget = { window: 24000, reserve: 5600, used: 18400 };
  const frames = render(batch(envelope('context', { sections, budget })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'context', sections, budget }]);
});

await test('offer projects the tool table and the mode that narrowed it', () => {
  const tools = [{ name: 'read_path', description: 'Read lines from a file.', schema: {}, readOnly: true, endsTurn: false, source: 'tools-files@1.0.0' }];
  const mode = { readOnly: true, deny: ['tools-files/write_path'] };
  const frames = render(batch(envelope('offer', { tools, mode })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'offer', tools, mode }]);
});

await test('model.begin projects the exact provider request, hyphenated as model-begin', () => {
  const request = [{ type: 'begin', model: 'claude-opus-5', options: {} }];
  const frames = render(batch(envelope('model.begin', { provider: 'openai-compatible', model: 'claude-opus-5', request })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'model-begin', provider: 'openai-compatible', model: 'claude-opus-5', request }]);
});

await test('model.end projects the usage counters the ledger reads', () => {
  const frames = render(batch(envelope('model.end', { stop: 'end', usage: { cost: 0.42, in: 18400, out: 2100 } })));
  assert.deepEqual(frames, [{ type: 'event', session: conversation, kind: 'model-end', stop: 'end', usage: { cost: 0.42, in: 18400, out: 2100 } }]);
});

await test('an inspector frame still flushes the token run that preceded it, keeping reading order', () => {
  const frames = render(batch(envelope('token', { text: 'Hi' }), envelope('model.end', { stop: 'end', usage: {} })));
  assert.deepEqual(frames, [
    { type: 'event', session: conversation, kind: 'delta', text: 'Hi' },
    { type: 'event', session: conversation, kind: 'model-end', stop: 'end', usage: {} }
  ]);
});
