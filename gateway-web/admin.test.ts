/** Hold the operator seam to its two rules: every command re-checks the role server-side, and a
 * capability this deployment withheld degrades into an answer instead of a fault; ADR 0018 §3, ADR 0050. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Peer } from '@/lib/socket/index.ts';
import type { Handler } from '@/lib/socket/index.ts';
import type { Method, ConnectKernel } from '@/contracts/kernel-socket/types.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { socketPair } from '@/test/socket-pair.ts';
import { Admin, describe, sections } from './admin.ts';
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
  const send = (frame: Record<string, unknown>): Promise<{ ok: true; value: undefined }> => { sent.push(frame); return Promise.resolve({ ok: true, value: undefined }); };
  return {
    admin: new Admin(peer, role, send), wire: new Wire(peer, schemas, clock, identity, role, send), sent,
    async close() { peer.close(); kernel.close(); await Promise.all([peer.finished(), kernel.finished()]); await pair.close(); },
  };
}

/** A profile.get reply shaped like the `Setup` record a described deployment answers with. */
const setup = {
  runtime: { model: 'scripted', provider: 'provider', mode: { readOnly: true, deny: ['write'] }, maxIterations: 12,
    modelOptions: { maxTokens: 4096, temperature: 0.2 }, roots: [{ path: '/space', mode: 'rw', space: 'person' }] },
  entries: [
    { manifest: { name: 'core', version: '1.0.0', requires: { 'contract/turn-events': '^1' }, provides: {}, envelope: { spawn: { scope: 'person', network: 'none' } } } },
    { manifest: { name: 'provider-openai-compatible', version: '1.0.2', requires: {}, provides: { 'service/provider': '1.0.0' }, envelope: { spawn: { scope: 'deployment', network: 'egress' } } } },
  ]
};

await test('a profile that describes nothing produces an empty control panel rather than a refusal', () => {
  assert.deepEqual(describe({}), { packages: [] });
  assert.deepEqual(describe(undefined), { packages: [] });
  assert.deepEqual(describe({ entries: [{ manifest: { name: 'core' } }] }), { packages: [] });
});

await test('a described profile is read into the plain facts the surface shows, in name order', () => {
  const read = describe(setup);
  assert.deepEqual(read.packages.map(row => [row.name, row.version, row.scope, row.internet]), [
    ['core', '1.0.0', 'person', false],
    ['provider-openai-compatible', '1.0.2', 'deployment', true],
  ]);
  assert.deepEqual(read.model, { model: 'scripted', provider: 'provider' });
  assert.deepEqual(read.mode, { readOnly: true, deny: ['write'] });
  assert.deepEqual(read.limits, { maxIterations: 12, maxTokens: 4096, temperature: 0.2 });
  assert.deepEqual(read.spaces, [{ path: '/space', mode: 'rw', space: 'person' }]);
});

await test('a section with nothing behind it is left out of the list the surface draws', () => {
  assert.deepEqual(sections({ packages: [] }, () => false, 'admin'), []);
  assert.deepEqual(sections(describe(setup), () => false, 'admin'), ['packages', 'models', 'modes', 'limits', 'spaces']);
  assert.deepEqual(sections({ packages: [] }, method => ['env.status', 'env.logs', 'env.reset'].includes(method), 'user'),
    ['environments', 'activity', 'undo']);
});

await test('the act is offered only to a role that may review, even when the kernel negotiated both calls', () => {
  const offers = (method: string): boolean => ['default.prepare', 'default.set'].includes(method);
  assert.ok(!sections({ packages: [] }, offers, 'user').includes('updates'));
  assert.ok(sections({ packages: [] }, offers, 'reviewer').includes('updates'));
  assert.ok(sections({ packages: [] }, offers, 'admin').includes('updates'));
});

