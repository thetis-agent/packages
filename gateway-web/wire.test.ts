/** Pin the hello->user reply shape service.test.ts freezes, plus the env.status/env.reset capability
 * gate; KS-004, KS-019, ADR 0038 D4/D2. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Peer } from '@/lib/socket/index.ts';
import type { Handler } from '@/lib/socket/index.ts';
import type { Method, ConnectKernel } from '@/contracts/kernel-socket/types.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { socketPair } from '@/test/socket-pair.ts';
import { Wire } from './wire.ts';
import { Attachments } from './attachments.ts';
import { settings } from './index.ts';

async function fixture(handlers: ReadonlyMap<Method, Handler>, capabilities: readonly string[] = [], role = 'user') {
  const pair = await socketPair(); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  /* A real store on a real directory, because the attachment cases below are about what is on disk: the
   * wire believes nothing a frame says about a file, so a fake store would test the fake. */
  const root = await mkdtemp(join(tmpdir(), 'thetis-wire-')); const store = Attachments.open(root, settings); assert.ok(store.ok);
  const callbacks = { note: () => Promise.resolve({ ok: true as const, value: undefined }) };
  const peer = new Peer(pair.client, schemas, clock, capabilities, { ...callbacks, handlers: new Map() });
  const kernel = new Peer(pair.peer, schemas, clock, [...handlers.keys()], { ...callbacks, handlers });
  const accepted = kernel.accept({ person: 'alice', scope: 'person', generation: 1 });
  const connected = await peer.connect(); assert.ok(connected.ok); assert.ok((await accepted).ok);
  const identity: ConnectKernel = { v: '1', capabilities: [], person: 'alice', scope: 'person' };
  const sent: Record<string, unknown>[] = [];
  const wire = new Wire(peer, schemas, clock, identity, role, frame => { sent.push(frame); return Promise.resolve({ ok: true, value: undefined }); }, undefined, undefined, store.value);
  return {
    wire, sent, clock, store: store.value,
    async close() { wire.close(); peer.close(); kernel.close(); await Promise.all([peer.finished(), kernel.finished()]); await pair.close(); await rm(root, { recursive: true, force: true }); },
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
    assert.ok(Array.isArray(frame['capabilities']) && frame['capabilities'].includes('attach'));
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

/* The gateway used to refuse every attachment outright. It now checks them, and the check is the whole
 * of the trust boundary: the descriptors in a `send` frame were typed by a browser, so `path` is a claim
 * and not a location. These three cases are that boundary — one that passes, one that names a file the
 * person never uploaded, and one that names too many. What actually reaches `session.submit` is
 * service.test.ts's business, because it takes a real environment stream to find out. */
const conversation = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

await test('an attached image the person actually uploaded passes the check and the turn proceeds', async () => {
  /* Where it proceeds *to* is a subscription on the environment socket, which a unit test has none of —
   * so the honest assertion here is that the refusal, when it comes, is about the missing stream and not
   * about the file. service.test.ts runs the same frame against a real spawned gateway and checks what
   * actually reaches `session.submit`. */
  const f = await fixture(new Map());
  try {
    const saved = await f.store.save(conversation, 'sunset.png', 'image/png', png); assert.ok(saved.ok);
    // A lie about the size rides along, to prove the store measures rather than repeats it.
    const result = await f.wire.command({ type: 'send', id: conversation, text: 'look', attachments: [{ ...saved.value, bytes: 1 }] });
    assert.ok(!result.ok); assert.equal(result.error.code, 'outside-roots', JSON.stringify(result));
    assert.deepEqual((await f.store.accept(conversation, [{ ...saved.value, bytes: 1 }])), { ok: true, value: [saved.value] });
  } finally { await f.close(); }
});

await test('an attachment naming a file the person never uploaded is refused, in words they can act on', async () => {
  const f = await fixture(new Map());
  try {
    // One real upload first, so the conversation's own directory exists: what is being tested is the
    // refusal of a file inside a conversation that does have files, not of a conversation that has none.
    assert.ok((await f.store.save(conversation, 'real.png', 'image/png', png)).ok);
    const forged = { name: 'x.png', mime: 'image/png', bytes: 1, hash: `sha256:${'ab'.repeat(32)}`, path: '/etc/passwd' };
    const result = await f.wire.command({ type: 'send', id: conversation, text: 'hi', attachments: [forged] });
    assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
    assert.equal(result.error.message, 'That file is no longer available. Add it again.');
    const wrongType = await f.wire.command({ type: 'send', id: conversation, text: 'hi', attachments: [{ ...forged, mime: 'application/pdf' }] });
    assert.ok(!wrongType.ok); assert.equal(wrongType.error.message, 'Only images can be attached.');
    // A hash that names nothing stored is refused the same way, and never opens anything.
    const missing = await f.wire.command({ type: 'send', id: conversation, text: 'hi', attachments: [{ ...forged, path: `${'ab'.repeat(32)}.png` }] });
    assert.ok(!missing.ok); assert.equal(missing.error.code, 'invalid-args');
    assert.deepEqual(f.sent, [], 'a refused message opens nothing and announces nothing.');
  } finally { await f.close(); }
});

await test('a message naming more images than may be attached is refused before any subscription is attempted', async () => {
  const f = await fixture(new Map());
  try {
    const saved = await f.store.save(conversation, 'a.png', 'image/png', png); assert.ok(saved.ok);
    const result = await f.wire.command({ type: 'send', id: conversation, text: 'hi', attachments: Array.from({ length: settings.attachments + 1 }, () => ({ ...saved.value })) });
    assert.ok(!result.ok); assert.equal(result.error.code, 'budget');
    assert.equal(result.error.message, `You can attach up to ${String(settings.attachments)} images to a message.`);
    assert.deepEqual(f.sent, [], 'a refused message opens nothing and announces nothing.');
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
