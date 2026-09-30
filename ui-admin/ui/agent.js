/* Agent: what the agent is called and its picture, for everyone on this server. The name is the one the page
 * title, the sidebar's top left, the message box, the sign-in page, every reply's tile and the agent's own
 * instructions use; the picture is drawn beside each reply, in the tab's icon and on the sign-in page. Both
 * are `@thetis/harness-core`'s `agentName` and `agentAvatar` at the system layer (`agent-set`), so the next
 * turn already has the name and each page has both on its next load; nothing restarts. This admin's own page
 * is told at once (`ext.agent.refresh()`), so the change shows here without a reload.
 *
 * A picture is shrunk here before it is sent: a square crop at most 256 pixels a side, WebP where the browser
 * writes it, which keeps it far under the 96 KB the key holds. An animated GIF is sent as it is, or refused
 * when it is too large, because a canvas would keep only its first frame. */

import { failedCard, toastError } from "./failed.js";

const SIDES = [256, 192, 128];

function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (words[0][0] + last).toUpperCase();
}

const readAsDataUrl = (blob) =>
  new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.onerror = () => fail(reader.error ?? new Error("the file could not be read"));
    reader.readAsDataURL(blob);
  });

/** The picture as the data: URL the key holds, or a sentence saying why it cannot be. */
async function pictureOf(file, max) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return { error: "That file is not a PNG, JPEG, WebP or GIF image." };
  if (file.type === "image/gif") {
    const url = await readAsDataUrl(file);
    return url.length <= max ? { url } : { error: `That GIF is ${Math.round(file.size / 1024)} KB; an animated picture is kept whole, so it must be under ${Math.round((max * 3) / 4 / 1024)} KB.` };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: "This browser could not read that picture." };
  }
  const crop = Math.min(bitmap.width, bitmap.height);
  const sx = Math.floor((bitmap.width - crop) / 2);
  const sy = Math.floor((bitmap.height - crop) / 2);
  try {
    for (const side of SIDES) {
      const size = Math.min(side, crop);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(bitmap, sx, sy, crop, crop, 0, 0, size, size);
      // WebP where the browser writes it; one that cannot answers PNG, which the key takes as well.
      const blob = await new Promise((done) => canvas.toBlob(done, "image/webp", 0.86));
      if (!blob) continue;
      const url = await readAsDataUrl(blob);
      if (url.length <= max && /^data:image\/(png|jpeg|webp);base64,/.test(url)) return { url };
    }
  } finally {
    bitmap.close?.();
  }
  return { error: "That picture stays too large even shrunk. Pick a simpler one." };
}

export function mountAgent(ext, root) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, card, confirm, field, heading, put } = ext.ui;
  let saved = null; // what `agent` answered: { name, nameSource, avatar, avatarSource, max }
  let failed = null;
  let draft = { name: "", avatar: null }; // what the form shows; `avatar` null is none
  const wrap = el("div", { class: "panel-col ua-agent" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  const nameInput = el("input", { class: "input", type: "text", maxlength: "40", spellcheck: "false", autocomplete: "off", placeholder: "Thetis", "aria-label": "The agent's name", onInput: () => { draft.name = nameInput.value; preview(); } });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true, onChange: () => void choose() });
  const faces = el("div", { class: "ua-agent-faces" });
  const actions = el("div", { class: "row ua-agent-actions" });

  const shownName = () => draft.name.replace(/\s+/g, " ").trim() || "Thetis";
  const changed = () => saved && (shownName() !== saved.name || draft.avatar !== saved.avatar);

  function face(size) {
    const tile = el("span", { class: `ua-agent-face is-${size}`, role: "img", "aria-label": shownName(), title: shownName() });
    tile.append(draft.avatar ? el("img", { src: draft.avatar, alt: "" }) : el("span", { class: "ua-agent-initial" }, initialsOf(shownName())));
    return tile;
  }

  /** The picture and the name as a reply and the sidebar will show them, redrawn as the form changes. */
  function preview() {
    clear(faces);
    faces.append(
      face("large"),
      el("div", { class: "ua-agent-samples" },
        el("div", { class: "ua-agent-sample" }, face("small"), el("span", { class: "ua-agent-brand" }, shownName())),
        el("div", { class: "ua-agent-sample text-faint" }, `Message ${shownName()}…`))
    );
    clear(actions);
    const save = button("Save", { tone: "primary", disabled: changed() ? null : true, onClick: () => void commit(save) });
    actions.append(
      button(draft.avatar ? "Change picture…" : "Choose a picture…", { onClick: () => fileInput.click() }),
      draft.avatar ? button("Remove picture", { onClick: () => { draft.avatar = null; preview(); } }) : null,
      el("span", { class: "toolbar-gap" }),
      changed() ? button("Undo changes", { onClick: () => { reset(); preview(); } }) : null,
      save
    );
  }

  async function choose() {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const out = await pictureOf(file, saved?.max?.avatar ?? 96 * 1024);
    if (out.error) return void ext.toast(out.error, { tone: "error" });
    draft.avatar = out.url;
    preview();
  }

  function reset() {
    draft = { name: saved?.nameSource === "default" ? "" : saved?.name ?? "", avatar: saved?.avatar ?? null };
    nameInput.value = draft.name;
  }

  async function commit(anchor) {
    const name = shownName();
    const lines = [];
    if (name !== saved.name) lines.push(["name", `${saved.name} → ${name}`]);
    if (draft.avatar !== saved.avatar) lines.push(["picture", draft.avatar ? (saved.avatar ? "a new one" : "added") : "removed"]);
    const ok = await confirm(anchor, { title: "Change the agent for everyone?", lines, note: "Everyone sees it on their next page load, and the agent answers to it from the next message. Conversations keep what was said in them. Nothing restarts.", confirmLabel: "Save" });
    if (!ok) return;
    anchor.disabled = true;
    try {
      const args = {};
      if (name !== saved.name) args.name = draft.name.replace(/\s+/g, " ").trim();
      if (draft.avatar !== saved.avatar) args.avatar = draft.avatar ?? "";
      const out = await ext.request("agent-set", { args });
      saved = out?.data ?? saved;
      reset();
      await ext.agent?.refresh?.();
      ext.toast(`The agent is ${saved.name} now.`, { tone: "good" });
    } catch (err) {
      toastError(ext, err, "The agent could not be changed");
    }
    draw();
  }

  async function load() {
    const stop = busy(wrap, "Reading the agent…");
    try {
      const out = await ext.request("agent");
      saved = out?.data ?? null;
      failed = null;
      reset();
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    draw();
  }

  function draw() {
    clear(wrap);
    if (failed || !saved) return void put(wrap, heading("Agent"), failedCard(ext, "The agent's settings", failed ?? new Error("no answer"), { admin: true, retry: () => void load() }));
    const fromFile = (source) => (source === "file" ? el("span", {}, " ", badge("set in the server's settings file", "dim")) : null);
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Agent", "for everyone on this server")),
      card(
        "Name",
        field(el("span", {}, "What the agent is called", fromFile(saved.nameSource)), nameInput, "The tab's title, the top left of the sidebar, the message box, the sign-in page, the tile beside each reply, and the agent's own instructions. Up to 40 characters; empty is Thetis.")
      ),
      card(
        el("span", {}, "Picture", fromFile(saved.avatarSource)),
        faces,
        el("p", { class: "text-faint" }, "Drawn beside each reply, in the tab's icon, and on the sign-in page. Without one, the tile shows the name's first letters. A picture is cropped square and shrunk before it is saved."),
        fileInput
      ),
      actions
    );
    preview();
  }

  void load();
}
