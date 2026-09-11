/* The bookkeeping behind a contributed panel's one way to act; ADR 0051.
 *
 * `lib/surface.js` is the seam a panel imports and it touches the store, the rail and the DOM, none
 * of which exist under test. The two decisions worth testing have none of that: which package is
 * calling, and which promise an answer belongs to. They live here, apart from the sending, for the
 * same reason lib/dispatch.js lives apart from the drawing — there is no DOM harness in this repo,
 * and a decision with branches is worth more tested than inlined. Keep it that way: an import of
 * ./dom.js or ./store.js here would take requests.test.ts with it.
 */

/** Which package a call came from, read out of a stack rather than taken as an argument.
 *
 * Every contributed module is served from `/surface/<package>/` and nowhere else — the same schema
 * rule that stops one contributor serving over another (contract/surface) — so the first such path
 * above the seam names the caller. A panel cannot forge the stack of its own call, which is the
 * point: were the package a parameter, one contributed panel could send another contributor's
 * declared verbs, and the review that fixes a package's reach would have fixed the wrong package's.
 * The seam itself is served from `/lib/`, so it never matches itself.
 *
 * @param {string | undefined} stack  a captured `Error.prototype.stack`, whose format differs by
 *   browser; only the served path is read, which every format carries.
 * @returns {string | null}
 */
export function packageOf(stack) {
  const match = /\/surface\/([a-z][a-z0-9-]{0,63})\//.exec(stack ?? "");
  return match ? match[1] : null;
}

/** Requests sent and not yet answered, each with the promise that is waiting on it.
 *
 * Bounded for the same reason the host bounds its side (gateway-web/surface-request.ts): a panel that
 * asks faster than the environment answers is told no, once, rather than accumulating promises
 * nobody will ever settle. Every request also carries a timer, so a panel is never left waiting on a
 * connection that dropped between the send and the answer.
 */
export class Pending {
  /**
   * @param {object} [options]
   * @param {number} [options.max]        requests outstanding at once
   * @param {number} [options.timeoutMs]  longer than the host's own deadline, so this fires only
   *   when nothing is coming back at all rather than racing a slow but honest answer
   * @param {(run: () => void, ms: number) => unknown} [options.schedule]
   * @param {(handle: unknown) => void} [options.cancel]
   */
  constructor({ max = 8, timeoutMs = 35000, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.waiting = new Map();
    this.max = max;
    this.timeoutMs = timeoutMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.sequence = 0;
  }

  get full() { return this.waiting.size >= this.max; }

  /** Records one request and returns the id the answer will name. */
  open(resolve, reject) {
    const id = `s${String(++this.sequence)}`;
    const timer = this.schedule(() => {
      this.waiting.delete(id);
      reject(new Error("That did not work. Nothing was changed."));
    }, this.timeoutMs);
    this.waiting.set(id, { resolve, reject, timer });
    return id;
  }

  /** Drops a request nobody will answer, because the send itself failed. */
  drop(id) {
    const pending = this.waiting.get(id);
    if (!pending) return;
    this.waiting.delete(id);
    this.cancel(pending.timer);
  }

  /** Settles the one request that asked, and no other: the id is this module's own, so a frame
   *  naming anything else is dropped rather than guessed at. */
  settle(frame) {
    const pending = this.waiting.get(frame.request);
    if (!pending) return false;
    this.waiting.delete(frame.request);
    this.cancel(pending.timer);
    if (frame.ok) pending.resolve({ text: frame.text ?? "", data: frame.data ?? {} });
    else pending.reject(new Error(frame.message || "That did not work. Nothing was changed."));
    return true;
  }
}
