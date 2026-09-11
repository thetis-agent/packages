/** Guard the transcript following the bottom of a live conversation; ADR 0005.
 *
 * Driving the shipped surface with a browser found this, measuring `(scrollHeight - clientHeight) -
 * scrollTop` on `.transcript` at every step. Two ordinary turns of nothing but appends: behind by
 * 0 — appends stick, and always did. A third turn ending in an `ask_user` question: behind by 233
 * on the question row's *first* render, with nobody having touched anything, because `tools-ask`
 * places a compact "A question for you — Waiting for your answer" header and fills the row in
 * afterwards, by which time `place()` has taken its sample. The header sat flush against the bottom
 * edge and the question — its text, three radio options, the Send answer button — was entirely
 * below the fold with nothing on screen to say so. Answering it from the rail grew the row again
 * (to ~270 behind), and every later append then sampled that stale distance, found it over the
 * slack, and refused to stick too: a whole turn — a typed message, its image attachment and the
 * reply — arrived out of sight (scrollTop 823, maximum 1095). It never recovered.
 *
 * So the case to cover is a row that grows after it was placed while the view was at the bottom,
 * with no scrolling by anybody anywhere in the sequence — and the growth is driven here as growth
 * rather than as an answer, because a fix that re-stuck only when a question was answered would
 * have left that first render broken.
 *
 * So the decision moved out of `assets/views/transcript.js` and into `assets/lib/follow.js`, where
 * following is state the reader's own scroll events move rather than a measurement taken at append
 * time — and where it can be walked with no document, the way cursors.test.ts walks a disconnect
 * with no socket and dispatch.test.ts walks the renderer choice with no DOM. There is no DOM
 * harness in this repository and adding one (jsdom, linkedom) would buy these tests a dependency
 * the house rules do not want; the module takes its three element operations as functions instead,
 * so the scroller below is plain arithmetic.
 *
 * The two things that move the bottom are separate calls — `placed` for an appended row, `grew` for
 * a row that changed size after the fact — which is how these tests were checked against the
 * behaviour they describe. Empty `grew`, which is the shipped surface exactly (it has no hook for
 * growth at all, only `place`), and "a row that grows after it was placed" fails on its second
 * assertion with the view 200px short of the bottom, while every plain append still passes. Go the
 * other way and decide by measuring rather than remembering — `if (distanceFromBottom() <= slack)`
 * inside the catch-up, which is the sample the old `place` took — and six of the seven fail,
 * because a measurement taken after the content moved is a measurement of the problem.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

interface Element { distanceFromBottom: () => number; scrollPosition: () => number; scrollToBottom: () => void }
interface Follow { readonly following: boolean; scrolled: () => void; placed: () => void; grew: () => void; reset: () => void }

const here = dirname(fileURLToPath(import.meta.url));
const loaded: unknown = await import(pathToFileURL(join(here, 'assets/lib/follow.js')).href);
assert.ok(isObject(loaded), 'assets/lib/follow.js should load as a module namespace object.');
const factory: unknown = loaded['createFollow'];
assert.equal(typeof factory, 'function', 'assets/lib/follow.js should export createFollow as a function.');
const bounds: unknown = loaded['limits'];
assert.ok(isObject(bounds), 'assets/lib/follow.js should export its bounds object.');
const declared: unknown = bounds['bottomSlackPx'];
assert.ok(typeof declared === 'number', 'assets/lib/follow.js should name its bottom slack, per the house rule about bounds.');
const slack: number = declared;

/** The scroller, as the three numbers a transcript pane actually has.
 *
 *  `scrollToBottom` sets a target instead of moving, because `.transcript` is `scroll-behavior:
 *  smooth` (app.css): the real element animates and reports every position on the way. `settle`
 *  delivers the arrival, `glide` delivers some of the positions before it, and `reader` is a person
 *  dragging — which, like a real one, cancels whatever animation was running. */
function scroller(view: number): {
  follow: Follow; top: () => number; bottom: () => number;
  place: (px: number) => void; grow: (px: number) => void; observed: () => void;
  settle: () => void; glide: (steps: number) => void; reader: (to: number) => void;
} {
  let height = 0;
  let top = 0;
  let target: number | null = null;
  const bottom = (): number => Math.max(0, height - view);
  const follow = (factory as (element: Element) => Follow)({
    distanceFromBottom: () => height - top - view,
    scrollPosition: () => top,
    scrollToBottom: () => { target = height; },
  });
  const settle = (): void => {
    if (target === null) return;
    top = Math.min(target, bottom()); target = null; follow.scrolled();
  };
  return {
    follow, bottom, top: () => top,
    /** A row appended: the content gets taller, then the transcript asks to catch up. */
    place: (px) => { height += px; follow.placed(); },
    /** A row already on screen getting taller — rewritten in place, or an image that finished
     *  loading. Moves no scroll position and fires no scroll event, which is the whole problem. */
    grow: (px) => { height += px; },
    /** The ResizeObserver in views/transcript.js noticing that growth. */
    observed: () => { follow.grew(); },
    settle,
    /** `steps` positions reported by an animation that has not arrived yet. */
    glide: (steps) => {
      if (target === null) return;
      const end = Math.min(target, bottom());
      for (let step = 1; step <= steps; step += 1) { top += (end - top) / (steps + 1); follow.scrolled(); }
    },
    reader: (to) => { target = null; top = to; follow.scrolled(); },
  };
}

