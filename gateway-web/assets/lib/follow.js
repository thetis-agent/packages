/* Whether the reader is following the bottom of a transcript, and when to bring the view back down.
 *
 * views/transcript.js used to decide this by sampling — `atBottom()` was read once, at the moment a
 * row was appended, and a row that grew *after* it was placed never re-stuck. Driving the shipped
 * surface with a browser found what that costs, measuring `(scrollHeight - clientHeight) -
 * scrollTop` on `.transcript` at every step.
 *
 * Two ordinary turns, nothing but appends: behind by 0. Appends stick, and always did; that path is
 * not what is broken. A third turn ending in an `ask_user` question: behind by 233, immediately,
 * with nobody having touched anything. tools-ask places a compact "A question for you — Waiting for
 * your answer" header and then fills the row in, and the filling happens after `place()` has taken
 * its sample. The header sat flush against the bottom edge of the viewport with the question itself
 * — the text, three radio options, the Send answer button — entirely below the fold and nothing on
 * screen to suggest there was more. Somebody is told a question is waiting and cannot see what it
 * is. Answering it from the rail grew the row again and pushed it further out (to ~270), and from
 * then on every later append sampled that stale distance, found it over the slack, and refused to
 * stick as well: a whole turn — a typed message, its image attachment, and the reply — arrived
 * below the fold with no sign anything had happened (scrollTop 823, maximum 1095).
 *
 * So the miss is not one frame. Once it falls behind it stays behind for the rest of the
 * conversation, and the person has to scroll by hand. Note also what it is *not*: it is not about
 * answering a question, and a fix that re-stuck when a question was answered would have left the
 * first render — the 233 above, the one nobody asked for — exactly as broken. Any row that changes
 * size after it was placed does this.
 *
 * So following is held as *state* here rather than sampled at the call site, and exactly one thing
 * moves it: the reader's own scrolling. Content changing size never does. That inversion is the
 * whole fix — growth is the moment to *act* on the flag, never the moment to re-read it.
 *
 * The direction of a scroll is what separates the reader from us, and it has to, because
 * `.transcript` is `scroll-behavior: smooth` (app.css). Setting `scrollTop` there does not land
 * immediately — it animates, firing scroll events at every intermediate position on the way down,
 * each of them short of the bottom. A rule that cleared the flag whenever a scroll event arrived
 * away from the bottom would clear it on our own animation, which is a second way to arrive at
 * exactly the bug above. A transcript only ever grows downwards, so our catch-up only ever moves
 * the position *forward*; a reader leaving the bottom can only do it by moving *back*. Hence: any
 * scroll that lands within `limits.bottomSlackPx` of the bottom means following, a scroll that
 * moves backwards from the last known position means not following, and anything else — a smooth
 * animation still on its way, a drag further down that has not arrived yet — leaves the flag alone.
 *
 * No DOM here: the three things this needs from the element are injected, which is what lets
 * follow.test.ts walk the sequence the browser walked with no document, the way cursors.test.ts
 * walks a disconnect with no socket.
 */

export const limits = {
  /** How near the bottom still counts as reading the bottom. It is slack, not a threshold to be
   *  tuned: sub-pixel rounding of `scrollHeight` against `clientHeight`, a last row whose final
   *  line is a few pixels under the fold, and the momentum tail of a flick all land a little short
   *  of zero, and treating any of them as "this person has scrolled away to read history" would
   *  stop the transcript following for somebody who never asked it to. Carried over unchanged from
   *  the value views/transcript.js sampled with, so appends behave exactly as they did. */
  bottomSlackPx: 48,
};

/**
 * @param {object} element  the scroller, as three functions rather than a node
 * @param {() => number} element.distanceFromBottom  `scrollHeight - scrollTop - clientHeight`
 * @param {() => number} element.scrollPosition  `scrollTop`
 * @param {() => void} element.scrollToBottom  puts `scrollTop` at `scrollHeight`
 */
export function createFollow({ distanceFromBottom, scrollPosition, scrollToBottom }) {
  /** True while the reader is reading the newest thing. A transcript opens empty and therefore at
   *  its own bottom, so it starts true and stays true until somebody scrolls back. */
  let following = true;
  /** The position the last scroll event reported, so the next one can be read as forwards or
   *  backwards. Only scroll events write it: our own catch-up is told about by the scroll events it
   *  causes, like any other movement, rather than being bookkept separately. */
  let at = 0;

  /** Bring the view back to the bottom when the reader is following, and deliberately do not look
   *  at where the view currently is: whatever just changed the content is exactly what moved it
   *  away from the bottom, so measuring here would refuse every case this module exists for. */
  function catchUp() {
    if (following) scrollToBottom();
  }

  return {
    /** Whether the view is currently following the bottom. Read by follow.test.ts; the surface acts
     *  through `placed` and `grew` rather than branching on this itself. */
    get following() {
      return following;
    },

    /** Records one `scroll` event from the element. Cheap enough to run unthrottled on every one:
     *  two reads and a comparison, no layout written. */
    scrolled() {
      const position = scrollPosition();
      const backwards = position < at;
      at = position;
      // Arriving at the bottom means following, however it was arrived at — by our own catch-up
      // finishing, by a drag, or by the reader coming back down after reading history. This comes
      // first so that a small backwards nudge that is still effectively at the bottom does not read
      // as leaving it.
      if (distanceFromBottom() <= limits.bottomSlackPx) { following = true; return; }
      if (backwards) following = false;
    },

    /* The two things that move the bottom of a transcript, named separately because the bug this
     * module was written for is precisely that one of them was handled and the other was not, and a
     * single method would let a future edit quietly drop the second again. They share one body
     * today; either may need its own answer later — growth arrives in bursts while a diagram lays
     * out, and debouncing it would be this module's business rather than the caller's. */

    /** A row was appended to the transcript. */
    placed() {
      catchUp();
    },

    /** A row already placed changed size: rewritten in place by a contributed renderer, an `<img>`
     *  that finished loading, an SVG that laid out late. Never yanks back somebody who has scrolled
     *  up to read — the flag says whether they are following, and growth does not get a vote. */
    grew() {
      catchUp();
    },

    /** A transcript being rebuilt from nothing — a reset, or a restore from saved messages. The
     *  element is emptied and its position goes to zero, which is its bottom as well as its top. */
    reset() {
      following = true;
      at = 0;
    },
  };
}
