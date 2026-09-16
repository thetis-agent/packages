/* The project page, opened from the switcher with `{ id }` for a project's settings or `{}` for a new
 * one. It asks `get` once, keeps a draft (name, directories, switched-off tools and skills, instructions) and
 * redraws the body from the draft after every edit; nothing is sent until Save. Mounts are the exception,
 * and they have to be: a mount is a change to the workspace itself, not a field of the project, so the two
 * buttons that bind and unbind one send at once and the page then asks the server what the fence really
 * has. Binding closes the fence, which takes the gateway serving this page with it, so `mount` expects the
 * request to be lost and waits for the new workspace to answer instead of calling that a failure. The draft
 * is never reloaded around a bind: unsaved edits survive it. Save calls `save`,
 * toasts, and refreshes the switcher; for a new project it also chooses it, so the sidebar shows the
 * conversations that join it. Delete sits behind the shell's confirm popover; after it the page becomes
 * the new-project form, because the shell offers no way to close a place from inside it. `open` returns
 * an unmount that stops a late answer from drawing into a closed page. */

import { directoriesSection, skillsSection, toolsSection } from "./place-parts.js";

const BROWSED = "thetis.project.browsed";

/** Where the picker opens: the last directory chosen here, so a second one is two clicks away. */
function lastBrowsed() {
  try {
    return localStorage.getItem(BROWSED) || "/";
  } catch {
    return "/";
  }
}

function remember(path) {
  try {
    const parent = path.replace(/\/[^/]*$/, "") || "/";
    localStorage.setItem(BROWSED, parent);
  } catch {
    /* no storage: the picker opens at the root next time */
  }
}

export function openPlace(ext, state, root, params) {
  const { el, clear } = ext.dom;
  const { button, field, section, confirm } = ext.ui;
  let alive = true;
  let id = typeof params.id === "string" ? params.id : null;
  let draft = null; // { name, directories, disable: Set, disableSkills: Set, instructions }
  let facts = null; // { mounts, states, tools, skills, conversations, user }
  let saving = false;
  let checking = 0; // the last state check, so a slow answer never overwrites a newer one

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
        disableSkills: new Set(project?.skills?.disable ?? []),
        instructions: typeof data.instructions === "string" ? data.instructions : "",
      };
      facts = {
        mounts: Array.isArray(data.mounts) ? data.mounts : [],
        states: data.states && typeof data.states === "object" ? data.states : {},
        tools: Array.isArray(data.tools) ? data.tools : [],
        skills: Array.isArray(data.skills) ? data.skills : [],
        conversations: data.conversations ?? 0,
        user: typeof data.user === "string" ? data.user : "you",
      };
      draw();
    } catch (err) {
      if (!alive) return;
      clear(root);
      root.append(el("div", { class: "pj-place" }, el("p", { class: "pj-error" }, err?.message || "The project could not be read.")));
    }
  }

  /**
   * Asks the server what the fence has at every directory in the draft, including ones not saved yet, and
   * redraws. `wait` keeps asking while the workspace is reopening after a bind: the gateway is down for a
   * moment, so a failure there is not an answer.
   */
  async function checkStates({ wait = 0 } = {}) {
    const mine = ++checking;
    const deadline = Date.now() + wait;
    for (;;) {
      try {
        const out = await ext.request("mounts", { args: { paths: draft.directories } });
        if (!alive || mine !== checking) return;
        facts.mounts = Array.isArray(out?.data?.mounts) ? out.data.mounts : [];
        facts.states = out?.data?.states && typeof out.data.states === "object" ? out.data.states : {};
        draw();
        return;
      } catch (err) {
        if (!alive || mine !== checking) return;
        if (Date.now() >= deadline) {
          ext.toast("The workspace did not answer. Reload the page to see what it has.", { tone: "error" });
          return;
        }
        await new Promise((done) => setTimeout(done, 700));
      }
    }
  }

  /** Binds one directory into this person's workspace, changes its mode, or unbinds it with `mode: null`. */
  async function mount(anchor, path, mode) {
    const verb = mode === null ? "Unbind this directory?" : mode === "ro" ? "Bind it read-only?" : "Bind it read-write?";
    const ok = await confirm(anchor, {
      title: verb,
      lines: [["Directory", path], ["Mode", mode === null ? "none" : mode === "ro" ? "read-only" : "read-write"]],
      note: "Your workspace closes and opens again with the change, and its services restart. This page reconnects on its own. Nothing on disk is touched.",
      confirmLabel: mode === null ? "Unbind" : "Bind",
      tone: mode === null ? "warn" : "primary",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    let said = false;
    try {
      const out = await ext.request("mount", { args: { path, mode } });
      const m = out?.data?.mount ?? null;
      if (mode === null) ext.toast(`${path} is no longer bound.`, { tone: "ok" });
      else if (m && !m.present) ext.toast(`${path} is written down, but the host has nothing there, so the workspace opened without it.`, { tone: "error" });
      else ext.toast(`${path} is bound ${mode === "ro" ? "read-only" : "read-write"}.`, { tone: "ok" });
      said = true;
    } catch {
      // The fence closed before it could answer. That is the normal case for your own mounts.
    } finally {
      if (alive) anchor.disabled = false;
    }
    await checkStates({ wait: 30_000 });
    if (!said && alive) ext.toast(mode === null ? `${path} is no longer bound.` : "The workspace reopened with the change.", { tone: "ok" });
  }

  /** The directory picker, over the host directories an admin may bind. `accept` puts the path in the draft. */
  async function pick(anchor, accept) {
    const mode = el("select", { class: "input", "aria-label": "Mode" }, el("option", { value: "rw" }, "read-write"), el("option", { value: "ro" }, "read-only"));
    const chosen = await ext.ui.pickDirectory(anchor, {
      title: "Choose a project directory",
      start: lastBrowsed(),
      browse: async (path) => (await ext.request("browse", { args: { path } }))?.data ?? null,
      note: "The picker shows the host's directories. The one you choose is added to the project and bound into your workspace.",
      confirmLabel: "Use this directory",
      extra: mode,
    });
    if (!chosen || !alive) return;
    remember(chosen);
    if (!accept(chosen)) return;
    draw();
    await checkStates();
    if (!alive) return;
    // A mount may already cover it, through a parent bound earlier. Then there is nothing to bind.
    const now = facts.states[chosen];
    if (now?.state === "ready" && now.mode === mode.value) return;
    const anchorNow = root.querySelector(`.pj-dir[data-path="${CSS.escape(chosen)}"] .btn.is-primary`) ?? anchor;
    await mount(anchorNow, chosen, mode.value);
  }

  /** A directory was added or removed: redraw, then ask the server what the fence has at the new list. */
  function redrawDirectories() {
    draw();
    void checkStates();
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
      const out = await ext.request("save", { session: ext.conversation.current ?? undefined, args: { id: id ?? undefined, name, directories: draft.directories, disable: [...draft.disable], disableSkills: [...draft.disableSkills], instructions: draft.instructions } });
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
        directoriesSection(ext, draft, facts.states, redrawDirectories, { mount, pick, user: facts.user }),
        instructionsField(),
        conversationsSection(),
        toolsSection(ext, draft, facts.tools, draw),
        skillsSection(ext, draft, facts.skills, draw),
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
