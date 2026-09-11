/** Pin scoped identities, prefix persistence, cancellation and drain against the real loop; KS-004, TE-009. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sessions, sessionLimits } from './sessions.ts';
import { sessionFixture } from '@/test/session-fixture.ts';
import type { Vendor } from '@/lib/provider/engine.ts';

const input = { text: 'Hello', attachments: [] };

await test('ADR-0014 report exhaustion returns a diagnostic refusal before a vendor request', async () => {
  const fixture = await sessionFixture(); const reports: Record<string, unknown>[] = [];
  try {
    const sessions = await Sessions.open(fixture.state, { ...fixture.runtime,
      stages: Array.from({ length: 256 }, (_, index) => ({ source: `stage-${String(index)}@1.0.0`, observe: () => undefined })),
      report: params => { reports.push(params); return Promise.resolve({ ok: true, value: undefined }); }
    }); assert.ok(sessions.ok);
    const created = await sessions.value.create({ surface: 'faux' }); assert.ok(created.ok);
    const result = await sessions.value.submit(created.value.id, input); assert.ok(!result.ok); assert.equal(result.error.code, 'budget');
    assert.equal(fixture.provider.provider.vendorCalls, 0); assert.equal(reports.length, 1);
    assert.ok(JSON.stringify(reports).includes('reportError')); assert.ok(!JSON.stringify(reports).includes('Hello'));
  } finally { await fixture.close(); }
});

await test('KS-004 conversation ids resolve only inside the assigned environment state', async () => {
  const alice = await sessionFixture(); const bob = await sessionFixture();
  try {
    const a = await alice.sessions.create({ surface: 'web' }); const b = await bob.sessions.create({ surface: 'web' }); assert.ok(a.ok && b.ok);
    assert.ok(!(await alice.sessions.history(b.value.id)).ok); assert.ok(!(await bob.sessions.submit(a.value.id, input)).ok);
    assert.ok(!(await alice.sessions.history('../conversations')).ok);
    assert.deepEqual(await readdir(alice.state), [a.value.id]); assert.deepEqual(await readdir(bob.state), [b.value.id]);
    assert.deepEqual(await alice.sessions.list(), { ok: true, value: [a.value] });
    const alias = '00000000-0000-0000-0000-000000000001'; await symlink(join(bob.state, b.value.id), join(alice.state, alias));
    const escaped = await alice.sessions.history(alias); assert.ok(!escaped.ok); assert.equal(escaped.error.code, 'outside-roots');
  } finally { await alice.close(); await bob.close(); }
});

await test('TE-009 session reload reuses the stored prefix and returns completion metadata without provider content', async () => {
  const f = await sessionFixture();
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const first = await f.sessions.submit(created.value.id, input); assert.ok(first.ok); assert.deepEqual(Object.keys(first.value).sort(), ['conversation', 'head']);
    const reopened = await Sessions.open(f.state, f.runtime); assert.ok(reopened.ok);
    const second = await reopened.value.submit(created.value.id, { text: 'Again', attachments: [] }); assert.ok(second.ok); assert.notEqual(first.value.head, second.value.head);
    const history = await reopened.value.history(created.value.id); assert.ok(history.ok); assert.deepEqual(history.value.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(f.events.filter(event => event.type === 'retrieve').length, 1);
    assert.equal(f.provider.provider.capturedPrefixes[0], f.provider.provider.capturedPrefixes[1]);
    assert.ok(!JSON.stringify(history.value).includes('ignored extension'));
    assert.equal(f.provider.reports.length, 2);
  } finally { await f.close(); }
});

await test('GN-001 session drain waits for active writes, refuses new turns and permits cancellation before resumption', async () => {
  const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<undefined>();
  const vendor: Vendor = {
    describe: () => Promise.resolve({ ok: true, value: { models: [] } }), estimate: () => 0.01,
    async *exchange(_request, signal) {
      entered.resolve(signal); signal.addEventListener('abort', () => { release.resolve(undefined); }, { once: true });
      yield { type: 'start', id: 'call', model: 'scripted' }; await release.promise;
      yield { type: 'usage', counters: { cost: 0.001 } }; yield { type: 'stop', reason: 'end' };
    }
  };
  const f = await sessionFixture(vendor);
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const turn = f.sessions.submit(created.value.id, input); const signal = await entered.promise;
    const duplicate = await f.sessions.submit(created.value.id, input); assert.ok(!duplicate.ok); assert.equal(duplicate.error.code, 'budget');
    const creating = f.sessions.create({ surface: 'web' }); const drained = f.sessions.pause();
    const refused = await f.sessions.submit(created.value.id, input); assert.ok(!refused.ok); assert.equal(refused.error.code, 'switching');
    assert.ok(!(await f.sessions.create({ surface: 'web' })).ok); assert.equal(f.sessions.active, 1);
    assert.deepEqual(f.sessions.cancel(created.value.id), { ok: true, value: { cancelled: true } }); assert.ok(signal.aborted);
    assert.ok((await turn).ok); await drained; assert.ok((await creating).ok); assert.equal(f.sessions.active, 0);
    f.sessions.resume(); assert.ok((await f.sessions.submit(created.value.id, input)).ok);
  } finally { release.resolve(undefined); await f.close(); }
});

await test('Session metadata, input size, loading size and concurrent read queues refuse before unbounded work', async () => {
  const f = await sessionFixture();
  try {
    assert.ok(!(await f.sessions.create({ surface: '' })).ok);
    const creating = f.sessions.create({ surface: 'web' }); assert.ok(!(await f.sessions.create({ surface: 'web' })).ok);
    const created = await creating; assert.ok(created.ok);
    const large = await f.sessions.submit(created.value.id, { text: 'x'.repeat(sessionLimits.inputBytes), attachments: [] }); assert.ok(!large.ok); assert.equal(large.error.code, 'budget');
    const reads = Array.from({ length: sessionLimits.reads }, () => f.sessions.list());
    const extra = await f.sessions.list(); assert.ok(!extra.ok); assert.equal(extra.error.code, 'budget'); await Promise.all(reads);
    await writeFile(join(f.state, created.value.id, 'conversation.jsonl'), 'x'.repeat(sessionLimits.fileBytes + 1));
    const loaded = await f.sessions.history(created.value.id); assert.ok(!loaded.ok); assert.equal(loaded.error.code, 'budget');
    await writeFile(join(f.state, created.value.id, 'metadata.json'), JSON.stringify({ id: created.value.id, surface: 4 }));
    const listed = await f.sessions.list(); assert.ok(!listed.ok); assert.equal(listed.error.code, 'io');
  } finally { await f.close(); }
});

await test('a submitted turn names its conversation from the first message and previews the reply', async () => {
  let at = 5_000;
  const f = await sessionFixture(undefined, () => { at += 1000; return at; });
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    assert.equal(created.value.title, undefined, 'a conversation nobody has spoken to has no name to show.');
    assert.ok((await f.sessions.submit(created.value.id, { text: 'Ship the sidebar', attachments: [] })).ok);
    const listed = await f.sessions.list(); assert.ok(listed.ok);
    const [row] = listed.value; assert.ok(row);
    assert.equal(row.title, 'Ship the sidebar');
    assert.equal(row.preview, 'Hello.', 'the row previews the reply, which is where the conversation now is.');
    assert.ok(Number(row.updatedMs) > Number(row.createdMs), 'a turn moves the row to the top of the sidebar.');

    assert.ok((await f.sessions.submit(created.value.id, { text: 'And the tabs', attachments: [] })).ok);
    const again = await f.sessions.list(); assert.ok(again.ok);
    const [second] = again.value; assert.ok(second);
    assert.equal(second.title, 'Ship the sidebar', 'the first message keeps the name; nothing on this wire renames it.');
    assert.ok(Number(second.updatedMs) > Number(row.updatedMs));
  } finally { await f.close(); }
});

await test('a conversation is named even when its turn never returns a reply', async () => {
  const refusing: Vendor = {
    describe: () => Promise.resolve({ ok: true, value: { models: [] } }), estimate: () => 0.01,
    async *exchange() { await Promise.resolve(); yield { type: 'error', code: 'provider', message: 'The vendor refused.' }; }
  };
  const f = await sessionFixture(refusing);
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const large = await f.sessions.submit(created.value.id, { text: 'x'.repeat(sessionLimits.inputBytes), attachments: [] });
    assert.ok(!large.ok, 'an input refused before the store is reached names nothing.');
    const before = await f.sessions.exists(created.value.id); assert.ok(before.ok);
    assert.equal(before.value.title, undefined);

    // The name is written before the vendor is called, so a turn that never produces a reply still
    // leaves a row a person can find again — which is the whole point of naming it that early.
    const failed = await f.sessions.submit(created.value.id, { text: 'Name me anyway', attachments: [] });
    assert.ok(!failed.ok);
    const after = await f.sessions.exists(created.value.id); assert.ok(after.ok);
    assert.equal(after.value.title, 'Name me anyway');
    assert.equal(after.value.preview, 'Name me anyway', 'with no reply, the row still shows what was asked.');
  } finally { await f.close(); }
});

await test('a conversation chooses its own model and mode, and the choice outlives the process that took it', async () => {
  const f = await sessionFixture();
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const offered = await f.sessions.choices(); assert.ok(offered.ok);
    assert.deepEqual(offered.value.models.map(model => model.id), ['scripted'], 'the list is the provider\'s own describe, not anything this package made up');
    assert.deepEqual([offered.value.model, offered.value.mode], ['scripted', 'agent']);

    // Both are checked against what this environment will honour, because a browser is what sends them.
    const absent = await f.sessions.choose(created.value.id, { model: 'not-installed' });
    assert.ok(!absent.ok); assert.equal(absent.error.code, 'invalid-args');
    assert.ok(!(await f.sessions.choose(created.value.id, { mode: 'root' })).ok);

    assert.ok((await f.sessions.choose(created.value.id, { mode: 'plan' })).ok);
    assert.ok((await f.sessions.submit(created.value.id, input)).ok);
    const offers = f.events.filter(event => event.type === 'offer');
    assert.ok(offers.length > 0);
    assert.deepEqual(offers.map(event => event.payload['mode']), offers.map(() => ({ readOnly: true, deny: [] })),
      'plan has to reach the loop itself: the offer hook is where a mode is enforced, so an unchanged offer means an unchanged mode');

    // The row is where the answer lives, so a surface that reconnects to a restarted environment finds
    // the same one rather than the default.
    const reopened = await Sessions.open(f.state, f.runtime); assert.ok(reopened.ok);
    const listed = await reopened.value.list(); assert.ok(listed.ok);
    assert.equal(listed.value[0]?.mode, 'plan');
    assert.ok((await reopened.value.submit(created.value.id, { text: 'Again', attachments: [] })).ok);
    assert.deepEqual(f.events.filter(event => event.type === 'offer').at(-1)?.payload['mode'], { readOnly: true, deny: [] });
  } finally { await f.close(); }
});

await test('a conversation cannot widen the mode its environment was configured with', async () => {
  const f = await sessionFixture();
  try {
    // The environment itself is read-only here, so `agent` is not a wider setting a conversation can
    // ask for — it is the environment's own, and the environment's own is read-only.
    const sessions = await Sessions.open(f.state, { ...f.runtime, options: { ...f.runtime.options, mode: { readOnly: true, deny: ['write_path'] } } });
    assert.ok(sessions.ok);
    const created = await sessions.value.create({ surface: 'web' }); assert.ok(created.ok);
    const offered = await sessions.value.choices(); assert.ok(offered.ok);
    assert.equal(offered.value.mode, 'plan', 'a surface must not draw an Agent it cannot actually get');
    assert.ok((await sessions.value.choose(created.value.id, { mode: 'agent' })).ok);
    assert.ok((await sessions.value.submit(created.value.id, input)).ok);
    assert.deepEqual(f.events.filter(event => event.type === 'offer').at(-1)?.payload['mode'], { readOnly: true, deny: ['write_path'] });
  } finally { await f.close(); }
});

await test('a chosen model is the one the request is made with, and a model the provider drops falls back rather than failing every turn', async () => {
  const models = [{ id: 'scripted', contextWindow: 1000, maxOutput: 100, tools: true, images: false, seed: false, cache: 'none' as const },
    { id: 'thorough', contextWindow: 2000, maxOutput: 200, tools: true, images: false, seed: false, cache: 'none' as const }];
  const asked: string[] = [];
  let offering = models;
  const vendor: Vendor = {
    describe: () => Promise.resolve({ ok: true, value: { models: offering } }), estimate: () => 0.01,
    async *exchange(request) {
      const begin = request[0]; if (begin?.type !== 'begin') throw new Error('The normalized request lost begin.');
      asked.push(begin.model);
      await Promise.resolve();
      yield { type: 'start', id: begin.id, model: begin.model };
      yield { type: 'usage', counters: { cost: 0.001, input: 1, output: 1 } };
      yield { type: 'stop', reason: 'end' };
    }
  };
  const f = await sessionFixture(vendor);
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const offered = await f.sessions.choices(); assert.ok(offered.ok);
    assert.deepEqual(offered.value.models.map(model => model.id), ['scripted', 'thorough']);
    assert.ok((await f.sessions.choose(created.value.id, { model: 'thorough' })).ok);
    assert.ok((await f.sessions.submit(created.value.id, input)).ok);
    assert.deepEqual(asked, ['thorough'], 'the choice has to reach the provider\'s own request, not just the stored row');

    /* A deployment that stops offering a model leaves conversations pointing at it. Falling back beats
     * refusing: one model later is a conversation that carries on, and a refusal on every message is a
     * conversation nobody can use until an operator notices. */
    offering = models.slice(0, 1);
    const reopened = await Sessions.open(f.state, f.runtime); assert.ok(reopened.ok);
    assert.ok((await reopened.value.submit(created.value.id, { text: 'Again', attachments: [] })).ok);
    assert.deepEqual(asked, ['thorough', 'scripted']);
  } finally { await f.close(); }
});
