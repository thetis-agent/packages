/* The browser module of @thetis/terminal. The shell calls `install(ext)` once after the page has mounted.
 * It registers the shelf entry (the drawer's body) and the chip in every conversation's chat bar, and
 * holds the one thing both of them need: the session table, kept live by a single `watch` subscription
 * for the whole page.
 *
 * One subscription, not one per view, and it is opened here rather than in the drawer because the chip
 * counts shells while the drawer is closed, a screen keeps filling while nobody is looking, and opening
 * the drawer must cost no request. It is never stopped while the page lives; the drawer comes and goes
 * around it.
 *
 * The browser reconnects an EventSource by itself, and the server then starts its export again from the
 * beginning. So every value is written to be replayed: an output chunk carries the session's counter
 * after it, and a chunk at or below the counter this page has already written is dropped. The first
 * chunk of a reconnect is the whole ring buffer with `replace`, which is dropped for the same reason
 * when nothing has happened since. That is what makes a reconnect cost nothing and lose nothing.
 *
 * A stream that ends or is refused is said in the drawer's footer and retried with a widening delay.
 * Nothing here pretends to be live when it is not. Nothing runs at import.
 *
 * Two rules from the legacy drawer live here rather than in the view, because they are about the page
 * and not about the drawer's body: a shell appearing in the open conversation brings the drawer up,
 * without a click, every time; and switching conversations closes it and reopens it when the new
 * conversation has shells, so a drawer is never left standing over another conversation's shells. */

import { createScreen } from "./screen.js";
import { mountShelf } from "./shelf.js";

/** The state words that mean the session is doing something. The server computes the word; this only groups it. */
const BUSY = new Set(["busy", "busy-quiet", "person", "fullscreen"]);

