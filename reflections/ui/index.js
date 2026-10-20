/* The browser module of @thetis/reflections. The shell calls `install(ext)` once; it registers the chip
 * and the Reflections place. The chip asks `get` for the conversation on screen when it changes, when the
 * sidebar's list changes (an archive or a restore), and every few seconds while a reflection of it is
 * queued or running; it is hidden for a conversation that is neither archived nor reflected. Clicking it
 * opens the place at that conversation. Nothing runs at import. */

import { openPlace } from "./place.js";
import { chipVisible, describe } from "./state.js";

const POLL_MS = 4000;
const CACHE_MAX = 32;

export default function install(ext) {
  const { setHidden } = ext.dom;
  const views = new Map(); // session -> the `get` answer
  const asked = new Set(); // sessions with a request on its way
  let timer = null;

  const archivedOf = (session) => (ext.sessions.list() ?? []).find((s) => s.id === session)?.archived === true;

  async function refresh(session) {
    if (!session || asked.has(session)) return;
    asked.add(session);
    try {
      const out = await ext.request("call", { args: { op: "get", session } });
      if (out?.data) {
        views.delete(session);
        views.set(session, out.data);
        if (views.size > CACHE_MAX) views.delete(views.keys().next().value);
      }
    } catch {
      // A gateway without the service still answers `get` from the files; a refusal here leaves the chip hidden.
    } finally {
      asked.delete(session);
      ext.redraw("reflection");
      schedule();
    }
  }

  /** Polls only while the conversation on screen has a reflection on its way. */
  function schedule() {
    clearTimeout(timer);
    const session = ext.conversation.current;
    const state = views.get(session)?.record?.state;
    if (session && (state === "queued" || state === "running")) {
      timer = setTimeout(() => refresh(session), POLL_MS);
      timer.unref?.(); // a browser timer is a number; under node a test may end while one waits
    }
  }

  ext.conversation.watch((session) => {
    if (session) refresh(session);
    else schedule();
  });
  ext.sessions.watch(() => {
    const session = ext.conversation.current;
    if (session) refresh(session);
  });

  ext.chip("reflection", {
    draw(button, { session }) {
      const view = views.get(session);
      if (!view) {
        if (session) refresh(session);
        setHidden(button, true);
        return;
      }
      const archived = archivedOf(session) || view.archived;
      if (!chipVisible(view.record, archived)) {
        setHidden(button, true);
        return;
      }
      const d = describe(view.record);
      setHidden(button, false);
      button.classList.add("rfl-chip");
      for (const tone of ["ok", "err", "accent", "dim"]) button.classList.toggle(`is-${tone}`, d.tone === tone);
      button.classList.toggle("is-busy", Boolean(d.busy));
      button.textContent = d.label;
      button.title = "What reflecting on this conversation found. Open Reflections.";
    },
    open({ session } = {}) {
      ext.open.place("reflections", { session: session ?? ext.conversation.current });
    },
  });

  ext.place("reflections", {
    open: (root, params) =>
      openPlace(ext, root, params ?? {}, {
        // A change made in the place shows on the chip at once.
        changed: (session) => (session && session === ext.conversation.current ? refresh(session) : undefined),
      }),
  });
}
