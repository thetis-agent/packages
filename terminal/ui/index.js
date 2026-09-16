/* The browser module of @thetis/terminal. The shell calls `install(ext)` once after the page has mounted.
 * It registers the shelf entry and the statusbar chip, and holds the one thing both of them need: the
 * session table, kept live by a single `watch` subscription for the whole page.
 *
 * One subscription, not one per view, and it is opened here rather than in the shelf because the chip
 * counts shells while the shelf is closed, a screen keeps filling while nobody is looking, and opening
 * the shelf must cost no request. It is never stopped while the page lives; the shelf comes and goes
 * around it.
 *
 * The browser reconnects an EventSource by itself, and the server then starts its export again from the
 * beginning. So every value is written to be replayed: an output chunk carries the session's counter
 * after it, and a chunk at or below the counter this page has already written is dropped. The first
 * chunk of a reconnect is the whole ring buffer with `replace`, which is dropped for the same reason
 * when nothing has happened since. That is what makes a reconnect cost nothing and lose nothing.
 *
 * A stream that ends or is refused is said in the shelf head and retried with a widening delay. Nothing
 * here pretends to be live when it is not. Nothing runs at import. */

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
  const notes = new Map();     // id -> the sentence about size the row must carry, when there is one
  const watchers = new Set();  // the shelf, while it is mounted
  const pending = new Map();   // id -> keystrokes waiting for the next coalesced `write`
  let stream = { live: false, why: "Connecting to the shells…" };
  let autoOpen = true;         // the shelf opens itself once per page load, for this conversation's first command
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

  // ---- the session table ----

  function setSessions(list) {
    if (!Array.isArray(list)) return;
    sessions.clear();
    for (const session of list) if (session && typeof session.id === "string") sessions.set(session.id, session);
    for (const id of [...screens.keys()]) if (!sessions.has(id)) forget(id);
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
    // Idle again: whatever starts next starts at the size the server has, so the deferred-resize note goes.
    if (session.state === "idle") notes.delete(session.id);
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

  /** The shelf's Reconnect: try now rather than when the widening delay runs out. */
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

  // ---- what the two views are given ----

  const store = {
    list: () => [...sessions.values()],
    get: (id) => (id ? sessions.get(id) ?? null : null),
    busy: (session) => BUSY.has(session?.state),
    stream: () => stream,
    reconnect,
    screen: screenFor,
    /** A session the server has just described in an answer, so the row appears without waiting for the stream. */
    adopt(session) {
      if (!session || typeof session.id !== "string") return;
      sessions.set(session.id, session);
      settle(session);
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
  };

  // ---- the registrations ----

  ext.shelf("terminal", { mount: (root) => mountShelf(ext, store, root) });

  ext.statusbar("terminal", {
    draw(node) {
      const { el, setHidden } = ext.dom;
      const open = [...sessions.values()].filter((session) => session.state !== "closed");
      const busy = open.filter((session) => BUSY.has(session.state)).length;
      // The chip is the only way into the shelf, and the button that opens the first shell is inside it,
      // so it stays even with nothing to count: hiding it would put the terminal out of reach entirely.
      setHidden(node, false);
      const words = open.length
        ? `${open.length} ${open.length === 1 ? "shell" : "shells"}${busy ? ` · ${busy} busy` : ""}`
        : stream.live
          ? "Terminal"
          : "shells · not connected";
      const chip = el("button", {
        type: "button",
        class: `tm-chip${stream.live ? "" : " is-stale"}`,
        title: stream.live ? (open.length ? "The shells this workspace has open" : "Open a shell in this workspace") : `Not live: ${stream.why}`,
        onClick: () => ext.open.shelf("terminal"),
      }, words);
      node.append(chip);
    },
  });

  listen();
  // The subscription lives as long as the page. This only spares the gateway a stream it is still writing to.
  addEventListener("pagehide", () => {
    clearTimeout(retry);
    stop?.();
  });
}
