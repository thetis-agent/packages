/* The project page, opened from the switcher with `{ id }` for a project's settings or `{}` for a new
 * one. It asks `get` once, keeps a draft (name, directories, switched-off tools, instructions) and
 * redraws the body from the draft after every edit; nothing is sent until Save. Save calls `save`,
 * toasts, and refreshes the switcher; for a new project it also chooses it, so the sidebar shows the
 * conversations that join it. Delete sits behind the shell's confirm popover; after it the page becomes
 * the new-project form, because the shell offers no way to close a place from inside it. `open` returns
 * an unmount that stops a late answer from drawing into a closed page. */

import { directoriesSection, skillsSection, toolsSection } from "./place-parts.js";

export function openPlace(ext, state, root, params) {
  const { el, clear } = ext.dom;
  const { button, field, section, confirm } = ext.ui;
  let alive = true;
  let id = typeof params.id === "string" ? params.id : null;
  let draft = null; // { name, directories, disable: Set, instructions }
  let facts = null; // { mounts, tools, conversations }
  let saving = false;

  root.append(el("div", { class: "pj-place" }, el("p", { class: "panel-empty" }, "Loading…")));

  async function load() {
    try {
      const out = await ext.request("get", { session: ext.conversation.current ?? undefined, args: id ? { id } : {} });
      if (!alive) return;
      const data = out?.data ?? {};
      const project = data.project;
      draft = {
        name: project?.name ?? "",
        directories: [...(project?.directories ?? [])],
        disable: new Set(project?.tools?.disable ?? []),
        instructions: typeof data.instructions === "string" ? data.instructions : "",
      };
      facts = { mounts: Array.isArray(data.mounts) ? data.mounts : [], tools: Array.isArray(data.tools) ? data.tools : [], conversations: data.conversations ?? 0 };
      draw();
    } catch (err) {
      if (!alive) return;
      clear(root);
      root.append(el("div", { class: "pj-place" }, el("p", { class: "pj-error" }, err?.message || "The project could not be read.")));
    }
  }

  function nameField() {
    const input = el("input", { class: "input pj-name", type: "text", value: draft.name, maxlength: "80", placeholder: "A name for the project", "aria-label": "Project name", spellcheck: "false" });
    input.addEventListener("input", () => {
      draft.name = input.value;
    });
    return field("Name", input, "Up to 80 characters. The switcher shows it.");
  }

  function instructionsField() {
    const area = el("textarea", { class: "input pj-instructions", rows: "10", placeholder: "Standing instructions for every conversation in this project. Markdown is fine.", "aria-label": "Instructions", spellcheck: "true" });
    area.value = draft.instructions;
    area.addEventListener("input", () => {
      draft.instructions = area.value;
    });
    return el("section", { class: "pj-section" }, section("Instructions", "Kept as PROJECT.md and added to the system prompt of every conversation in this project."), field("PROJECT.md", area));
  }

  function conversationsSection() {
    const n = facts.conversations;
    const text = id ? `${n} ${n === 1 ? "conversation is" : "conversations are"} in this project.` : "None yet. A conversation started while this project is chosen joins it.";
    return el("section", { class: "pj-section" }, section("Conversations"), el("p", { class: "pj-facts" }, text));
  }

  async function save(anchor) {
    if (saving) return;
    const name = draft.name.trim();
    if (!name) return ext.toast("A project needs a name.", { tone: "error" });
    saving = true;
    anchor.disabled = true;
    try {
      const out = await ext.request("save", { session: ext.conversation.current ?? undefined, args: { id: id ?? undefined, name, directories: draft.directories, disable: [...draft.disable], instructions: draft.instructions } });
      const saved = out?.data?.project;
      const created = !id;
      if (saved?.id) id = saved.id;
      ext.toast(created ? `Project "${name}" created.` : `Project "${name}" saved.`, { tone: "ok" });
      await state.refresh();
      if (created && id) state.choose(id);
      if (alive) load();
    } catch (err) {
      ext.toast(err?.message || "The project could not be saved.", { tone: "error" });
    } finally {
      saving = false;
      anchor.disabled = false;
    }
  }

  async function remove(anchor) {
    const ok = await confirm(anchor, {
      title: "Delete this project?",
      lines: [
        ["Project", draft.name || id],
        ["Conversations", String(facts.conversations)],
      ],
      note: "The conversations stay; they leave the project. The directories on disk are not touched.",
      confirmLabel: "Delete",
      tone: "warn",
    });
    if (!ok || !alive) return;
    try {
      await ext.request("remove", { args: { id } });
      ext.toast(`Project "${draft.name}" deleted.`, { tone: "ok" });
      if (state.chosen === id) state.choose(null);
      id = null;
      await state.refresh();
      if (alive) load();
    } catch (err) {
      ext.toast(err?.message || "The project could not be deleted.", { tone: "error" });
    }
  }

  function actions() {
    const saveBtn = button(id ? "Save" : "Create project", { tone: "primary" });
    saveBtn.addEventListener("click", () => save(saveBtn));
    const removeBtn = id ? button("Delete project", { tone: "warn" }) : null;
    removeBtn?.addEventListener("click", () => remove(removeBtn));
    return el("div", { class: "pj-actions" }, saveBtn, removeBtn);
  }

  function draw() {
    if (!alive) return;
    const scrollTop = root.querySelector(".pj-place")?.scrollTop ?? 0;
    clear(root);
    const page = el(
      "div",
      { class: "pj-place" },
      el("div", { class: "pj-page" },
        el("section", { class: "pj-section" }, nameField()),
        directoriesSection(ext, draft, facts.mounts, draw),
        instructionsField(),
        conversationsSection(),
        toolsSection(ext, draft, facts.tools, draw),
        skillsSection(ext),
        actions()
      )
    );
    root.append(page);
    page.scrollTop = scrollTop;
  }

  load();
  return () => {
    alive = false;
  };
}