const COALESCE_MS = 15;   // a paste, and a fast typist's burst, become one `write`
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export default function install(ext) {
  const sessions = new Map();  // id -> SessionState, in the order the server lists them
  const screens = new Map();   // id -> screen, one emulator per live session
  const seqs = new Map();      // id -> the highest output counter this page has written
  const notes = new Map();     // id -> the sentence about size the footer must carry, when there is one
  const known = new Set();     // ids this page has had a row for: a session outside it is one that appeared
  const hidden = new Set();    // closed rows the person removed from the list; the host keeps its record
  const watchers = new Set();  // the drawer, while it is mounted
  const outputs = new Set();   // who wants to know that a session printed, without a redraw
  const pending = new Map();   // id -> keystrokes waiting for the next coalesced `write`
  let stream = { live: false, why: "Connecting to the shells…" };
  let autoOpen = true;         // the drawer also opens itself once per page load for this conversation's first command
  let stop = null;
  let retry = null;
  let wait = FIRST_RETRY_MS;
  let writing = null;
  let sending = Promise.resolve(); // the keystrokes in flight, chained so they arrive in the order they were typed

  function changed() {
    for (const fn of watchers) {
      try {
        fn();
      } catch (err) {
        console.error("@thetis/terminal: a view threw while redrawing:", err);
      }
    }
    ext.redraw("terminal");
  }

  /** A shell of this conversation, or the person's own (opened from the drawer with no conversation). */
  const mine = (session, conversation = ext.conversation.current ?? null) =>
    !session.conversation || session.conversation === conversation;

  // ---- the session table ----

  function setSessions(list) {
    if (!Array.isArray(list)) return;
    sessions.clear();
    for (const session of list) if (session && typeof session.id === "string") sessions.set(session.id, session);
    for (const id of [...screens.keys()]) if (!sessions.has(id)) forget(id);
    for (const id of [...known]) if (!sessions.has(id)) known.delete(id);
    for (const id of [...hidden]) if (!sessions.has(id)) hidden.delete(id);
    for (const session of sessions.values()) settle(session);
  }

  function setState(session) {
    if (!session || typeof session.id !== "string") return;
    sessions.set(session.id, session); // an id this page has not seen appears here rather than being dropped
    settle(session);
  }

  function setClosed({ id, exit }) {
    const had = sessions.get(id);
    if (had) sessions.set(id, { ...had, state: "closed", lastExit: typeof exit === "number" ? exit : had.lastExit, closedAt: Date.now() });
    // The screen stays and goes read-only. The last screenful is usually the answer to why it closed, and
    // the final bytes may still be on their way: the host keeps the row for a while, and so this keeps the
    // picture for as long as the row lasts.
    screens.get(id)?.freeze();
  }

  /** What follows from a session's state, whichever value carried it. */
  function settle(session) {
    if (session.state === "closed") screens.get(session.id)?.freeze();
    // Idle again: whatever starts next starts at the size the server has, so any note about size goes.
    if (session.state === "idle") notes.delete(session.id);
    if (!known.has(session.id)) {
      known.add(session.id);
      // The point of the whole drawer: a shell appearing in the conversation on screen brings it up,
      // without a click. A shell of another conversation brightens nothing and opens nothing.
      if (session.state !== "closed" && ext.conversation.current && mine(session)) ext.open.shelf("terminal");
    }
    if (autoOpen && BUSY.has(session.state) && session.conversation && session.conversation === ext.conversation.current) {
      autoOpen = false;
      ext.open.shelf("terminal"); // once per page load, and nothing here takes the focus from the composer
    }
  }

  /** An emulator lives as long as its row: the host drops a closed session in its own time, and this follows. */
  function forget(id) {
    screens.get(id)?.dispose();
    screens.delete(id);
    seqs.delete(id);
    notes.delete(id);
  }

  function screenFor(id) {
    const session = sessions.get(id);
    if (!session) return null;
    const had = screens.get(id);
    if (had) return had;
    // A closed session keeps the screen it had, but is never given a new one: a session that was already
    // closed when this page found it has no output left anywhere to put in it.
    if (session.state === "closed") return null;
    const screen = createScreen(id, { onData: (text) => write(id, text), onReady: () => changed() });
    screens.set(id, screen);
    return screen;
  }

  function output({ id, seq, text, replace }) {
    if (typeof id !== "string" || typeof seq !== "number" || typeof text !== "string") return;
    if (seq <= (seqs.get(id) ?? -1)) return; // already written: this is a reconnect replaying itself
    const screen = screenFor(id);
    // No screen means no row yet, or a session that was already closed when this page found it. The counter
    // is left where it was on purpose, so the ring buffer arriving after the next `sessions` value is still
    // new and is still written.
    if (!screen) return;
    seqs.set(id, seq);
    if (replace) screen.reset(); // the whole ring buffer follows; what is on the screen is not it
    screen.write(text);
    // The screen changed, not the table: no redraw, only a word to the drawer so a row you are not
    // looking at can brighten. A replay of the ring buffer is not activity, and says so.
    for (const fn of outputs) {
      try {
        fn(id, Boolean(replace));
      } catch (err) {
        console.error("@thetis/terminal: a view threw on output:", err);
      }
    }
  }

  // ---- the keys ----

  /** Holds keystrokes for 15 ms, so a paste is one request and a burst of typing is one too. */
  function write(id, text) {
    if (!text) return;
    pending.set(id, (pending.get(id) ?? "") + text);
    if (writing) return;
    writing = setTimeout(flush, COALESCE_MS);
  }

  /** One batch at a time, in the order it was typed: two requests in flight could land the wrong way round. */
  function flush() {
    writing = null;
    const batch = [...pending];
    pending.clear();
    sending = sending.then(() => deliver(batch));
  }

  async function deliver(batch) {
    for (const [id, text] of batch) {
      try {
        await ext.request("write", { args: { id, text } });
      } catch (err) {
        // Said out loud: a terminal that swallows keystrokes quietly is the failure this package exists to avoid.
        ext.toast(`What you typed did not reach the shell: ${err?.message || "the gateway did not answer"}`, { tone: "error" });
      }
    }
  }

  // ---- the subscription ----

  function listen() {
    clearTimeout(retry);
    retry = null;
    try {
      stop = ext.subscribe("watch", {
        onEvent: (value) => {
          if (!stream.live) {
            stream = { live: true, why: null };
            wait = FIRST_RETRY_MS;
          }
          apply(value);
        },
        onClose: (err) => {
          stop = null;
          lost(err?.message || "the workspace ended the live stream");
        },
      });
    } catch (err) {
      // The package did not declare the stream, or the shell refused it. Nothing will arrive; say so.
      lost(err?.message || "this page cannot watch the shells");
    }
  }

  function apply(value) {
    if (!value || typeof value !== "object") return;
    if (value.ev === "output") return output(value); // the screen changed, not the table: no redraw
    if (value.ev === "sessions") setSessions(value.sessions);
    else if (value.ev === "state") setState(value.session);
    else if (value.ev === "closed") setClosed(value);
    else return;
    changed();
  }

  function lost(why) {
    stream = { live: false, why };
    retry = setTimeout(listen, wait);
    wait = Math.min(wait * 2, MAX_RETRY_MS);
    changed();
  }

  /** The drawer's Reconnect: try now rather than when the widening delay runs out. */
  function reconnect() {
    clearTimeout(retry);
    retry = null;
    wait = FIRST_RETRY_MS;
    stop?.();
    stop = null;
    stream = { live: false, why: "Connecting to the shells…" };
    changed();
    listen();
  }

  // ---- the conversation on screen ----

  /* Switching conversations: the drawer belongs to the one on screen. Closed, not merely emptied — a
   * drawer left standing over another conversation's shells is a lie — and reopened at once when this
   * conversation has shells of its own. The drawer's rows follow through `store.watch`. */
  ext.conversation.watch((id) => {
    ext.close.shelf();
    if (id && visible().some((s) => s.state !== "closed" && mine(s, id))) ext.open.shelf("terminal");
    changed();
  });

  // ---- what the two views are given ----

  /** The rows the page shows: every session but the closed ones the person tidied away. */
  const visible = () => [...sessions.values()].filter((s) => !hidden.has(s.id));

  const store = {
    list: visible,
    get: (id) => (id && !hidden.has(id) ? sessions.get(id) ?? null : null),
    /** A closed row's trash: gone from this page's list without asking; the host keeps the record. */
    hide(id) {
      if (sessions.get(id)?.state !== "closed") return;
      hidden.add(id);
      changed();
    },
    busy: (session) => BUSY.has(session?.state),
    mine,
    /** The title of a conversation this page knows, for a row of a shell opened elsewhere. */
    conversationTitle: (id) => ext.sessions.list().find((s) => s.id === id)?.title?.trim() || null,
    stream: () => stream,
    reconnect,
    screen: screenFor,
    /** A session the server has just described in an answer, so the row appears without waiting for the stream.
     *  A row the stream has already delivered is left alone: the stream's record is the fresher one, and the
     *  answer to `open` can arrive after the state event that says the new shell is already at its prompt. */
    adopt(session) {
      if (!session || typeof session.id !== "string") return;
      if (!sessions.has(session.id)) {
        sessions.set(session.id, session);
        settle(session);
      }
      changed();
    },
    note: (id) => notes.get(id) ?? null,
    setNote(id, text) {
      if ((notes.get(id) ?? null) === (text ?? null)) return; // the same sentence again is not a change
      if (text) notes.set(id, text);
      else notes.delete(id);
      changed();
    },
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    watchOutput(fn) {
      outputs.add(fn);
      return () => outputs.delete(fn);
    },
  };

  // ---- the registrations ----

  ext.shelf("terminal", { mount: (root, shelf) => mountShelf(ext, store, root, shelf) });

  /* The chip in the chat bar, one per conversation pane: the legacy header chip. A dot in the app's own
   * colours (it lives in the app's chrome, not in the device) and a count of the shells of that
   * conversation plus the person's own, or the word alone when there are none — it stays, because it is
   * the way into the drawer and the button that opens the first shell is inside it. */
  ext.chip("terminal", {
    draw(button, { session } = {}) {
      const { el, clear, setHidden } = ext.dom;
      const rows = visible().filter((s) => mine(s, session ?? null));
      const live = rows.filter((s) => s.state !== "closed").length;
      const busy = rows.some((s) => BUSY.has(s.state));
      const open = ext.shelf.isOpen();
      button.classList.add("term-chip");
      button.classList.toggle("is-busy", busy);
      button.classList.toggle("is-on", open);
      button.classList.toggle("is-stale", !stream.live);
      clear(button).append(
        el("span", { class: `term-dot ${busy ? "is-busy" : live ? "is-ok" : "is-done"}` }),
        el("span", {}, rows.length ? `${rows.length} terminal${rows.length === 1 ? "" : "s"}` : "Terminal")
      );
      button.title = !stream.live
        ? `Not live: ${stream.why}`
        : open
          ? "Hide the terminal drawer"
          : "Show the shells this conversation has open";
      setHidden(button, false);
    },
    /** Click toggles the drawer; opening it also uncollapses it, which the shelf does on its own. */
    open() {
      if (ext.shelf.isOpen()) ext.close.shelf();
      else ext.open.shelf("terminal");
      ext.redraw("terminal");
    },
  });

  listen();
  // The subscription lives as long as the page. This only spares the gateway a stream it is still writing to.
  addEventListener("pagehide", () => {
    clearTimeout(retry);
    stop?.();
  });
}