await test('every withheld capability degrades into an unsupported answer rather than a throw', async () => {
  const f = await fixture(new Map(), [], 'admin');
  try {
    for (const type of ['admin.environment', 'admin.activity', 'admin.undo', 'admin.review', 'admin.confirm',
      'admin.add', 'admin.restore-point', 'admin.tidy', 'admin.settings', 'admin.accounts']) {
      const result = await f.admin.command({ type, digest: 'release', baseline: 1 });
      assert.ok(!result.ok, `${type} should refuse when nothing behind it is negotiated.`);
      assert.equal(result.error.code, 'unsupported', `${type} refused with ${result.error.code}.`);
    }
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

await test('admin.open answers with the signed-in role and an empty section list when the kernel offers nothing', async () => {
  const f = await fixture(new Map(), [], 'reviewer');
  try {
    const result = await f.admin.command({ type: 'admin.open' }); assert.ok(result.ok);
    assert.deepEqual(f.sent.at(-1), { type: 'admin', view: 'open', role: 'reviewer', sections: [] });
  } finally { await f.close(); }
});

await test('admin.setup reads profile.get and answers with what it described', async () => {
  const f = await fixture(new Map<Method, Handler>([['profile.get', () => Promise.resolve({ ok: true, value: setup })]]), ['profile.get'], 'user');
  try {
    assert.ok((await f.admin.command({ type: 'admin.setup' })).ok);
    const frame = f.sent.at(-1); assert.ok(frame);
    assert.equal(frame['view'], 'setup');
    assert.deepEqual(frame['model'], { model: 'scripted', provider: 'provider' });
    assert.ok(Array.isArray(frame['packages']) && frame['packages'].length === 2);
    assert.ok((await f.admin.command({ type: 'admin.open' })).ok);
    assert.deepEqual(f.sent.at(-1)?.['sections'], ['packages', 'models', 'modes', 'limits', 'spaces']);
  } finally { await f.close(); }
});

await test('reading an environment and its activity needs no role above a signed-in person', async () => {
  const f = await fixture(new Map<Method, Handler>([
    ['env.status', () => Promise.resolve({ ok: true, value: { target: 'alice', ready: true, generation: 3, state: 'LIVE' } })],
    ['env.logs', () => Promise.resolve({ ok: true, value: { target: 'alice', rows: [{ cursor: 1, at: 5, kind: 'switch', data: {} }], cursor: 1, oldest: 1, truncated: false } })],
  ]), ['env.status', 'env.logs'], 'user');
  try {
    assert.ok((await f.admin.command({ type: 'admin.environment' })).ok);
    assert.deepEqual(f.sent.at(-1), { type: 'admin', view: 'environment', target: 'alice', ready: true, generation: 3, state: 'LIVE' });
    assert.ok((await f.admin.command({ type: 'admin.activity', from: 0 })).ok);
    assert.equal(f.sent.at(-1)?.['view'], 'activity');
  } finally { await f.close(); }
});

await test('rebuilding a person\'s own environment answers with a fresh status, so the change is watchable', async () => {
  let reset = 0;
  const f = await fixture(new Map<Method, Handler>([
    ['env.reset', () => { reset++; return Promise.resolve({ ok: true, value: undefined }); }],
    ['env.status', () => Promise.resolve({ ok: true, value: { target: 'alice', ready: false, generation: 4, state: 'ROLLING_BACK' } })],
  ]), ['env.reset', 'env.status'], 'user');
  try {
    assert.ok((await f.admin.command({ type: 'admin.undo' })).ok);
    assert.equal(reset, 1);
    assert.deepEqual(f.sent.at(-1), { type: 'admin', view: 'environment', target: 'alice', ready: false, generation: 4, state: 'ROLLING_BACK' });
  } finally { await f.close(); }
});

for (const role of ['user', 'reviewer']) await test(`a ${role} cannot reach a command reserved for an administrator, whatever the kernel negotiated`, async () => {
  const f = await fixture(new Map<Method, Handler>([['env.status', () => Promise.resolve({ ok: true, value: {} })]]), ['env.status'], role);
  try {
    for (const type of ['admin.restore-point', 'admin.tidy', 'admin.settings', 'admin.accounts']) {
      const result = await f.admin.command({ type });
      assert.ok(!result.ok); assert.equal(result.error.code, 'forbidden', `${type} refused with ${result.error.code}.`);
    }
    const added = await f.admin.command({ type: 'admin.add', scope: 'deployment', name: 'core' });
    assert.ok(!added.ok); assert.equal(added.error.code, 'forbidden');
  } finally { await f.close(); }
});

await test('a user cannot review or confirm a change to what everyone gets, even where both calls are offered', async () => {
  const f = await fixture(new Map<Method, Handler>([
    ['default.prepare', () => Promise.resolve({ ok: true, value: { code: 'nonce', line: 'release baseline 1 gate passed code nonce' } })],
    ['default.set', () => Promise.resolve({ ok: true, value: undefined })],
  ]), ['default.prepare', 'default.set'], 'user');
  try {
    for (const type of ['admin.review', 'admin.confirm']) {
      const result = await f.admin.command({ type, digest: 'release', baseline: 1 });
      assert.ok(!result.ok); assert.equal(result.error.code, 'forbidden');
    }
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

await test('the act takes two steps, the code never leaves the host, and confirming something else is refused', async () => {
  const calls: Record<string, unknown>[] = [];
  const f = await fixture(new Map<Method, Handler>([
    ['default.prepare', params => { calls.push(params); return Promise.resolve({ ok: true, value: { code: 'nonce', line: 'release baseline 1 gate passed code nonce' } }); }],
    ['default.set', params => { calls.push(params); return Promise.resolve({ ok: true, value: undefined }); }],
  ]), ['default.prepare', 'default.set'], 'reviewer');
  try {
    // Confirming before looking has nothing to consume: the host holds no code, so there is nothing to spend.
    const early = await f.admin.command({ type: 'admin.confirm', digest: 'release', baseline: 1 });
    assert.ok(!early.ok); assert.equal(early.error.code, 'conflict');

    assert.ok((await f.admin.command({ type: 'admin.review', digest: 'release', baseline: 1 })).ok);
    const review = f.sent.at(-1); assert.ok(review);
    assert.deepEqual(review, { type: 'admin', view: 'review', digest: 'release', baseline: 1, checked: true });
    assert.ok(!JSON.stringify(review).includes('nonce'), 'the confirmation code must never reach the browser.');

    // A page that drifted between looking and confirming names a different change and is refused.
    const drifted = await f.admin.command({ type: 'admin.confirm', digest: 'other', baseline: 1 });
    assert.ok(!drifted.ok); assert.equal(drifted.error.code, 'conflict');

    assert.ok((await f.admin.command({ type: 'admin.confirm', digest: 'release', baseline: 1 })).ok);
    assert.deepEqual(f.sent.at(-1), { type: 'admin', view: 'applied', digest: 'release', baseline: 1 });
    assert.deepEqual(calls, [{ digest: 'release', baseline: 1 }, { digest: 'release', baseline: 1, code: 'nonce' }]);

    // Single use: the code went with the act, so the same confirmation cannot be replayed.
    const replayed = await f.admin.command({ type: 'admin.confirm', digest: 'release', baseline: 1 });
    assert.ok(!replayed.ok); assert.equal(replayed.error.code, 'conflict');
  } finally { await f.close(); }
});

await test('an unnamed or oversized version is refused before the socket is touched', async () => {
  const f = await fixture(new Map<Method, Handler>([['default.prepare', () => Promise.resolve({ ok: true, value: { code: 'nonce' } })]]), ['default.prepare'], 'admin');
  try {
    for (const input of [{}, { digest: 'release' }, { baseline: 1 }, { digest: 'r'.repeat(257), baseline: 1 }, { digest: 'r', baseline: 1.5 }]) {
      const result = await f.admin.command({ type: 'admin.review', ...input });
      assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
    }
  } finally { await f.close(); }
});

await test('wire.ts hands every admin.* command to this seam and refuses anything else', async () => {
  const f = await fixture(new Map(), [], 'admin');
  try {
    const delegated = await f.wire.command({ type: 'admin.open' }); assert.ok(delegated.ok);
    assert.equal(f.sent.at(-1)?.['type'], 'admin');
    const unknown = await f.wire.command({ type: 'admin.nonsense' });
    assert.ok(!unknown.ok); assert.equal(unknown.error.code, 'unsupported');
  } finally { await f.close(); }
});
