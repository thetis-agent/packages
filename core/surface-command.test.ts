/** Guard the environment end of a contributed panel's one command; contract/surface, ADR 0051.
 *
 * The gateway end — the declared verb list, the role and the pool — is gateway-web/surface-request.test.ts.
 * What is checked here is what this side is actually responsible for: the conversation the stream is
 * reading, the package being mounted here at all, and a hook that misbehaves being contained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import type { Stage } from '@/lib/events/stages.ts';
import type { CallRequest, CallAnswer } from '@/contracts/turn-events/types.ts';
import { surfaceCommand, commandLimits } from './surface-command.ts';

const schemas = new Schemas(); await schemas.load();

/* A contributor stands in for the real one here, because a package's own hooks are its own repository
 * directory's tests to run (inspector-tools/stage.test.ts covers the package this ships with). What
 * this file owns is the route: the same `source` shape a mounted package has, and nothing more. */
const tallied = new Map<string, number>();
const inspector: Stage = {
  source: 'inspector-tools@1.0.0',
  call: request => Promise.resolve(request.name === 'usage'
    ? { id: request.id, ok: true, data: Object.fromEntries(tallied) }
    : { id: request.id, ok: false, error: { code: 'not-offered', message: 'That panel is not allowed to do this.' } }),
};

/** `open` is the conversation this connection subscribed to; `null` is a connection that has not. */
async function fixture(stages: readonly Stage[] = [inspector], open: string | null = 'c1') {
  const space = await mkdtemp('/tmp/surface-command-'); const clock = new ManualClock();
  return { clock, space, handle: surfaceCommand(stages, schemas, clock, space, () => open ?? undefined), close: () => rm(space, { recursive: true, force: true }) };
}

const ask = (over: Record<string, unknown> = {}) => ({ conversation: 'c1', package: 'inspector-tools', verb: 'usage', args: {}, ...over });

await test('a declared verb reaches the named package and its answer comes back whole', async () => {
  const f = await fixture();
  try {
    tallied.set('read', 2); tallied.set('write', 1);
    const result = await f.handle(ask()); assert.ok(result.ok);
    const answer = result.value as CallAnswer;
    assert.equal(answer.ok, true);
    assert.equal((answer.data ?? {})['read'], 2);
    assert.equal((answer.data ?? {})['write'], 1);
  } finally { await f.close(); }
});

await test('a conversation this stream is not reading is refused before any hook runs', async () => {
  let ran = false;
  const f = await fixture([{ source: 'demo@1.0.0', call: () => { ran = true; return Promise.resolve({ id: 'x', ok: true }); } }]);
  try {
    const result = await f.handle(ask({ conversation: 'c2', package: 'demo' }));
    assert.ok(!result.ok); assert.equal(result.error.code, 'forbidden');
    assert.equal(ran, false);
  } finally { await f.close(); }
});

await test('a stream with no subscription yet reads no conversation, so every request is refused', async () => {
  const f = await fixture([inspector], null);
  try { const result = await f.handle(ask()); assert.ok(!result.ok); assert.equal(result.error.code, 'forbidden'); }
  finally { await f.close(); }
});

await test('a package this environment does not hold is refused by the same answer as one that cannot act', async () => {
  const f = await fixture();
  try {
    const absent = await f.handle(ask({ package: 'not-here' }));
    assert.ok(!absent.ok); assert.equal(absent.error.code, 'not-found');
    assert.equal(absent.error.message, 'That panel is not allowed to do this.');
    const inert = await fixture([{ source: 'inert@1.0.0' }]);
    try { const result = await inert.handle(ask({ package: 'inert' })); assert.ok(!result.ok); assert.equal(result.error.code, 'not-found'); }
    finally { await inert.close(); }
  } finally { await f.close(); }
});

await test('a malformed request is refused rather than handed to a package', async () => {
  const f = await fixture();
  try {
    for (const params of [{ ...ask(), verb: 1 }, { ...ask(), package: undefined }, { ...ask(), args: 'text' }, {}]) {
      const result = await f.handle(params); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
    }
  } finally { await f.close(); }
});

await test('a hook that throws, or answers something else, is contained and named as a failure', async () => {
  const thrower = await fixture([{ source: 'demo@1.0.0', call: () => { throw new Error('no'); } }]);
  try { const result = await thrower.handle(ask({ package: 'demo' })); assert.ok(!result.ok); assert.equal(result.error.code, 'io'); }
  finally { await thrower.close(); }
  const liar = await fixture([{ source: 'demo@1.0.0', call: () => Promise.resolve({ ok: true }) }]);
  try { const result = await liar.handle(ask({ package: 'demo' })); assert.ok(!result.ok); assert.equal(result.error.code, 'protocol'); }
  finally { await liar.close(); }
});

await test('an answer carrying another request\'s id is refused, so no reply can be mistaken for this one', async () => {
  const f = await fixture([{ source: 'demo@1.0.0', call: () => Promise.resolve({ id: 'somebody-else', ok: true }) }]);
  try { const result = await f.handle(ask({ package: 'demo' })); assert.ok(!result.ok); assert.equal(result.error.code, 'protocol'); }
  finally { await f.close(); }
});

await test('a hook that never answers is ended at its deadline rather than held open', async () => {
  const f = await fixture([{ source: 'demo@1.0.0', call: () => new Promise<CallAnswer>(() => undefined) }]);
  try {
    const pending = f.handle(ask({ package: 'demo' }));
    f.clock.advance(commandLimits.deadlineMs);
    const result = await pending; assert.ok(!result.ok); assert.equal(result.error.code, 'protocol');
  } finally { await f.close(); }
});

await test('the request the package receives carries no file roots and a bounded result budget', async () => {
  let seen: CallRequest | undefined;
  const f = await fixture([{ source: 'demo@1.0.0', call: request => { seen = request; return Promise.resolve({ id: request.id, ok: true }); } }]);
  try {
    const result = await f.handle(ask({ package: 'demo', verb: 'anything', args: { a: 1 } })); assert.ok(result.ok);
    assert.ok(seen);
    assert.equal(seen.name, 'anything');
    assert.deepEqual(seen.args, { a: 1 });
    assert.deepEqual(seen.roots, []);
    assert.deepEqual(seen.mode, { readOnly: false, deny: [] });
    assert.equal(seen.budget.resultBytes, commandLimits.resultBytes);
    assert.equal(seen.deadlineMs, commandLimits.deadlineMs);
  } finally { await f.close(); }
});
