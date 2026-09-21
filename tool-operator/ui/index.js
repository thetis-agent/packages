/* The browser side of @thetis/tool-operator: one statusbar chip, and the poll that keeps it true.
 *
 * The chip exists only for admins, and nothing here checks a role. The package is installed per admin, so the
 * gateway never lists this extension for anybody else and the page never loads this file for them. That is the
 * same authority the tool has, expressed once, in what is installed.
 *
 * It is hidden whenever nothing is pending, which is nearly always: a status bar that says "no restart is
 * armed" is noise, and the thing worth a permanent line — whether the running code is stale — is the control
 * panel's Workspaces section, not this. When a restart is armed the chip counts it down, carries the reason in
 * its title, and offers Cancel behind a confirm, because the ten-second window is only a real offer if there
 * is a button in it.
 *
 * The hard part is what happens next. The restart is a process exit: this page's own gateway goes with it, the
 * poll stops answering, and the page must either recover or say why. So a poll that fails while a restart was
 * pending is read as the restart happening, not as a fault, and the chip keeps trying for ninety seconds —
 * an exit, systemd's RestartSec, a fresh kernel, every fence reopening and every service booting, which is a
 * great deal longer than the thirty seconds a fence reload needs. At the deadline it stops and says what to
 * check. A spinner that never resolves is the failure this project keeps deleting, so the deadline is real and
 * the sentence after it names the command that finds the answer.
 *
 * The poll runs only for a page somebody can see. A tab in the background asks nothing, and asks once the
 * moment it is in front again; the same for the page's first poll, which waits for the page to be seen. With
 * nothing armed the idle rate is slow, because nearly every answer is "nothing", and the way a restart gets
 * armed is a tool call in one of this person's own turns: the end of any of their turns asks at once, so an
 * arming is seen when it happens, not fifteen seconds later. Only a restart armed by another admin waits
 * for the timer. Once something is pending the poll is fast, because the countdown on screen is redrawn
 * from the poll and must not be visibly wrong, and that state lasts two minutes at the most.
 *
 * Nothing runs at import; `install(ext)` starts the poll. No inline styles anywhere: the page's Content
 * Security Policy allows none, and everything this draws is a class in index.css. */

const IDLE_MS = 15_000;     // nothing pending: the answer is nearly always "nothing", and a turn's end asks sooner
const PENDING_MS = 700;     // something pending: the countdown on screen must not be visibly wrong
const SETTLE_MS = 90_000;   // how long the page waits for the daemon to come back before it says it has not

const LOST = "Thetis has not come back. It may have failed to start — check journalctl -u thetis-runtime.";

