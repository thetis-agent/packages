/* The composer: the text box, the model pill, the send button, and the stop button that appears while a
 * turn runs. The pill lists what the person's providers serve; the choice is kept per conversation. */

import { shortModel } from "../lib/activity.js";
import { api } from "../lib/api.js";
import { $, setHidden } from "../lib/dom.js";
import { Picker } from "../lib/picker.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";

export function mountComposer({ onSend, onStop, onModel }) {
  const form = $("composer");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const note = $("composer-note");
  const tools = $("composer-tools");

  stopBtn.addEventListener("click", () => onStop());

  // ---- the model pill ----

  const options = () => {
    const choices = store.get("choices");
    if (!choices) return [];
    const list = [{ id: "", label: `Default · ${shortModel(choices.model) || "as configured"}`, note: choices.model ? `${choices.model} · set by the configuration` : "Whatever the configuration names." }];
    for (const m of choices.models) {
      if (m.id === "*") continue;
      list.push({ id: m.id, label: m.name && m.name !== m.id ? m.name : shortModel(m.id), note: m.provider ? `${m.id} · ${shortPackage(m.provider)}` : m.id });
    }
    // The chosen model sits right under the default, so the choice is visible without scrolling a long list.
    const chosen = store.session(store.get("current"))?.model;
    if (chosen) {
      const at = list.findIndex((o) => o.id === chosen);
      const entry = at >= 0 ? list.splice(at, 1)[0] : { id: chosen, label: shortModel(chosen), note: `${chosen} · not listed by any provider` };
      list.splice(1, 0, entry);
    }
    return list;
  };
  const picker = new Picker({
    options,
    searchable: true,
    mono: true,
    title: "Which model answers in this conversation",
    selected: () => store.session(store.get("current"))?.model || "",
    label: () => {
      const id = store.get("current");
      const chosen = store.session(id)?.model;
      if (chosen) return shortModel(chosen);
      const fallback = store.get("choices")?.model;
      return fallback ? `${shortModel(fallback)} · default` : "Model";
    },
    onSelect: (model) => onModel(store.get("current"), model),
  });
  tools.append(picker.node);

  let loading = null;
  function loadChoices() {
    if (store.get("choices") || loading) return;
    loading = api("/api/models")
      .then((choices) => store.set({ choices }))
      .catch((err) => {
        // A gateway that predates the route answers 404: no picker, no complaint.
        if (err.status !== 401 && err.status !== 404) toast(`The models could not be listed: ${err.message}`, { tone: "error" });
      })
      .finally(() => {
        loading = null;
      });
  }

  // ---- the box ----

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
    input.placeholder = store.get("creating") ? "Creating the conversation…" : busy ? "Sending…" : running ? "Thetis is working — the box opens when the turn ends" : "Message Thetis…";
    form.classList.toggle("is-locked", Boolean(busy));
    form.classList.toggle("is-running", Boolean(running));
    sendBtn.disabled = !input.value.trim() || busy || running;
    note.textContent = running ? "A turn is running." : "";
    setHidden(picker.node, Boolean(running) || !id);
    picker.draw();
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

  for (const key of ["current", "running", "pending", "creating", "sessions", "choices"]) store.watch(key, draw);
  store.watch("current", () => {
    input.value = "";
    autosize();
    picker.close();
    loadChoices();
  });
  draw();
  return {
    focus: () => input.focus(),
    restore: (text) => {
      if (!input.value.trim()) input.value = text;
      autosize();
      draw();
    },
    loadChoices,
  };
}

function shortPackage(name) {
  return String(name).replace(/^@thetis\/provider-/, "").replace(/^@[^/]+\//, "");
}
