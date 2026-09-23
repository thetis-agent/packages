/* The composer: the text box, the attachments tray, the model pill, the send button, and the stop button
 * that appears while a turn runs. The pill lists what the person's providers serve; the choice is kept per
 * conversation. One composer for the page: it follows the active tab through `store.current`. The tools
 * row holds one root per declared `composer` slot entry (the model picker is the built-in one, mounted
 * through `mountModelPicker`), so a package's picker sits beside the model's.
 *
 * Attachments come in three ways — a paste into the box, a drop anywhere on the conversation, or the
 * paper-clip's file dialog — and all three land in one `Attachments` list, uploaded as they arrive. What
 * `onSend` receives is the `TurnInput` to send: a plain string when there is nothing attached, a message
 * with content parts otherwise. */

import { shortModel } from "../lib/activity.js";
import { api } from "../lib/api.js";
import { Attachments, buildInput, describeSize, IMAGE_TYPES, pickFiles } from "../lib/attachments.js";
import { $, el, icon, setHidden } from "../lib/dom.js";
import { Picker } from "../lib/picker.js";
import * as registry from "../lib/registry.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";

export function mountComposer({ onSend, onStop, onModel }) {
  const form = $("composer");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const note = $("composer-note");
  const tools = $("composer-tools");
  const tray = $("attachments");
  const attachBtn = $("attach");
  const fileInput = $("attach-file");

  stopBtn.addEventListener("click", () => onStop());

  // ---- the attachments ----

  const attachments = new Attachments({ onChange: () => { drawTray(); draw(); } });
  const previews = new Map(); // key -> object URL, revoked when the item leaves the tray

  function takeFiles(files) {
    if (!files.length) return;
    const id = store.get("current");
    if (id && store.isAgent(id)) { toast("A subagent has no composer.", { tone: "error" }); return; }
    for (const { reason } of attachments.add(files)) toast(reason, { tone: "error" });
    input.focus();
  }

  function drawTray() {
    const alive = new Set(attachments.items.map((it) => it.key));
    for (const [key, url] of previews) if (!alive.has(key)) { URL.revokeObjectURL(url); previews.delete(key); }
    tray.replaceChildren();
    for (const item of attachments.items) {
      const isImage = IMAGE_TYPES.includes(item.mediaType);
      let thumb;
      if (isImage) {
        if (!previews.has(item.key)) previews.set(item.key, URL.createObjectURL(item.file));
        thumb = el("img", { class: "attachment-thumb", src: previews.get(item.key), alt: "" });
      } else {
        thumb = el("span", { class: "attachment-thumb is-file" }, icon("M6 3.5h5.5L15 7v9.5H6zM11.5 3.5V7H15", { size: 18 }));
      }
      const state = item.status === "uploading" ? "Uploading…" : item.status === "failed" ? item.error || "Not uploaded" : describeSize(item.size);
      const chip = el("div", { class: `attachment is-${item.status}`, "data-key": item.key, title: `${item.name} · ${state}` },
        thumb,
        el("span", { class: "attachment-meta" }, el("span", { class: "attachment-name" }, item.name), el("span", { class: "attachment-state" }, state)),
        item.status === "failed" ? el("button", { type: "button", class: "attachment-retry", title: "Try the upload again", onClick: () => attachments.retry(item.key) }, "Retry") : null,
        el("button", { type: "button", class: "attachment-remove", title: "Remove this attachment", "aria-label": `Remove ${item.name}`, onClick: () => attachments.remove(item.key) }, icon("M6 6l8 8M14 6l-8 8", { size: 12, width: 2 })),
      );
      tray.append(chip);
    }
    setHidden(tray, !attachments.length);
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    takeFiles(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });

  // A paste with a file in it (a screenshot from the clipboard) becomes an attachment; a paste of text
  // is the browser's own business and goes on into the box untouched.
  input.addEventListener("paste", (event) => {
    const { taken, refused } = pickFiles(event.clipboardData);
    if (!taken.length && !refused.length) return;
    event.preventDefault();
    for (const file of refused) toast(`${file.name || "That file"} is ${file.type || "of an unknown kind"}, which the model cannot read.`, { tone: "error" });
    takeFiles(taken);
  });

  // A drop lands anywhere on the conversation column, not only on the box: the box is one line tall and
  // the natural target is the transcript above it. The highlight follows `dragenter`/`dragleave` on the
  // whole document, counted so a leave from a child does not clear it.
  const zone = form.closest(".main") ?? form;
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  zone.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    zone.classList.add("is-dropping");
  });
  zone.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) zone.classList.remove("is-dropping");
  });
  zone.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove("is-dropping");
    const { taken, refused } = pickFiles(event.dataTransfer);
    for (const file of refused) toast(`${file.name || "That file"} is ${file.type || "of an unknown kind"}, which the model cannot read.`, { tone: "error" });
    takeFiles(taken);
  });

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

  // ---- the composer slots: one root per declared entry, mounted once the package registers ----

  const mounted = new Set();
  function drawSlots() {
    for (const entry of registry.entries("composer")) {
      let root = tools.querySelector(`[data-slot="${CSS.escape(entry.key)}"]`);
      if (!root) {
        root = el("div", { class: "composer-slot", "data-slot": entry.key });
        tools.append(root);
      }
      if (mounted.has(entry.key) || !entry.impl?.mount) continue;
      mounted.add(entry.key);
      const out = registry.guard(entry.package, "composer", entry.impl.mount, root);
      if (!out.ok) root.append(registry.broken(entry.package));
    }
  }
  registry.watch((change) => {
    if (change.kind === "declare" || (change.kind === "register" && change.slot === "composer")) drawSlots();
  });
  drawSlots();

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
    if (id && store.isAgent(id)) {
      // A subagent's tab: nothing can be said to it. Stop stays, and cancels the child.
      input.disabled = true;
      input.placeholder = "A subagent has no composer. Talk to its conversation.";
      form.classList.add("is-agent");
      form.classList.toggle("is-running", Boolean(running));
      form.classList.remove("is-locked");
      setHidden(sendBtn, true);
      setHidden(attachBtn, true);
      note.textContent = running ? "The subagent is working." : "";
      setHidden(picker.node, true);
      return;
    }
    form.classList.remove("is-agent");
    setHidden(sendBtn, false);
    setHidden(attachBtn, false);
    input.disabled = Boolean(busy);
    input.placeholder = store.get("creating") ? "Creating the conversation…" : busy ? "Sending…" : running ? "Thetis is working — the box opens when the turn ends" : attachments.length ? "Say something about the attachment, or just send it…" : "Message Thetis…";
    form.classList.toggle("is-locked", Boolean(busy));
    form.classList.toggle("is-running", Boolean(running));
    attachBtn.disabled = Boolean(busy) || Boolean(running);
    // A message may be text, attachments, or both; it cannot go while an upload is still on its way.
    const uploading = attachments.busy;
    sendBtn.disabled = (!input.value.trim() && !attachments.ready.length) || busy || running || uploading;
    note.textContent = running ? "A turn is running." : uploading ? "Uploading…" : "";
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
    if (locked()) return;
    if (attachments.busy) { toast("An attachment is still uploading.", { tone: "error" }); return; }
    const parts = attachments.parts();
    if (!text && !parts.length) return;
    const id = store.get("current");
    if (id && (store.isRunning(id) || store.isAgent(id))) return;
    // A failed upload is left out rather than sent as a broken reference; the person was told when it failed.
    const failed = attachments.items.filter((it) => it.status === "failed");
    if (failed.length) { toast(`${failed.length === 1 ? "One attachment" : `${failed.length} attachments`} did not upload. Retry or remove ${failed.length === 1 ? "it" : "them"} first.`, { tone: "error" }); return; }
    const taken = attachments.items;
    if (onSend(buildInput(text, parts), { text, attachments: taken }) === false) return;
    input.value = "";
    attachments.clear();
    autosize();
    draw();
  });

  for (const key of ["current", "running", "pending", "creating", "sessions", "choices", "agents"]) store.watch(key, draw);
  store.watch("current", () => {
    input.value = "";
    attachments.clear();
    autosize();
    picker.close();
    loadChoices();
  });
  draw();
  return {
    focus: () => input.focus(),
    /** Puts a refused message back: its text when the box is empty, and its attachments when the tray is. */
    restore: (text, draft) => {
      if (!input.value.trim()) input.value = text;
      if (!attachments.length && draft?.attachments?.length) attachments.restore(draft.attachments);
      autosize();
      draw();
    },
    /** Attaches files from anywhere on the page (a package's own drop target, say). */
    attach: (files) => takeFiles(Array.from(files ?? [])),
    loadChoices,
    /** The built-in `composer` entry: the model picker goes into the root the slot gives it. */
    mountModelPicker: (root) => { root.append(picker.node); },
    /** Opens the pill's list, for the model chip in the chat bar. */
    openModelPicker: () => { loadChoices(); picker.show(); },
  };
}

function shortPackage(name) {
  return String(name).replace(/^@thetis\/provider-/, "").replace(/^@[^/]+\//, "");
}
