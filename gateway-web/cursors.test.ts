/** Guard the bookkeeping that lets a reconnect resume instead of losing events; ADR 0019, KS-004.
 *
 * `wire.ts` advertises `cursor-replay` and `#subscribe` honours a `from`, but the whole value of that
 * depends on the surface asking to continue from a position it has actually drawn. Two rules carry
 * that, and both are easy to break by accident:
 *   - a resume must not adopt the position `opened` reports, because on a resume the host names where
 *     *it* has reached and the replay has not arrived yet; a second drop would then start past it;
 *   - a plain open must adopt it, because a plain open comes with the saved transcript instead.
 * `assets/lib/cursors.js` exists apart from app.js so both can be walked with no socket and no
 * document, the way dispatch.test.ts walks the renderer choice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

type Frame = Record<string, unknown>;
type Cursors = {
  openFrame: (id: string) => Frame;
  resumeFrame: (id: string) => Frame;
  opened: (id: string, frame: Frame) => { lost: boolean };
  drew: (id: unknown, cursor: unknown) => void;
  at: (id: string) => number | undefined;
};

const here = dirname(fileURLToPath(import.meta.url));
const loaded: unknown = await import(pathToFileURL(join(here, 'assets/lib/cursors.js')).href);
assert.ok(isObject(loaded), 'assets/lib/cursors.js should load as a module namespace object.');
const factory: unknown = loaded['createCursors'];
assert.equal(typeof factory, 'function', 'assets/lib/cursors.js should export createCursors as a function.');
function fresh(): Cursors { return (factory as () => Cursors)(); }

await test('a conversation nothing has been drawn of re-opens from the beginning', () => {
  const cursors = fresh();
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1' });
  assert.equal(cursors.at('c1'), undefined);
});

/** A person opening a conversation asks for it whole; a resume this client had in flight must not
 *  make the reply read as a continuation of something. */
await test('a plain open abandons a resume that was still in flight', () => {
  const cursors = fresh();
  cursors.drew('c1', 4);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1', from: 4 });
  assert.deepEqual(cursors.openFrame('c1'), { type: 'open', id: 'c1' });
  assert.deepEqual(cursors.opened('c1', { cursor: 40, oldest: 1, history: { messages: [] } }), { lost: false });
  assert.equal(cursors.at('c1'), 40, 'a transcript rebuilt from the saved messages continues from where the host is.');
});

await test('a plain open adopts the position the host reports, because it brought the saved transcript with it', () => {
  const cursors = fresh();
  cursors.resumeFrame('c1');
  assert.deepEqual(cursors.opened('c1', { cursor: 12, oldest: 1, history: { messages: [] } }), { lost: false });
  assert.equal(cursors.at('c1'), 12);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1', from: 12 });
});

/** The bug this module exists to prevent, walked end to end: draw some of a conversation, lose the
 *  connection, come back, and ask for exactly what was missed rather than for whatever is newest. */
await test('a reconnect asks to continue from the last frame actually drawn', () => {
  const cursors = fresh();
  cursors.resumeFrame('c1');
  cursors.opened('c1', { cursor: 0, oldest: 1 });
  for (const cursor of [1, 2, 3, 4]) cursors.drew('c1', cursor);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1', from: 4 });
  // The host has reached 40 while the connection was down; the replay of 5..40 has not arrived yet.
  assert.deepEqual(cursors.opened('c1', { cursor: 40, oldest: 1 }), { lost: false });
  assert.equal(cursors.at('c1'), 4, 'a resume must not adopt a position whose events have not been drawn.');
  cursors.drew('c1', 5); cursors.drew('c1', 6);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1', from: 6 }, 'a second drop mid-replay resumes from what the first one delivered.');
});

await test('positions only move forward, so an overlapping replay cannot wind one back', () => {
  const cursors = fresh();
  cursors.drew('c1', 9);
  cursors.drew('c1', 4);
  cursors.drew('c1', 7);
  assert.equal(cursors.at('c1'), 9);
  cursors.drew('c1', 11);
  assert.equal(cursors.at('c1'), 11);
});

/** Frames the projection produced nothing for carry no position, and a frame that belongs to no
 *  conversation (the wire's own `error`) carries no id. Neither may move anything. */
await test('a frame with no position, or no conversation, moves nothing', () => {
  const cursors = fresh();
  cursors.drew('c1', 3);
  cursors.drew('c1', undefined);
  cursors.drew(undefined, 9);
  cursors.drew('c1', '4');
  assert.equal(cursors.at('c1'), 3);
});

/** When the host cannot replay that far it subscribes plainly instead and says so with `gap`. The
 *  surface then rebuilds from the saved transcript that came with it, so the position is taken
 *  wholesale — and the person is told, once. */
await test('a refused resume resets the position, and is reported exactly once', () => {
  const cursors = fresh();
  cursors.drew('c1', 4);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1', from: 4 });
  assert.deepEqual(cursors.opened('c1', { cursor: 900, oldest: 800, gap: true, history: { messages: [] } }), { lost: true });
  assert.equal(cursors.at('c1'), 900, 'a rebuilt transcript continues from where the host actually is.');
  cursors.resumeFrame('c1');
  assert.deepEqual(cursors.opened('c1', { cursor: 901, oldest: 800, gap: true }), { lost: false }, 'the same gap must not be announced at every reconnect.');
});

await test('a conversation that resumes cleanly again may be told about a later gap', () => {
  const cursors = fresh();
  cursors.drew('c1', 4);
  cursors.resumeFrame('c1');
  assert.deepEqual(cursors.opened('c1', { cursor: 900, oldest: 800, gap: true }), { lost: true });
  cursors.resumeFrame('c1');
  assert.deepEqual(cursors.opened('c1', { cursor: 901, oldest: 800 }), { lost: false });
  cursors.drew('c1', 902);
  cursors.resumeFrame('c1');
  assert.deepEqual(cursors.opened('c1', { cursor: 3, oldest: 1, gap: true }), { lost: true }, 'a fresh gap is a fresh thing to say.');
});

await test('conversations keep their own positions, and a gap in one says nothing about another', () => {
  const cursors = fresh();
  cursors.drew('c1', 5); cursors.drew('c2', 11);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1', from: 5 });
  assert.deepEqual(cursors.resumeFrame('c2'), { type: 'open', id: 'c2', from: 11 });
  assert.deepEqual(cursors.opened('c1', { cursor: 0, gap: true }), { lost: true });
  assert.equal(cursors.at('c2'), 11);
  assert.deepEqual(cursors.opened('c2', { cursor: 40 }), { lost: false });
  assert.equal(cursors.at('c2'), 11);
});

/** An `opened` for a subscription the socket already had carries no position at all (wire.ts's
 *  `#open` early return). Adopting `undefined` as a number would poison the next resume. */
await test('an opened frame with no position at all leaves nothing to resume from', () => {
  const cursors = fresh();
  cursors.drew('c1', 5);
  assert.deepEqual(cursors.opened('c1', { session: 'c1' }), { lost: false });
  assert.equal(cursors.at('c1'), undefined);
  assert.deepEqual(cursors.resumeFrame('c1'), { type: 'open', id: 'c1' });
});
