/* The composer: text, the images going with it, and the stop button that appears while a turn is
 * running.
 *
 * The legacy composer also carried a mode picker, a model picker, a starting-revision picker and
 * @-mentions. None of those have a wire to speak to: mode and model are profile fields on `Runtime`,
 * changed through the generation machine (ADR 0012 §1) rather than by a per-conversation frame the way
 * legacy sent `set-model`, and starting revisions and `@`-mentions describe a git sandbox and a
 * workspace, neither of which this runtime has. `views/picker.js` is back in the tree ahead of the
 * first two, but nothing imports it yet; see its own header.
 *
 * The attachment tray is here again, and works differently from legacy's. Legacy read the file with a
 * FileReader and sent the base64 inside the `send` frame; that frame is capped at 1 MiB and the input it
 * becomes is capped at 64 KiB, so anything but a thumbnail never arrived. An image now goes up its own
 * way — a POST to the same origin, before the message is sent — and the frame carries only what the host
 * answered with. The FileReader is still here, but only for the small picture in the tray: the page can
 * draw the file it already holds without waiting on a round trip, because the policy this surface is
 * served under allows a `data:` image.
 *
 * An image is uploaded as it is added, not as the message is sent. Adding is when the person is looking
 * at the file, so it is when a refusal makes sense; and it means Enter sends immediately rather than
 * pausing on a 3 MB upload with the message already cleared from the box.
 */

import { limits, nameOf, readAnswer, reviewFiles, summarise, uploadPath } from "../lib/attach.js";
import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];

