/* The composer: the text box, the send button, and the stop button that appears while a turn runs. */

import { $, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";

export function mountComposer({ onSend, onStop }) {
  const form = $("composer");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const note = $("composer-note");

  stopBtn.addEventListener("click", () => onStop());

  function locked() {
    const id = store.get("current");
    return store.get("creating") || (id && store.isPending(id));
  }

  function draw() {
    const id = store.get("current");
    const running = id && store.isRunning(id);
    const busy = locked();
    setHidden(stopBtn, !running);
    input.disabled = Boolean(busy);
    input.placeholder = store.get("creating") ? "Creating the conversation…" : busy ? "Sending…" : running ? "Thetis is working — send to queue after it finishes" : "Message Thetis…";
    form.classList.toggle("is-locked", Boolean(busy));
    sendBtn.disabled = !input.value.trim() || busy || running;
    note.textContent = running ? "A turn is running." : "";
    if (!busy && document.activeElement === document.body) input.focus();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  input.addEventListener("input", () => {
    autosize();
    draw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || locked()) return;
    const id = store.get("current");
    if (id && store.isRunning(id)) return;
    if (onSend(text) === false) return;
    input.value = "";
    autosize();
    draw();
  });

  for (const key of ["current", "running", "pending", "creating"]) store.watch(key, draw);
  store.watch("current", () => {
    input.value = "";
    autosize();
  });
  draw();
  return { focus: () => input.focus(), restore: (text) => { if (!input.value.trim()) input.value = text; autosize(); draw(); } };
}
