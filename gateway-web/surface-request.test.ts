/** Guard the one thing a contributed panel may originate, end to end; contract/surface, ADR 0051.
 *
 * The path under test is the whole of it on this side: a package's own manifest is read by
 * `compose` exactly as the serving surface reads it, the declaration that comes out is what
 * `SurfaceRequests` is built from, and every refusal is checked against that same real declaration
 * rather than a hand-written list. The environment end is core/surface-command.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { CallAnswer } from '@/contracts/turn-events/types.ts';
import type { Table } from '@/lib/assets/index.ts';
import { compose } from './panels.ts';
import type { Declared } from './panels.ts';
import { SurfaceRequests, limits as answerLimits } from './surface-request.ts';
import type { Stream } from './surface-request.ts';
import { settings } from './index.ts';

const own: Table = { root: '/surface-own', assets: [{ path: '/app.js', file: 'app.js', type: 'text/javascript', size: 1, sha256: 'a', absolute: '/surface-own/app.js' }] };

async function schemas(): Promise<Schemas> { const value = new Schemas(); await value.load(); return value; }

/** One contributor on disk, so the declaration under test is the one a real manifest would produce. */
async function root(name: string, surface: unknown): Promise<string> {
  const base = await mkdtemp('/tmp/surface-request-');
  const directory = join(base, name);
  await mkdir(join(directory, 'surface'), { recursive: true });
  await writeFile(join(directory, 'surface/panel.js'), 'export const a = 1;\n');
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name, version: '1.0.0', requires: {}, settings: {}, provides: { 'panel/tools': '1.0.0' },
    envelope: { requires: [], provides: [], spawn: { scope: 'person', network: 'none' } }, surface,
  }));
  await writeFile(join(directory, 'assets.json'), JSON.stringify({ assets: [{ path: `/surface/${name}/panel.js`, file: 'surface/panel.js', type: 'text/javascript' }] }));
  return base;
}

const block = (name: string, commands: unknown[]) => ({
  v: '1', panels: [{ id: 'tools', label: 'Tools', entry: `/surface/${name}/panel.js` }], commands,
});

/** The declaration `compose` produces for one contributor, plus whatever it refused on the way. */
async function declared(name: string, commands: unknown[]): Promise<{ declared: Declared[]; refused: string[] }> {
  const base = await root(name, block(name, commands));
  try {
    const composed = await compose(own, await schemas(), base);
    return { declared: composed.contribution.declared, refused: composed.refused.map(refusal => `${refusal.name}: ${refusal.message}`) };
  } finally { await rm(base, { recursive: true, force: true }); }
}

interface Asked { conversation: string; name: string; verb: string; args: Record<string, unknown> }

/** A stand-in for the open conversation's environment stream. `answer` decides what comes back, so a
 *  test can separate "the host let it through" from "the package said no". */
function stream(asked: Asked[], answer: (request: Asked) => Result<CallAnswer> = () => ({ ok: true, value: { id: 'x', ok: true, content: [{ type: 'text', text: 'done' }] } })): Stream {
  return { request: (conversation, name, verb, args) => { asked.push({ conversation, name, verb, args }); return Promise.resolve(answer({ conversation, name, verb, args })); } };
}

interface Fixture { sent: Record<string, unknown>[]; asked: Asked[]; requests: SurfaceRequests }

async function fixture(options: { role?: string; open?: string; commands?: unknown[]; answer?: (request: Asked) => Result<CallAnswer>; hold?: boolean } = {}): Promise<Fixture> {
  const found = await declared('inspector-tools', options.commands ?? [{ verb: 'usage', label: 'See how often each tool has been used here' }]);
  assert.deepEqual(found.refused, []);
  const sent: Record<string, unknown>[] = []; const asked: Asked[] = [];
  const held = stream(asked, options.answer);
  const open = options.open ?? 'c1';
  const requests = new SurfaceRequests(found.declared, options.role ?? 'user',
    id => id === open ? (options.hold ? { request: (conversation, name, verb, args) => { asked.push({ conversation, name, verb, args }); return new Promise(() => undefined); } } : held) : undefined,
    frame => { sent.push(frame); return Promise.resolve({ ok: true, value: undefined }); });
  return { sent, asked, requests };
}

const ask = (over: Record<string, unknown> = {}) => ({ type: 'surface-request', request: 'r1', id: 'c1', package: 'inspector-tools', verb: 'usage', args: {}, ...over });

await test('a declared verb reaches the package that declared it, and its answer reaches the panel that asked', async () => {
  const f = await fixture();
  const result = await f.requests.handle(ask()); assert.ok(result.ok);
  assert.deepEqual(f.asked, [{ conversation: 'c1', name: 'inspector-tools', verb: 'usage', args: {} }]);
  assert.deepEqual(f.sent, [{ type: 'surface-answer', request: 'r1', session: 'c1', ok: true, text: 'done' }]);
});

await test('the package\'s own data comes back on the answer, so a panel can draw it', async () => {
  const f = await fixture({ answer: () => ({ ok: true, value: { id: 'x', ok: true, data: { read: 3, write: 1 } } }) });
  const result = await f.requests.handle(ask()); assert.ok(result.ok);
  assert.deepEqual(f.sent.at(-1), { type: 'surface-answer', request: 'r1', session: 'c1', ok: true, data: { read: 3, write: 1 } });
});

await test('a verb the package did not declare is refused, and never reaches the environment', async () => {
  const f = await fixture();
  const result = await f.requests.handle(ask({ verb: 'delete' })); assert.ok(result.ok);
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.sent, [{ type: 'surface-answer', request: 'r1', session: 'c1', ok: false, message: 'That panel is not allowed to do this.' }]);
});