/** The question row, exactly as the browser drew it: a header placed compact and flush against the
 *  bottom edge, then filled in 233px taller where `place()` can no longer see it. Nobody scrolls
 *  anywhere in this sequence — the drift needs no interaction at all, which is why it is growth and
 *  not an answer that has to be the thing that brings the view back down. */
await test('a row that grows after it was placed brings the view back down', () => {
  const pane = scroller(600);
  pane.place(800);
  pane.settle();
  assert.equal(pane.top(), pane.bottom(), 'two turns of plain appends are behind by nothing; that path was never broken.');
  pane.grow(233);
  pane.observed();
  pane.settle();
  assert.equal(pane.top(), pane.bottom(), 'the filled-in row must not leave the question below the fold.');
  assert.equal(pane.follow.following, true);
});

/** The half of the bug that made it worth fixing: not the one frame that was missed, but that every
 *  frame after it was missed too, because the stale distance was what the next append measured. */
await test('a growth that went unobserved does not stop the next append catching up', () => {
  const pane = scroller(600);
  pane.place(800);
  pane.settle();
  // A row outside the watched window grows, so nothing catches up and the view is left behind —
  // the ~270 the browser measured once the question had been answered as well as drawn.
  pane.grow(270);
  assert.ok(pane.top() < pane.bottom(), 'the view really is short of the bottom here.');
  // A message, an image attachment and a reply — the turn that vanished below the fold.
  pane.place(120);
  pane.settle();
  assert.equal(pane.top(), pane.bottom(), 'being behind is not consent to stay behind.');
});

await test('a deliberate scroll up is left alone, however much arrives afterwards', () => {
  const pane = scroller(600);
  pane.place(1200);
  pane.settle();
  const reading = pane.bottom() - 400;
  pane.reader(reading);
  assert.equal(pane.follow.following, false);
  pane.place(150);
  pane.settle();
  assert.equal(pane.top(), reading, 'nobody reading history may be yanked to the bottom by a new row.');
  pane.grow(200);
  pane.observed();
  pane.settle();
  assert.equal(pane.top(), reading, 'nor by a row that grew.');
  assert.equal(pane.follow.following, false, 'and it stays cleared until they come back down.');
});

await test('coming back down to the bottom starts the transcript following again', () => {
  const pane = scroller(600);
  pane.place(1200);
  pane.settle();
  pane.reader(pane.bottom() - 400);
  pane.reader(pane.bottom());
  assert.equal(pane.follow.following, true);
  pane.place(300);
  pane.settle();
  assert.equal(pane.top(), pane.bottom());
});

/** `.transcript` scrolls smoothly, so a catch-up reports a run of positions short of the bottom
 *  before it arrives. Reading "not at the bottom" off any of them as "the reader has scrolled away"
 *  would clear the flag on our own animation — a second route to the stranded view above. */
await test('a catch-up still on its way is not mistaken for the reader scrolling away', () => {
  const pane = scroller(600);
  pane.place(1500);
  pane.glide(3);
  assert.ok(pane.top() < pane.bottom() - slack, 'the animation really is still short of the bottom.');
  assert.equal(pane.follow.following, true);
  pane.place(60);
  pane.settle();
  assert.equal(pane.top(), pane.bottom(), 'a row arriving mid-animation still sticks.');
});

/** Sub-pixel rounding, a last line a few pixels under the fold and the tail of a flick all land a
 *  little short of zero, and none of them is somebody asking to stop following. */
await test('a position within the slack of the bottom still counts as following', () => {
  const pane = scroller(600);
  pane.place(1200);
  pane.settle();
  pane.reader(pane.bottom() - (slack - 1));
  assert.equal(pane.follow.following, true);
  pane.reader(pane.bottom() - (slack + 200));
  assert.equal(pane.follow.following, false);
});

/** A transcript rebuilt — a reset, or a restore from the saved messages an open brings with it —
 *  starts at its own bottom, whatever the reader was doing with the conversation it replaced. */
await test('a rebuilt transcript follows again', () => {
  const pane = scroller(600);
  pane.place(1200);
  pane.settle();
  pane.reader(0);
  assert.equal(pane.follow.following, false);
  pane.follow.reset();
  assert.equal(pane.follow.following, true);
  pane.place(300);
  pane.settle();
  assert.equal(pane.top(), pane.bottom());
});
