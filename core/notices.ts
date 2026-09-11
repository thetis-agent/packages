/** Carry a stage's emitted notice from the worker's boundary to the conversation it belongs to; TE-029.
 *
 * `contract/turn-events` gives a stage one way to speak between turns: `ctx.emit`, which the package
 * loader validates and posts across the worker boundary as a message, and which the monitor collects.
 * That collection was the end of the road — `Loop.notice`, the method that queues one into the next
 * turn, had no caller — so a handle a `pending` call promised was never redeemed and a background
 * stage's line never reached anybody. This is the missing segment, and it is deliberately the whole of
 * it: the loader still validates, the monitor still observes, `Loop` still decides what a queued
 * notice does at the turn boundary.
 *
 * The queue is here rather than in `Loop` because a `Loop` is per-conversation and lives only as long
 * as a lease on it (sessions.ts): the conversation a notice is for is very often not loaded when the
 * notice arrives, and a queue inside an object that is about to be collected is not a queue. It is
 * drained at the top of a submit, which is the point the contract names — "at the next turn boundary
 * each queued notice becomes a `tool` message in `history`".
 *
 * A notice names its own conversation. Nothing else could: the emitting stage is the only thing that
 * knows which conversation the work it is reporting on belongs to, and a call request carries no
 * conversation for it to have been inferred from. One that names none is dropped rather than
 * broadcast — a line delivered to every conversation is worse than one delivered to none.
 */
import type { Notice } from '@/contracts/turn-events/types.ts';

/** Notices held for conversations that are not loaded, and per conversation. Both bounded: a stage
 *  that emits faster than its conversations are spoken to must not grow this without end, and the
 *  oldest notice for a conversation nobody has opened is the one least worth keeping. */
export const limits = { conversations: 64, perConversation: 64 };

export class NoticeQueue {
  readonly #queued = new Map<string, { source: string; notice: Notice }[]>();

  /** Accepts one notice for a conversation, or drops it and says why. */
  add(source: string, notice: Notice): boolean {
    const conversation = notice['conversation'];
    if (typeof conversation !== 'string' || !conversation) return false;
    const held = this.#queued.get(conversation) ?? [];
    if (held.length >= limits.perConversation) return false;
    if (!this.#queued.has(conversation) && this.#queued.size >= limits.conversations) {
      const oldest = this.#queued.keys().next().value; if (oldest !== undefined) this.#queued.delete(oldest);
    }
    held.push({ source, notice }); this.#queued.set(conversation, held);
    return true;
  }

  /** Everything waiting for one conversation, in the order it arrived, and empties it. */
  take(conversation: string): { source: string; notice: Notice }[] {
    const held = this.#queued.get(conversation) ?? [];
    this.#queued.delete(conversation);
    return held;
  }
}
