/* The Canvases section of the sidebar: one row per canvas the chosen project shows — its own and the
 * global ones, or every canvas under "All" — with the project's name as a badge when it has one, the
 * open one marked, a ＋ in the section's actions that makes a canvas in the chosen project and opens it,
 * and a row menu: Rename (in place), Move to a project or Global, Delete (confirmed). Everything is built
 * with `ext.dom.el`; the shell's tokens and the `.cv-` rules in index.css do the drawing. */

import { MORE, PLUS } from "./icons.js";

const TAB = "canvas";

function when(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function mountSidebar(ext, model, body, tools) {
  const { el, icon, clear } = ext.dom;
  let renaming = null; // the id whose title is an input
  const list = el("div", { class: "cv-list", role: "list" });
  body.append(list);

  const plus = el("button", { type: "button", class: "icon-btn sm cv-plus", title: "New canvas", "aria-label": "New canvas", onClick: () => void create() }, icon(PLUS, { size: 14, width: 1.8 }));
  tools?.setActions?.(plus);

  async function create() {
    plus.disabled = true;
    try {
      const canvas = await model.create({ title: "Untitled canvas" });
      if (canvas) {
        await ext.open.tab(TAB, canvas.id, { id: canvas.id, rename: true });
      }
    } catch (err) {
      ext.toast(`The canvas was not created: ${err.message}`, { tone: "error" });
    } finally {
      plus.disabled = false;
    }
  }

  /** The rows the chosen project shows: its own, the global ones, and the ones whose project is gone. */
  function visible() {
    const chosen = model.project();
    return chosen ? model.canvases.filter((c) => c.project === chosen || !c.project || c.projectMissing) : model.canvases;
  }

  function menu(anchor, row) {
    const items = [
      { label: "Rename", run: () => { renaming = row.id; draw(); } },
    ];
    const targets = model.projects.filter((p) => p.id !== row.project);
    for (const p of targets) items.push({ label: `Move to ${p.name}`, run: () => void move(row, p.id) });
    if (row.project) items.push({ label: "Make global", run: () => void move(row, null) });
    items.push("-", { label: "Delete", danger: true, run: () => void remove(anchor, row) });
    ext.ui.menu(anchor, items);
  }

  async function move(row, project) {
    try {
      await model.assign(row.id, project);
      await model.refresh();
    } catch (err) {
      ext.toast(`The canvas was not moved: ${err.message}`, { tone: "error" });
    }
  }

  async function remove(anchor, row) {
    const ok = await ext.ui.confirm(anchor, { title: "Delete this canvas?", lines: [["Canvas", row.title], ["Artboards", String(row.boards)]], note: "Its artboards, assets and notes are deleted for good.", confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    try {
      await model.remove(row.id);
      ext.close.tab(TAB, row.id);
      await model.refresh();
    } catch (err) {
      ext.toast(`The canvas was not deleted: ${err.message}`, { tone: "error" });
    }
  }

  function renameField(row) {
    const input = el("input", { type: "text", class: "cv-row-rename", value: row.title, "aria-label": "Canvas name", spellcheck: "false" });
    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      renaming = null;
      const title = input.value.trim();
      if (commit && title && title !== row.title) {
        try {
          await model.rename(row.id, title);
        } catch (err) {
          ext.toast(`The canvas was not renamed: ${err.message}`, { tone: "error" });
        }
      }
      draw();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") void finish(true);
      if (event.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return input;
  }

  function rowNode(row) {
    const showBadge = !model.project() && row.project;
    const title = renaming === row.id ? renameField(row) : el("span", { class: "cv-row-title" }, row.title);
    const more = el("button", { type: "button", class: "icon-btn sm cv-row-more", title: "More", "aria-label": `More for ${row.title}`, onClick: (event) => { event.stopPropagation(); menu(more, row); } }, icon(MORE, { size: 14, width: 2 }));
    const node = el(
      "div",
      { class: `cv-row${model.active === row.id ? " is-active" : ""}${row.projectMissing ? " is-orphan" : ""}`, role: "listitem", "data-canvas": row.id, title: row.projectMissing ? `${row.title} · its project is gone, so it shows everywhere` : row.title },
      el("button", { type: "button", class: "cv-row-open", onClick: () => void ext.open.tab(TAB, row.id, { id: row.id }) },
        title,
        showBadge ? el("span", { class: "cv-row-badge" }, row.projectName ?? row.project) : null,
        el("span", { class: "cv-row-when" }, when(row.updatedAt))),
      more
    );
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      menu({ x: event.clientX, y: event.clientY }, row);
    });
    return node;
  }

  function draw() {
    clear(list);
    const rows = visible();
    tools?.setCount?.(rows.length);
    if (!rows.length) {
      list.append(el("div", { class: "cv-empty" }, model.status === "lost" ? "Reconnecting…" : model.project() ? "No canvases in this project. ＋ makes one." : "No canvases yet. ＋ makes one, or ask for a design in a chat."));
      return;
    }
    for (const row of rows) list.append(rowNode(row));
    if (model.status === "lost") list.append(el("div", { class: "cv-empty cv-lost" }, "Reconnecting…"));
  }

  const unwatch = model.watch(draw);
  draw();
  return () => {
    unwatch();
    clear(list);
  };
}
