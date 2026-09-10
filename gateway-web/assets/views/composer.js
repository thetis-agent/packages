/* The composer: text, the stop button that appears while a turn is running,
 * and nothing else.
 *
 * The legacy composer also carried a mode picker, a model picker, a
 * starting-revision picker, @-mentions and a drag-and-drop attachment tray.
 * None of those have a wire to speak to any more: `send` takes only `id` and
 * `text` (wire.ts refuses attachments outright, and there is no mode/model/
 * branch concept in this protocol at all), so all of that machinery — and its
 * dependency on the now-removed picker.js and the dropped mentions.js — went
 * with the pickers.
 */

import { $, AGENT_NAME } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";

export function mountComposer({ onSend, onStop }) {
  const form = $("composer");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");

  // The stop control lives where the eyes already are while a turn runs. It
  // shows on busy and asks no confirmation: stopping a turn is not
  // destructive — the log keeps everything the turn already did. Busy is
  // tracked per conversation (several tabs can each have a turn running), so
  // this reads whichever one is open right now.
  stopBtn.addEventListener("click", () => onStop());
  function drawStop() {
    stopBtn.hidden = !store.isBusy(store.current);
  }
  store.watch("busyIds", drawStop);
  drawStop();

  /* The composer is locked while a submission is in flight, or while a
   * conversation is being created. Both are host round trips that take long
   * enough to type into, and a second Enter during the first one used to send
   * a message the user had no feedback about. */
  function locked() {
    return store.isPending(store.current) || store.creating;
  }

  function updateSendState() {
    sendBtn.disabled = input.value.trim() === "" || !store.current || locked();
  }

  function drawLock() {
    const busy = locked();
    input.disabled = busy;
    input.placeholder = busy
      ? store.creating
        ? "Creating the conversation…"
        : "Sending…"
      : `Message ${AGENT_NAME}…`;
    form.classList.toggle("is-locked", busy);
    updateSendState();
    // Focus comes back by itself when the lock lifts, so typing can continue
    // where it left off rather than after a click.
    if (!busy && document.activeElement === document.body) input.focus();
  }

  store.watch("pendingIds", drawLock);
  store.watch("creating", drawLock);

  // A tab switch shows a different conversation's lock state, and starts
  // from an empty box: a draft in progress belongs to the tab it was typed
  // into, not to whichever one is now on screen, and there is nowhere yet
  // that remembers it per tab.
  store.watch("current", () => {
    input.value = "";
    autosize();
    drawStop();
    drawLock();
  });

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  input.addEventListener("input", () => {
    autosize();
    updateSendState();
  });

  // Enter sends. Sending mid-reply is allowed: the composer only refuses a
  // second send while the previous one is still waiting on `accepted`.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (locked() || !text || !store.current) return;

    // `onSend` reports whether the frame actually reached the socket. A send
    // into a closed socket used to swallow the message silently, clearing the
    // box as if it had gone.
    if (onSend(text) === false) {
      toast("Not connected — the message was not sent. It is still in the box.", {
        tone: "error",
      });
      return;
    }

    input.value = "";
    autosize();
  });

  /** Puts an unacknowledged message back in the box, so nothing is lost. */
  function restore(text) {
    if (text && !input.value.trim()) input.value = text;
    autosize();
    drawLock();
    input.focus();
  }

  drawLock();
  return { focus: () => input.focus(), restore };
}