export default function install(ext) {
  // "idle" nothing armed and the chip hidden · "pending" armed, counting · "gone" the daemon stopped answering
  // while a restart was pending · "lost" it never came back inside the deadline, and the page stopped waiting.
  let phase = "idle";
  let pending = null;
  let goneAt = 0;
  let timer = null;
  let closed = false;
  let busy = false;

  /** Whether anybody can see the page. A test runs without a document; that counts as seen. */
  const seen = () => typeof document === "undefined" || document.visibilityState !== "hidden";

  function schedule() {
    clearTimeout(timer);
    // "lost" stops: the page said what to check, and a poll that has failed for ninety seconds will not start
    // telling the truth on its own. The chip is a button then, so a person can ask again once they have looked.
    // A hidden page stops too; `visibilitychange` starts it again.
    if (closed || phase === "lost" || !seen()) return;
    timer = setTimeout(() => void poll(), phase === "idle" ? IDLE_MS : PENDING_MS);
  }

  async function poll() {
    busy = true;
    try {
      const out = await ext.request("restart-status");
      if (phase === "gone" || phase === "lost") ext.toast("Thetis is back.", { tone: "good" });
      const row = out?.data?.pending;
      pending = row && typeof row === "object" ? row : null;
      phase = pending ? "pending" : "idle";
    } catch {
      // A request that never answers while a restart was armed is the restart happening, not a fault. With
      // nothing armed it says nothing about a restart, so the chip stays out of the way and the poll retries.
      if (phase === "pending") {
        goneAt = Date.now();
        phase = "gone";
      } else if (phase === "gone" && Date.now() - goneAt >= SETTLE_MS) {
        phase = "lost";
        ext.toast(LOST, { tone: "error" });
      } else if (phase === "idle") {
        pending = null;
      }
    }
    busy = false;
    ext.redraw("restart");
    schedule();
  }

  /** A poll now unless one is running, which answers soon enough and schedules the next itself. */
  function pollSoon() {
    if (closed || !seen() || busy) return;
    clearTimeout(timer);
    void poll();
  }

  async function cancel(anchor) {
    const ok = await ext.ui.confirm(anchor, {
      title: "Call off this restart?",
      lines: [
        ["reason", pending?.reason ?? "—"],
        ["asked by", pending?.by ?? "—"],
        ["fires", fires(pending)],
      ],
      note: "Thetis keeps running on the code it started with. Whatever the restart was for is still not live, so put new code into service another way or arm it again later.",
      confirmLabel: "Call it off",
      tone: "warn",
    });
    if (!ok) return;
    try {
      const out = await ext.request("restart-cancel");
      ext.toast(out?.text || "The restart was called off.", { tone: "good" });
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    }
    await poll();
  }

  ext.statusbar("restart", {
    draw(node) {
      const { el, setHidden } = ext.dom;
      if (phase === "idle") return setHidden(node, true);
      setHidden(node, false);
      if (phase === "lost") {
        // Not a dead chip: the sentence says what to check, and the button asks again once someone has looked.
        node.append(el("button", { type: "button", class: "op-chip is-err", title: `${LOST} Click to ask again.`, onClick: () => { phase = "gone"; goneAt = Date.now(); void poll(); } }, "Thetis has not come back"));
        return;
      }
      if (phase === "gone") {
        const waited = Math.round((Date.now() - goneAt) / 1000);
        node.append(el("span", { class: "op-chip is-warn", title: `Thetis is restarting${pending?.reason ? `: ${pending.reason}` : ""}. This page is waiting for it to answer again, for up to ${SETTLE_MS / 1000} seconds.` }, `Restarting · waiting for Thetis · ${waited}s`));
        return;
      }
      const left = secondsTo(pending?.firesAt);
      node.append(el("span", { class: "op-chip is-warn", title: `${pending?.reason ?? "a restart"} — asked by ${pending?.by ?? "someone"}. ${fires(pending)} Conversations come back; open shell sessions do not.` }, left === null ? "Restart pending · waiting for turns to end" : `Restart pending · ${left}s`));
      const button = ext.ui.button("Cancel", { tone: "warn", onClick: () => void cancel(button), title: "Call off this restart" });
      button.classList.add("op-cancel");
      node.append(button);
    },
  });

  if (seen()) void poll();
  // A restart is armed from inside a turn and the turn ends before anything happens, so the end of any turn of
  // this person is the moment an arming becomes visible; asking then is what lets the idle rate be slow. The
  // seam always has `events`; the chip's test seam does not, and the chip is not what that test is about.
  ext.events?.watch?.((message) => {
    if (message?.event?.type === "turn.end") pollSoon();
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (seen()) pollSoon();
      else clearTimeout(timer);
    });
  }
  // The poll lives as long as the page. This only spares a gateway a request nobody will read.
  addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(timer);
  });
}

/** When it goes, in the two branches the latch really has. Both are stated: one of them cuts somebody's turn. */
function fires(pending) {
  const left = secondsTo(pending?.firesAt);
  if (left !== null) return `It is counting down and fires in about ${left} seconds.`;
  const deadline = secondsTo(pending?.deadlineAt);
  return deadline === null
    ? "It fires as soon as every turn everywhere has finished, and on its deadline whatever happens."
    : `It fires as soon as every turn everywhere has finished, and in at most ${deadline} seconds whatever happens — a turn still running then is cut off.`;
}

/**
 * Seconds until a moment the kernel sent, or null when it sent none. The latch's clocks are epoch
 * milliseconds; a string is parsed too, so a kernel that writes them as moments reads the same here.
 */
function secondsTo(at) {
  const ms = typeof at === "number" ? at : Date.parse(at ?? "");
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}