await test('a package that contributed nothing here is refused, whatever it claims to have declared', async () => {
  const f = await fixture();
  const result = await f.requests.handle(ask({ package: 'tools-files' })); assert.ok(result.ok);
  assert.deepEqual(f.asked, []);
  assert.equal(f.sent.at(-1)?.['message'], 'That panel is not allowed to do this.');
});

await test('a role below the one the declaration asked for is refused, and the same verb clears above it', async () => {
  const commands = [{ verb: 'usage', label: 'See how often each tool has been used here', role: 'reviewer' }];
  const low = await fixture({ commands });
  assert.ok((await low.requests.handle(ask())).ok);
  assert.deepEqual(low.asked, []);
  assert.equal(low.sent.at(-1)?.['message'], 'You do not have permission to do this.');
  for (const role of ['reviewer', 'admin']) {
    const high = await fixture({ commands, role });
    assert.ok((await high.requests.handle(ask())).ok);
    assert.equal(high.asked.length, 1, role);
  }
});

await test('a role the gateway could not read clears nothing, even where the declaration named none', async () => {
  const f = await fixture({ role: '' });
  const result = await f.requests.handle(ask()); assert.ok(result.ok);
  assert.deepEqual(f.asked, []);
  assert.equal(f.sent.at(-1)?.['message'], 'You do not have permission to do this.');
});

await test('a conversation this connection has not opened is refused', async () => {
  const f = await fixture({ open: 'c1' });
  const result = await f.requests.handle(ask({ id: 'c2' })); assert.ok(result.ok);
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.sent, [{ type: 'surface-answer', request: 'r1', session: 'c2', ok: false, message: 'That conversation is not open any more.' }]);
});

await test('past the pending cap a request is refused rather than queued behind the ones in flight', async () => {
  const f = await fixture({ hold: true });
  const flight = Array.from({ length: settings.pendingRequests }, (_, index) => f.requests.handle(ask({ request: `r${String(index)}` })));
  // Every held request is out; the next one is answered immediately, and it is a refusal.
  assert.equal(f.asked.length, settings.pendingRequests);
  const result = await f.requests.handle(ask({ request: 'over' })); assert.ok(result.ok);
  assert.equal(f.asked.length, settings.pendingRequests);
  assert.deepEqual(f.sent.at(-1), { type: 'surface-answer', request: 'over', session: 'c1', ok: false, message: 'Too much is happening at once. Try that again in a moment.' });
  assert.equal(flight.length, settings.pendingRequests);
});

await test('a package answering with a refusal reaches the panel as that refusal, not as a socket error', async () => {
  const f = await fixture({ answer: () => ({ ok: true, value: { id: 'x', ok: false, error: { code: 'not-offered', message: 'That panel is not allowed to do this.' } } }) });
  const result = await f.requests.handle(ask()); assert.ok(result.ok);
  assert.deepEqual(f.sent.at(-1), { type: 'surface-answer', request: 'r1', session: 'c1', ok: false, message: 'That panel is not allowed to do this.' });
});

await test('a transport failure is said plainly rather than forwarded in the wire\'s own words', async () => {
  const f = await fixture({ answer: () => ({ ok: false, error: { code: 'deadline', message: 'session.request exceeded its deadline.' } }) });
  const result = await f.requests.handle(ask()); assert.ok(result.ok);
  assert.deepEqual(f.sent.at(-1), { type: 'surface-answer', request: 'r1', session: 'c1', ok: false, message: 'That did not work. Nothing was changed.' });
});

await test('an answer longer than its bound is cut rather than sent whole', async () => {
  const long = 'x'.repeat(answerLimits.answerBytes + 64);
  const f = await fixture({ answer: () => ({ ok: true, value: { id: 'x', ok: true, content: [{ type: 'text', text: long }] } }) });
  const result = await f.requests.handle(ask()); assert.ok(result.ok);
  assert.equal(String(f.sent.at(-1)?.['text']).length, answerLimits.answerBytes);
});

await test('a frame with no reply address is a malformed frame, not a refusal nobody could receive', async () => {
  const f = await fixture();
  const result = await f.requests.handle({ type: 'surface-request', id: 'c1', package: 'inspector-tools', verb: 'usage' });
  assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
  assert.deepEqual(f.sent, []);
});

await test('a declaration with no panel to send it is refused by name, and the surface still starts', async () => {
  const base = await root('greedy', { v: '1', commands: [{ verb: 'usage', label: 'Do a thing' }] });
  try {
    const composed = await compose(own, await schemas(), base);
    const [refusal] = composed.refused; assert.ok(refusal);
    assert.equal(refusal.name, 'greedy');
    assert.match(refusal.message, /greedy declares a command but contributes no panel to send it\./u);
    assert.deepEqual(composed.contribution.declared, []);
    assert.deepEqual(composed.table.assets.map(asset => asset.path), ['/app.js']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a verb declared twice has no single answer and is refused by name', async () => {
  const found = await declared('twice', [{ verb: 'usage', label: 'One' }, { verb: 'usage', label: 'Another' }]);
  assert.deepEqual(found.declared, []);
  assert.match(found.refused.join(''), /twice declares usage more than once\./u);
});

await test('a verb outside the contract\'s own pattern never becomes a declaration at all', async () => {
  const found = await declared('shouty', [{ verb: 'Usage', label: 'One' }]);
  assert.deepEqual(found.declared, []);
  assert.match(found.refused.join(''), /surface block does not match contract\/surface/u);
});