export function mountComposer({ onSend, onStop }) {
  const form = $("composer");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const attachBtn = $("attach");
  const filePicker = $("file-picker");
  const tray = $("attachments");
  const trayNote = $("attachments-note");
  const veil = $("drop-veil");

  /* The images going with the message being typed. Each entry is
   * `{name, size, mime, preview, descriptor}`: `preview` is the `data:` URL the tray draws, and
   * `descriptor` is what the host answered with — null until the upload finishes, which is how the tray
   * knows to show the chip as still arriving and the send button knows to stay disabled. Held here
   * rather than in the store because nothing outside this file reads them: they leave through `onSend`. */
  let held = [];

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

  /** True while any image in the tray is still going up. Enter must wait for it: the frame names files
   *  by what the host answered, and there is nothing to name until it has. */
  function arriving() {
    return held.some((entry) => !entry.descriptor);
  }

  function updateSendState() {
    const hasContent = input.value.trim() !== "" || held.length > 0;
    sendBtn.disabled = !hasContent || !store.current || locked() || arriving();
  }

  function drawLock() {
    const busy = locked();
    input.disabled = busy;
    attachBtn.disabled = busy || !store.current;
    input.placeholder = busy
      ? store.creating
        ? "Creating the conversation…"
        : "Sending…"
      : `Message ${store.agent.name}…`;
    form.classList.toggle("is-locked", busy);
    updateSendState();
    // Focus comes back by itself when the lock lifts, so typing can continue
    // where it left off rather than after a click.
    if (!busy && document.activeElement === document.body) input.focus();
  }

  store.watch("pendingIds", drawLock);
  store.watch("creating", drawLock);
  // The prompt names the agent, and the name is configuration rather than a
  // constant, so it is redrawn when the connection confirms it.
  store.watch("agent", drawLock);

  // A tab switch shows a different conversation's lock state, and starts
  // from an empty box: a draft in progress belongs to the tab it was typed
  // into, not to whichever one is now on screen, and there is nowhere yet
  // that remembers it per tab. The images go with the draft, for the same
  // reason and because each was uploaded into the conversation it was added
  // to and cannot follow the person to another.
  store.watch("current", () => {
    input.value = "";
    held = [];
    drawTray();
    autosize();
    drawStop();
    drawLock();
  });

  // --- the tray -------------------------------------------------------------

  function drawTray() {
    clear(tray);
    setHidden(tray, held.length === 0);
    for (const entry of held) {
      tray.append(
        el(
          "div",
          { class: `chip${entry.descriptor ? "" : " is-arriving"}`, title: entry.name },
          entry.preview ? el("img", { class: "chip-thumb", src: entry.preview, alt: "" }) : null,
          el("span", { class: "chip-name" }, entry.name),
          el(
            "button",
            {
              type: "button",
              class: "chip-x",
              title: "Remove",
              "aria-label": `Remove ${entry.name}`,
              onClick: () => { held = held.filter((other) => other !== entry); drawTray(); },
            },
            icon(X, { size: 11, width: 1.9 })
          )
        )
      );
    }
    trayNote.textContent = summarise(held);
    setHidden(trayNote, held.length === 0);
    updateSendState();
  }

  /** Sorts what was dropped, pasted or picked, says once what could not go, and starts the rest. */
  function addFiles(files) {
    const id = store.current;
    const list = [...(files ?? [])];
    if (!list.length) return;
    if (!id) {
      toast("Open a conversation first, then add a file.", { tone: "error" });
      return;
    }
    const { accept, refusals } = reviewFiles(list, held.length, limits);
    for (const message of refusals) toast(message, { tone: "error" });
    for (const file of accept) void add(id, file);
  }

  /* The chip appears before either the picture or the upload is ready, so the person sees the file land
   * where they dropped it. Both are awaited afterwards, and both check that the entry is still in the
   * tray before touching it: removing a chip mid-upload is the obvious thing to do to a file you have
   * just realised you did not mean to add, and it must not come back when its answer arrives. */
  async function add(conversation, file) {
    const entry = { name: nameOf(file) || "Pasted image", size: file.size, mime: file.type, preview: "", descriptor: null };
    held.push(entry);
    drawTray();

    entry.preview = await preview(file);
    if (held.includes(entry)) drawTray();

    const answer = await upload(conversation, file);
    if (!held.includes(entry)) return;
    if (!answer.ok) {
      held = held.filter((other) => other !== entry);
      drawTray();
      toast(answer.message, { tone: "error" });
      return;
    }
    entry.descriptor = answer.value;
    entry.name = answer.value.name;
    drawTray();
  }

  /** Sends one image to the host and reads the answer. A refusal is shown in the host's own words. */
  async function upload(conversation, file) {
    try {
      const response = await fetch(uploadPath(conversation, nameOf(file)), {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
        credentials: "same-origin",
      });
      return readAnswer(await response.json());
    } catch {
      return { ok: false, message: "Not connected — that image was not added." };
    }
  }

  /** The small picture in the chip, read straight out of the file the browser already holds. */
  function preview(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  }

  attachBtn.addEventListener("click", () => filePicker.click());
  filePicker.addEventListener("change", () => {
    addFiles(filePicker.files);
    // Cleared so picking the same file twice in a row still fires a change.
    filePicker.value = "";
  });

  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  // --- drag and drop --------------------------------------------------------

  /* The veil is held open by a timer that every `dragover` refreshes, rather than by counting
   * dragenter/dragleave pairs. Those fire once per child element and go missing entirely when a drag
   * ends outside the window, which strands the overlay on screen. A lapsing timer cannot get stuck: the
   * moment events stop arriving, the veil clears itself. */
  const VEIL_LINGER_MS = 160;
  let veilTimer = null;

  const draggingFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

  function holdVeil() {
    setHidden(veil, false);
    clearTimeout(veilTimer);
    veilTimer = setTimeout(dropVeil, VEIL_LINGER_MS);
  }

  function dropVeil() {
    clearTimeout(veilTimer);
    veilTimer = null;
    setHidden(veil, true);
  }

  // Bound to the window so a drop anywhere adds the file, and so a file dropped
  // outside the composer never navigates the page away.
  window.addEventListener("dragover", (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    holdVeil();
  });

  window.addEventListener("drop", (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    dropVeil();
    addFiles(event.dataTransfer?.files);
  });

  // Belt and braces for the cases the timer would only catch a beat later.
  window.addEventListener("dragend", dropVeil);
  window.addEventListener("blur", dropVeil);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) dropVeil();
  });

  // --- sending --------------------------------------------------------------

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
    // An image on its own is a message: the picture is the content, and the host takes an empty text
    // beside a non-empty list of files.
    if (locked() || arriving() || !store.current) return;
    if (!text && !held.length) return;

    // `onSend` reports whether the frame actually reached the socket. A send
    // into a closed socket used to swallow the message silently, clearing the
    // box as if it had gone.
    if (onSend(text, held) === false) {
      toast("Not connected — the message was not sent. It is still in the box.", {
        tone: "error",
      });
      return;
    }

    input.value = "";
    held = [];
    drawTray();
    autosize();
  });

  /** Puts an unacknowledged message back in the box, so nothing is lost. */
  function restore(text) {
    if (text && !input.value.trim()) input.value = text;
    autosize();
    drawLock();
    input.focus();
  }

  drawTray();
  drawLock();
  return { focus: () => input.focus(), restore };
}
