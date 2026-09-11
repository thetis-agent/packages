/* Where each conversation got to, so a dropped connection does not lose what happened while it was
 * down.
 *
 * The host keeps a bounded window of recent events per conversation and will replay from any position
 * still inside it (`wire.ts`'s `cursor-replay` capability; `lib/session/index.ts` holds the window).
 * Every event frame says which position it came from, so this module's whole job is to remember the
 * last position actually *drawn* — not the last one the host mentioned — and to hand that back when
 * the socket comes up again.
 *
 * "Actually drawn" is the part that matters. The `opened` reply names where the host has reached,
 * which on a resume is ahead of the replay still to arrive; adopting it would mean a second drop,
 * mid-replay, skipping exactly the events the first drop had already cost. So a resume never takes a
 * position from `opened` — only frames move it — while a plain open takes it wholesale, because a
 * plain open comes with the saved transcript and starts the conversation's reading over from there.
 *
 * No DOM here, and no socket either: this module is handed frames and returns commands, which is what
 * lets cursors.test.ts walk a whole disconnect without a browser.
 */

export function createCursors() {
  /** Conversation id -> the last position this client drew. */
  const seen = new Map();
  /** Conversation id -> the position a re-open is currently asking to continue from. Present only
   *  between sending the command and its `opened` reply, which is how the reply knows which kind of
   *  open it is answering without the host having to say. */
  const asked = new Map();
  /** Conversations already told that events were lost, so the same sentence is not repeated at every
   *  reconnect for the rest of the page's life. Cleared when a conversation resumes cleanly again,
   *  because by then it is a new gap rather than the old one. */
  const told = new Set();

  return {
    /** The command to open `id` from the beginning — a conversation a person just asked for, which
     *  comes with its saved transcript. Any resume this client was waiting on is abandoned, so the
     *  reply is read as the plain open it is. */
    openFrame(id) {
      asked.delete(id);
      return { type: "open", id };
    },

    /** The command to re-open `id` after the connection came back: continuing where this client left
     *  off when it knows where that was, and from the beginning when it does not. */
    resumeFrame(id) {
      const from = seen.get(id);
      if (from === undefined) { asked.delete(id); return { type: "open", id }; }
      asked.set(id, from);
      return { type: "open", id, from };
    },

    /** Records an `opened` reply. Returns whether this is the moment to tell the person that some of
     *  the conversation could not be brought back. */
    opened(id, frame) {
      const resumed = asked.delete(id);
      const lost = frame.gap === true;
      // A resume that worked leaves the position alone: the replayed frames move it themselves, and
      // each one that arrives is one a later drop will not have to ask for again.
      if (lost || !resumed) {
        if (typeof frame.cursor === "number") seen.set(id, frame.cursor);
        else seen.delete(id);
      }
      if (!lost) { told.delete(id); return { lost: false }; }
      const first = !told.has(id);
      told.add(id);
      return { lost: first };
    },

    /** Records that a frame was drawn. Positions only ever move forward: a replay and the live stream
     *  can overlap after a reconnect, and the later of the two is the one that has been read. */
    drew(id, cursor) {
      if (typeof id !== "string" || typeof cursor !== "number") return;
      const at = seen.get(id);
      if (at === undefined || cursor > at) seen.set(id, cursor);
    },

    /** Where `id` got to, or undefined for a conversation this client has drawn nothing of. */
    at(id) {
      return seen.get(id);
    },
  };
}
