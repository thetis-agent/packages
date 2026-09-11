/** Guard the two decisions behind a contributed panel's one way to act; contract/surface, ADR 0051.
 *
 * `assets/lib/surface.js` is the seam a panel imports, and it touches the store, the rail and the
 * DOM — none of which exist here. `assets/lib/requests.js` exists apart from it for exactly the
 * reason `assets/lib/dispatch.js` does: which package is calling, and which promise an answer
 * belongs to, are branchy decisions that need no document to make. Both are loaded the way
 * dispatch.test.ts loads its subject — a dynamic import taken as `unknown` and narrowed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

type PackageOf = (stack: unknown) => unknown;
interface Waiting { full: boolean; open(resolve: unknown, reject: unknown): unknown; drop(id: unknown): void; settle(frame: unknown): unknown }
type Construct = new (options?: Record<string, unknown>) => Waiting;

const here = dirname(fileURLToPath(import.meta.url));
const loaded: unknown = await import(pathToFileURL(join(here, 'assets/lib/requests.js')).href);
assert.ok(isObject(loaded), 'assets/lib/requests.js should load as a module namespace object.');
const read: unknown = loaded['packageOf']; const made: unknown = loaded['Pending'];
assert.ok(typeof read === 'function' && typeof made === 'function', 'requests.js should export packageOf and Pending.');
const packageOf = read as PackageOf; const Pending = made as Construct;

/** A pending pool whose timers are this test's own, so nothing here waits on a real clock. */
function pool(options: Record<string, unknown> = {}): { pending: Waiting; fire(): void; cancelled: number } {
  const timers: (() => void)[] = []; const state = { cancelled: 0 };
  const pending = new Pending({ schedule: (run: () => void) => { timers.push(run); return timers.length; }, cancel: () => { state.cancelled++; }, ...options });
  return { pending, fire: () => { for (const run of timers.splice(0)) run(); }, get cancelled() { return state.cancelled; } };
}

await test('a served surface path names the package that called, whatever the stack format around it', () => {
  assert.equal(packageOf('at draw (http://host/surface/inspector-tools/panel.js:12:3)'), 'inspector-tools');
  assert.equal(packageOf('http://host/surface/retriever-local/rows.js:1:1'), 'retriever-local');
  // The seam itself is served from /lib/, so a stack that reaches only it names no package: a caller
  // the module cannot identify is refused rather than attributed to whoever is first in the file.
  assert.equal(packageOf('at request (http://host/lib/surface.js:40:9)\n at http://host/app.js:1:1'), null);
  assert.equal(packageOf(undefined), null);
  assert.equal(packageOf(''), null);
});

await test('a path that only looks like a served one names nothing', () => {
  for (const stack of ['/surface//panel.js', '/surface/Inspector/panel.js', 'surface/tools/panel.js', '/surfaces/tools/panel.js', '/surface/1tools/panel.js']) {
    assert.equal(packageOf(`at draw (http://host${stack}:1:1)`), null, stack);
  }
});

await test('the deepest frame wins, so a helper module cannot answer for the panel that called it', () => {
  // The stack reads innermost first, and the innermost served frame is the module that called the
  // seam. Nothing else in the stack can displace it.
  const stack = 'at request (http://host/lib/surface.js:1:1)\nat ask (http://host/surface/inspector-tools/panel.js:1:1)\nat http://host/surface/other-package/x.js:1:1';
  assert.equal(packageOf(stack), 'inspector-tools');
});

await test('an answer settles the one request that asked, and no other', () => {
  const held = pool(); const pending = held.pending;
  const settled: unknown[] = [];
  const first = pending.open((value: unknown) => settled.push(['first', value]), () => settled.push(['first', 'rejected']));
  const second = pending.open((value: unknown) => settled.push(['second', value]), () => settled.push(['second', 'rejected']));
  assert.notEqual(first, second, 'each request gets its own id');
  assert.equal(pending.settle({ request: second, ok: true, text: 'done', data: { n: 1 } }), true);
  assert.deepEqual(settled, [['second', { text: 'done', data: { n: 1 } }]]);
  // The first is still waiting, and a repeat of the answer settles nothing at all.
  assert.equal(pending.settle({ request: second, ok: true }), false);
  assert.equal(pending.settle({ request: 'never-sent', ok: true }), false);
  assert.deepEqual(settled.length, 1);
  assert.ok(held.cancelled >= 1, 'a settled request cancels its own timer');
});

await test('a refusal reaches the panel as its own message, and a bare failure as a plain one', () => {
  const { pending } = pool();
  const errors: string[] = [];
  const id = pending.open(() => undefined, (error: Error) => errors.push(error.message));
  pending.settle({ request: id, ok: false, message: 'That panel is not allowed to do this.' });
  const bare = pending.open(() => undefined, (error: Error) => errors.push(error.message));
  pending.settle({ request: bare, ok: false });
  assert.deepEqual(errors, ['That panel is not allowed to do this.', 'That did not work. Nothing was changed.']);
});

await test('an answer that never comes is ended rather than left waiting for ever', () => {
  const held = pool();
  const errors: string[] = [];
  const id = held.pending.open(() => undefined, (error: Error) => errors.push(error.message));
  held.fire();
  assert.deepEqual(errors, ['That did not work. Nothing was changed.']);
  // The request is gone, so a late answer settles nothing and cannot reject an already-rejected promise.
  assert.equal(held.pending.settle({ request: id, ok: true }), false);
});

await test('the pool is bounded, and a request that could not be sent gives its place back', () => {
  const { pending } = pool({ max: 2 });
  const first = pending.open(() => undefined, () => undefined);
  pending.open(() => undefined, () => undefined);
  assert.equal(pending.full, true);
  pending.drop(first);
  assert.equal(pending.full, false);
  // Dropping something that was never open, or was already settled, is not an error.
  pending.drop(first); pending.drop('never-sent');
  assert.equal(pending.full, false);
});
