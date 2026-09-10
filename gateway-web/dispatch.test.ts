/** Guard the contributed-renderer fallthrough the surface seam promises; contract/surface, ADR 0038 §1.
 *
 * `assets/views/transcript.js` consults the renderer a package contributed before its own built-in
 * table, and only a *truthy* node short-circuits: a contributor that returns `null`, returns
 * `undefined`, or throws must fall through to the built-in row rather than leave a hole in the
 * reading order of the conversation. Contributed panels rely on exactly that, so it is tested here.
 *
 * There is no DOM harness in this repository and adding one (jsdom, linkedom) would buy one test a
 * dependency the house rules do not want. It is not needed. The decision lives in
 * `assets/lib/dispatch.js` on its own precisely so that it can be made without a document: it is
 * handed the two renderers rather than looking them up, and it returns which one should draw rather
 * than drawing. Whatever a contributed renderer does when called is its own business — here it
 * returns plain objects — so every branch below is reachable with no DOM at all. The module is
 * loaded the way `lib/package-loader/load.ts` loads a package entry: a dynamic import taken as
 * `unknown` and narrowed, never an `any`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

/** What the module under test is: three inputs and a plain decision object, no DOM anywhere. */
type Chooser = (contributed: unknown, builtin: unknown, frame: unknown, context: unknown) => unknown;

function isChooser(value: unknown): value is Chooser {
  return typeof value === 'function';
}

const here = dirname(fileURLToPath(import.meta.url));
const loaded: unknown = await import(pathToFileURL(join(here, 'assets/lib/dispatch.js')).href);
assert.ok(isObject(loaded), 'assets/lib/dispatch.js should load as a module namespace object.');
const exported: unknown = loaded['chooseTranscriptRow'];
assert.ok(isChooser(exported), 'assets/lib/dispatch.js should export chooseTranscriptRow as a function.');
const choose: Chooser = exported;

/** Every assertion below reads the returned decision as untyped data, so the test never trusts the
 *  shape the type above claims — it checks it. */
function decision(contributed: unknown, builtin: unknown, frame: unknown = { kind: 'note' }, context: unknown = {}): Record<string, unknown> {
  const value = choose(contributed, builtin, frame, context);
  assert.ok(isObject(value), 'chooseTranscriptRow should return an object.');
  return value;
}

/** A built-in renderer stands in for one row of transcript.js's RENDERERS table. */
function builtinRenderer(): (frame: unknown) => void {
  return () => undefined;
}

await test('a contributed renderer that returns a node draws the row, and the node is handed back untouched', () => {
  const node = { tag: 'div' };
  const builtin = builtinRenderer();
  const seen: unknown[] = [];
  const frame = { kind: 'retrieve', session: 'c1' };
  const context = { el: () => undefined };
  const result = decision((...args: unknown[]) => { seen.push(args); return node; }, builtin, frame, context);
  assert.equal(result['row'], 'contributed');
  assert.equal(result['node'], node);
  assert.equal(result['failed'], undefined);
  assert.deepEqual(seen, [[frame, context]], 'the contributed renderer receives the frame and the helper bag, in that order and nothing else.');
});

await test('a contributed renderer that returns null falls through to the built-in row', () => {
  const builtin = builtinRenderer();
  const result = decision(() => null, builtin);
  assert.equal(result['row'], 'builtin');
  assert.equal(result['builtin'], builtin);
  assert.equal(result['failed'], undefined);
  assert.ok(!('node' in result), 'a fallthrough decision must not carry a node for the caller to place.');
});

await test('a contributed renderer that returns undefined falls through to the built-in row', () => {
  const builtin = builtinRenderer();
  const result = decision(() => undefined, builtin);
  assert.equal(result['row'], 'builtin');
  assert.equal(result['builtin'], builtin);
  assert.equal(result['failed'], undefined);
});

await test('a contributed renderer that throws falls through to the built-in row and reports what it threw', () => {
  const builtin = builtinRenderer();
  const thrown = new Error('the contributed renderer is broken');
  const result = decision(() => { throw thrown; }, builtin);
  assert.equal(result['row'], 'builtin');
  assert.equal(result['builtin'], builtin);
  assert.equal(result['failed'], true);
  assert.equal(result['error'], thrown);
});

/** A contributor may throw anything, including a falsy value — `throw null` is legal JavaScript. The
 *  caller must therefore gate its report on the flag and not on the value, or a contributor that
 *  throws one fails silently. Typed `unknown` because that is what a thrown value honestly is, and
 *  because a bare `throw null` is what `only-throw-error` exists to catch in ordinary code. */
await test('a contributed renderer that throws a falsy value is still reported as failed', () => {
  const falsy: unknown = null;
  const result = decision(() => { throw falsy; }, builtinRenderer());
  assert.equal(result['row'], 'builtin');
  assert.equal(result['failed'], true);
  assert.equal(result['error'], null);
});

/** A contributor registers whatever it likes; something truthy but uncallable used to be indistinguishable
 *  from a renderer politely declining the frame. It reaches the same catch, so it is reported by name. */
await test('a contributed entry that is truthy but not callable is reported as failed, not as a decline', () => {
  const result = decision({ notAFunction: true }, builtinRenderer());
  assert.equal(result['row'], 'builtin');
  assert.equal(result['failed'], true);
  assert.ok(result['error'] instanceof TypeError);
});

await test('no contributed renderer at all goes straight to the built-in row, with nothing reported', () => {
  const builtin = builtinRenderer();
  for (const absent of [undefined, null, false, 0, '']) {
    const result = decision(absent, builtin);
    assert.equal(result['row'], 'builtin', `a ${JSON.stringify(absent)} contribution should fall through.`);
    assert.equal(result['builtin'], builtin);
    assert.equal(result['failed'], undefined);
  }
});

/** transcript.js calls the built-in optionally (`choice.builtin?.(frame)`), which is how an event kind
 *  no one renders is dropped rather than throwing. The decision must survive having neither renderer. */
await test('a kind with neither a contributed nor a built-in renderer yields a builtin decision with no renderer', () => {
  const result = decision(undefined, undefined);
  assert.equal(result['row'], 'builtin');
  assert.equal(result['builtin'], undefined);
});

/** The chooser only chooses. Drawing is `applyEvent`'s job, so a built-in renderer handed to it must
 *  come back untouched and uncalled — otherwise a fallthrough would draw the row twice. */
await test('the decision never calls the built-in renderer itself', () => {
  let calls = 0;
  const builtin = () => { calls += 1; };
  for (const contributed of [undefined, () => null, () => ({ tag: 'div' }), () => { throw new Error('boom'); }]) {
    decision(contributed, builtin);
  }
  assert.equal(calls, 0, 'chooseTranscriptRow must hand the built-in renderer back rather than invoke it.');
});
