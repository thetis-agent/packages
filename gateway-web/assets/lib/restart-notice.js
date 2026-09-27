/* "Thetis restarts in 20 s": the notice every person sees while a restart of Thetis is armed, and what it
 * says while Thetis is away and when it is back. It reads the kernel's restart latch through the gateway
 * (`GET /api/restart`), which answers in milliseconds from now so a wrong clock on this machine does not
 * make the count wrong. An older kernel refuses the question to a person who is not an admin; the gateway
 * answers that as `readable: false`, and this module then says nothing and stops asking.
 *
 * It asks when the page loads, when one of the person's turns ends (a restart is most often armed from
 * inside a turn), when the page comes back into view, every minute otherwise, and every ten seconds while
 * a restart is armed; between answers the countdown ticks on the page's own clock. A hidden page asks
 * nothing. Once the connection drops while a restart is armed, the card waits for Thetis to come back
 * through `awaitReturn`, the same wait every other surface uses, and says so when it has. */

import { api } from "./api.js";
import { awaitReturn, turnsRunning } from "./lifecycle.js";
import { notice } from "./notice.js";
import { store } from "./store.js";

export const RESTART_NOTICE = "thetis-restart";
const ARMED_MS = 10_000;
const IDLE_MS = 60_000;
/** How long after the latch's own deadline the page keeps waiting before it says Thetis has not come back. */
const SETTLE_MS = 90_000;
const BACK_SHOWN_MS = 6000;

export function watchRestart() {
  let pending = null;   // { reason, by, firesAt?, deadlineAt? } on this page's clock, or null
  let timer = null;
  let tick = null;
  let unreadable = false;
  let away = false;     // the connection dropped while a restart was armed: Thetis is restarting
  let generation = 0;   // a wait that belongs to a restart since called off is ignored when it ends
  let busy = false;

  const seen = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const secondsTo = (at) => Math.max(0, Math.ceil((at - Date.now()) / 1000));
  const tail = () => (turnsRunning() ? " · your reply will continue" : "");

  function schedule() {
    clearTimeout(timer);
    if (unreadable || away || !seen()) return;
    timer = setTimeout(() => void poll(), pending ? ARMED_MS : IDLE_MS);
  }

  async function poll() {
    if (busy || away || unreadable) return;
    busy = true;
    try {
      const out = await api("/api/restart");
      if (out && out.readable === false) {
        unreadable = true;
        return;
      }
      const p = out?.pending;
      const now = Date.now();
      pending = p
        ? {
            reason: String(p.reason ?? ""),
            by: String(p.by ?? ""),
            ...(typeof p.firesInMs === "number" ? { firesAt: now + p.firesInMs } : {}),
            ...(typeof p.deadlineInMs === "number" ? { deadlineAt: now + p.deadlineInMs } : {}),
          }
        : null;
      if (pending) armed();
      else calledOff();
    } catch {
      // Not answering says nothing on its own; the connection's state is what says Thetis went away.
    } finally {
      busy = false;
      schedule();
    }
  }

  function title() {
    if (pending?.firesAt !== undefined) return `Thetis restarts in ${secondsTo(pending.firesAt)} s${tail()}`;
    return `Thetis restarts soon${tail()}`;
  }

  function body() {
    const why = pending?.reason ? `Reason: ${pending.reason}.` : "";
    const when = pending?.firesAt === undefined && pending?.deadlineAt !== undefined ? ` It waits for running replies to reach a safe point, at most ${secondsTo(pending.deadlineAt)} s.` : "";
    return `${why}${when} Your conversations are kept.`.trim();
  }

  function draw() {
    if (!pending || away) return;
    notice(RESTART_NOTICE, { title: title(), body: body(), tone: "warn", dismissible: false });
  }

  function armed() {
    const first = !tick;
    draw();
    if (first) {
      tick = setInterval(draw, 1000);
      void waitForIt();
    }
  }

  function calledOff() {
    clearInterval(tick);
    tick = null;
    generation += 1;
    if (!away) notice.close(RESTART_NOTICE);
  }

  /** Waits through the restart: the drop, the wait, and back or not back. */
  async function waitForIt() {
    const mine = ++generation;
    const until = pending?.firesAt ?? pending?.deadlineAt ?? Date.now() + 120_000;
    const how = await awaitReturn({
      timeoutMs: Math.max(0, until - Date.now()) + SETTLE_MS,
      onState: (state) => {
        if (state !== "gone" || mine !== generation) return;
        away = true;
        clearInterval(tick);
        tick = null;
        clearTimeout(timer);
        notice(RESTART_NOTICE, { title: `Thetis is restarting${tail()}`, body: "This page waits for it and carries on by itself.", tone: "warn", dismissible: false });
      },
    });
    if (mine !== generation) return;
    const wasAway = away;
    away = false;
    pending = null;
    clearInterval(tick);
    tick = null;
    if (how === "back") {
      if (wasAway) {
        const card = notice(RESTART_NOTICE, { title: "Thetis is back.", tone: "ok" });
        setTimeout(() => { if (!pending && !away) card.close(); }, BACK_SHOWN_MS); // unless a new restart took the card
      } else notice.close(RESTART_NOTICE);
    } else if (wasAway || store.get("connection") !== "online") {
      // Not a dead end: the page keeps reconnecting on its own, and this card changes the moment it does.
      notice(RESTART_NOTICE, {
        title: "Thetis has not come back yet.",
        body: "It may have failed to start. This page keeps trying, and this card changes when Thetis is back. An admin can check the server's log.",
        tone: "error",
        dismissible: true,
      });
      const stop = store.watch("connection", (state) => {
        if (state !== "online") return;
        stop();
        if (!notice.has(RESTART_NOTICE)) return;
        const card = notice(RESTART_NOTICE, { title: "Thetis is back.", tone: "ok" });
        setTimeout(() => { if (!pending && !away) card.close(); }, BACK_SHOWN_MS); // unless a new restart took the card
      });
    } else notice.close(RESTART_NOTICE);
    schedule();
  }

  /** A poll now, unless one is running or the page is not seen. */
  function pollSoon() {
    if (!seen()) return;
    clearTimeout(timer);
    void poll();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (seen()) pollSoon();
      else clearTimeout(timer);
    });
  }
  pollSoon();
  return { pollSoon };
}
