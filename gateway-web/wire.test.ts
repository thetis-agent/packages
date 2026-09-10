/** Pin the hello->user reply shape service.test.ts freezes, plus the env.status/env.reset capability
 * gate; KS-004, KS-019, ADR 0038 D4/D2. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Peer } from '@/lib/socket/index.ts';
import type { Handler } from '@/lib/socket/index.ts';
import type { Method, ConnectKernel } from '@/contracts/kernel-socket/types.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { socketPair } from '@/test/socket-pair.ts';
import { Wire } from './wire.ts';

async function fixture(handlers: ReadonlyMap<Method, Handler>, capabilities: readonly string[] = [], role = 'user') {
  const pair = await socketPair(); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const callbacks = { note: () => Promise.resolve({ ok: true as const, value: undefined }) };
  const peer = new Peer(pair.client, schemas, clock, capabilities, { ...callbacks, handlers: new Map() });
  const kernel = new Peer(pair.peer, schemas, clock, [...handlers.keys()], { ...callbacks, handlers });
  const accepted = kernel.accept({ person: 'alice', scope: 'person', generation: 1 });
  const connected = await peer.connect(); assert.ok(connected.ok); assert.ok((await accepted).ok);
  const identity: ConnectKernel = { v: '1', capabilities: [], person: 'alice', scope: 'person' };
  const sent: Record<string, unknown>[] = [];
  const wire = new Wire(peer, schemas, clock, identity, role, frame => { sent.push(frame); return Promise.resolve({ ok: true, value: undefined }); });
  return {
    wire, sent, clock,
    async close() { wire.close(); peer.close(); kernel.close(); await Promise.all([peer.finished(), kernel.finished()]); await pair.close(); },
  };
}

await test('hello replies with a user frame carrying the identity name and role, mirroring service.test.ts\'s frozen assertion', async () => {
  const f = await fixture(new Map());
  try {
    const result = await f.wire.command({ type: 'hello' }); assert.ok(result.ok);
    assert.equal(f.sent.length, 1);
    const [frame] = f.sent; assert.ok(frame);
    assert.equal(frame['type'], 'user');
    assert.deepEqual(frame['user'], { name: 'alice', role: 'user' });
    assert.ok(Array.isArray(frame['capabilities']));
  } finally { await f.close(); }
});

await test('a closed wire refuses every command', async () => {
  const f = await fixture(new Map());
  try { f.wire.close(); const result = await f.wire.command({ type: 'hello' }); assert.ok(!result.ok); assert.equal(result.error.code, 'switching'); }
  finally { await f.close(); }
});

await test('an unrecognised command type is refused before it can reach the peer', async () => {
  const f = await fixture(new Map());
  try { const result = await f.wire.command({ type: 'nonsense' }); assert.ok(!result.ok); assert.equal(result.error.code, 'unsupported'); }
  finally { await f.close(); }
});

await test('open without a conversation id is refused', async () => {
  const f = await fixture(new Map());
  try { const result = await f.wire.command({ type: 'open' }); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args'); }
  finally { await f.close(); }
});

await test('a turn without text is refused before any subscription is attempted', async () => {
  const f = await fixture(new Map());
  try { const result = await f.wire.command({ type: 'send', id: 'c1' }); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args'); }
  finally { await f.close(); }
});

await test('attachments are refused as unsupported before any subscription is attempted', async () => {
  const f = await fixture(new Map());
  try {
    const result = await f.wire.command({ type: 'send', id: 'c1', text: 'hi', attachments: [{}] });
    assert.ok(!result.ok); assert.equal(result.error.code, 'unsupported');
  } finally { await f.close(); }
});

await test('list forwards to session.list and renders a sessions frame', async () => {
  const f = await fixture(new Map<Method, Handler>([['session.list', () => Promise.resolve({ ok: true, value: [{ id: 'c1' }] })]]), ['session.list']);
  try {
    const result = await f.wire.command({ type: 'list' }); assert.ok(result.ok);
    assert.deepEqual(f.sent.at(-1), { type: 'sessions', sessions: [{ id: 'c1' }] });
  } finally { await f.close(); }
});

await test('env-reset is refused as unsupported when the kernel has not negotiated env.reset (today\'s seam)', async () => {
  const f = await fixture(new Map());
  try { const result = await f.wire.command({ type: 'env-reset' }); assert.ok(!result.ok); assert.equal(result.error.code, 'unsupported'); }
  finally { await f.close(); }
});

await test('env-reset resets and replies with a fresh env-status frame once the kernel negotiates both capabilities', async () => {
  const f = await fixture(new Map<Method, Handler>([
    ['env.reset', () => Promise.resolve({ ok: true, value: undefined })],
    ['env.status', () => Promise.resolve({ ok: true, value: { target: 'work', ready: true, generation: 3, state: 'READY' } })],
  ]), ['env.reset', 'env.status']);
  try {
    const result = await f.wire.command({ type: 'env-reset' }); assert.ok(result.ok);
    assert.deepEqual(f.sent.at(-1), { type: 'env-status', target: 'work', ready: true, generation: 3, state: 'READY' });
  } finally { await f.close(); }
});

await test('an unhealthy env-status carries the kernel-provided reason verbatim', async () => {
  const f = await fixture(new Map<Method, Handler>([
    ['env.reset', () => Promise.resolve({ ok: true, value: undefined })],
    ['env.status', () => Promise.resolve({ ok: true, value: { target: 'work', ready: false, generation: 2, state: 'FAILED', reason: 'The environment could not start: disk quota exceeded.' } })],
  ]), ['env.reset', 'env.status']);
  try {
    const result = await f.wire.command({ type: 'env-reset' }); assert.ok(result.ok);
    assert.deepEqual(f.sent.at(-1), { type: 'env-status', target: 'work', ready: false, generation: 2, state: 'FAILED', reason: 'The environment could not start: disk quota exceeded.' });
  } finally { await f.close(); }
});
