/* A canvas as a tab: the toolbar (the title to rename in place, the pages, zoom, fit, focus, notes, the
 * properties panel, the menu), the board, and the panel beside it. It reads the canvas once, mints the
 * frame base for it, and then follows the model's events for that canvas: another writer's revision makes
 * it read again and redraw, keeping the selection, the view and the page; its own revision only diffs the
 * files' times; a removal shows a banner. What the person changes goes out as small patches, coalesced,
 * and the answered index is adopted only when nothing else is in flight. */

import { createBoard } from "./board.js";
import { CARET, FIT, FOCUS, MORE, NOTE, PLUS, SLIDERS, TITLE, TRASH, ZOOM_IN, ZOOM_OUT } from "./icons.js";
import { mountProps } from "./props.js";

const COALESCE_MS = 250;
const TAB = "canvas";

const noteId = () => `n_${Math.random().toString(16).slice(2, 8)}`;

export function openCanvasTab(ext, model, root, handle) {
  const { el, icon, clear } = ext.dom;
  const id = handle.id;
  let index = null;
  let files = {};
  let base = null;
  let board = null;
  let props = null;
  let pending = null; // the patch not yet sent
  let sending = false;
  let inFlight = 0;
  let gone = false;
  let active = false;
  let renaming = null;

  // ---- the chrome ----

  const titleBtn = el("button", { type: "button", class: "cv-title", title: "Rename this canvas", onClick: () => rename() });
  const pages = el("div", { class: "cv-pages", role: "tablist", "aria-label": "Pages" });
  const zoomLabel = el("button", { type: "button", class: "cv-zoom-label mono", title: "Back to 100%", onClick: () => board?.zoomTo(1) }, "100%");
  const focusBtn = el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Focus on the selected artboard (Enter); Escape leaves", "aria-label": "Focus", onClick: () => toggleFocus() }, icon(FOCUS, { size: 15, width: 1.6 }));
  const propsBtn = el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Properties of the selected artboard", "aria-label": "Properties", "aria-pressed": "false", onClick: () => togglePanel() }, icon(SLIDERS, { size: 15, width: 1.6 }));
  const menuBtn = el("button", { type: "button", class: "icon-btn sm cv-tool", title: "More", "aria-label": "More", onClick: () => menu() }, icon(MORE, { size: 15, width: 2 }));
  const toolbar = el(
    "div",
    { class: "cv-toolbar" },
    titleBtn,
    pages,
    el("span", { class: "cv-toolbar-gap" }),
    el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Add a sticky note", "aria-label": "Add a note", onClick: () => addNote(false) }, icon(NOTE, { size: 15, width: 1.6 })),
    el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Add a title over a row of artboards", "aria-label": "Add a title", onClick: () => addNote(true) }, icon(TITLE, { size: 15, width: 1.6 })),
    el("span", { class: "cv-toolbar-sep" }),
    el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Zoom out (−)", "aria-label": "Zoom out", onClick: () => board?.zoomBy(1 / 1.25) }, icon(ZOOM_OUT, { size: 15, width: 1.6 })),
    zoomLabel,
    el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Zoom in (+)", "aria-label": "Zoom in", onClick: () => board?.zoomBy(1.25) }, icon(ZOOM_IN, { size: 15, width: 1.6 })),
    el("button", { type: "button", class: "icon-btn sm cv-tool", title: "Fit everything (F)", "aria-label": "Fit", onClick: () => board?.fit() }, icon(FIT, { size: 15, width: 1.6 })),
    focusBtn,
    el("span", { class: "cv-toolbar-sep" }),
    propsBtn,
    menuBtn
  );
  const banner = el("div", { class: "cv-banner", hidden: true });
  const panel = el("aside", { class: "cv-props", hidden: true, "aria-label": "Properties" });
  const body = el("div", { class: "cv-body" });
  const node = el("div", { class: "cv-tab" }, toolbar, banner, body);
  root.append(node);

  // ---- the title ----

  function drawTitle() {
    if (!index) return;
    titleBtn.textContent = index.title;
    titleBtn.title = `${index.title} — click to rename`;
    handle.setTitle(index.title);
  }

  function rename() {
    if (renaming || !index) return;
    const input = el("input", { type: "text", class: "cv-title-edit", value: index.title, "aria-label": "Canvas name", spellcheck: "false" });
    renaming = input;
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      renaming = null;
      const title = input.value.trim();
      input.replaceWith(titleBtn);
      if (commit && title && title !== index.title) change({ title });
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    titleBtn.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- the pages ----

  function drawPages() {
    clear(pages);
    if (!index) return;
    const current = board?.page() ?? null;
    const tab = (label, pageId) => el("button", { type: "button", role: "tab", class: `cv-page${current === pageId ? " is-current" : ""}`, "aria-selected": current === pageId ? "true" : "false", onClick: () => { board?.setPage(pageId); drawPages(); }, onContextmenu: pageId ? (event) => { event.preventDefault(); pageMenu({ x: event.clientX, y: event.clientY }, pageId); } : null }, label);
    pages.append(tab("All", null));
    for (const p of index.pages) pages.append(tab(p.name, p.id));
    pages.append(el("button", { type: "button", class: "icon-btn sm cv-page-add", title: "Add a page", "aria-label": "Add a page", onClick: () => addPage() }, icon(PLUS, { size: 12, width: 2 })));
    pages.hidden = false;
  }

  function addPage() {
    const name = window.prompt("Name the page", `Page ${index.pages.length + 1}`);
    if (!name || !name.trim()) return;
    const pageId = `p${Date.now().toString(36)}`;
    change({ pages: [...index.pages, { id: pageId, name: name.trim() }] });
  }

  function pageMenu(at, pageId) {
    const p = index.pages.find((x) => x.id === pageId);
    if (!p) return;
    ext.ui.menu(at, [
      { label: "Rename page", run: () => { const name = window.prompt("Name the page", p.name); if (name && name.trim()) change({ pages: index.pages.map((x) => (x.id === pageId ? { ...x, name: name.trim() } : x)) }); } },
      { label: "Put the selected artboard on this page", disabled: board?.selection()?.kind !== "board", run: () => change({ boards: { [board.selection().id]: { page: pageId } } }) },
      "-",
      { label: "Delete page", danger: true, run: () => { if (board?.page() === pageId) board.setPage(null); change({ pages: index.pages.filter((x) => x.id !== pageId) }); } },
    ]);
  }

  // ---- notes, focus, the panel, the menu ----

  function addNote(title) {
    const at = board.centre();
    const nid = noteId();
    change({ notes: { [nid]: title ? { x: at.x - 300, y: at.y - 200, text: "Title", kind: "title1", maxW: 600 } : { x: at.x - 120, y: at.y - 80, text: "Note", w: 240, fill: "orange" } } });
    setTimeout(() => board.editNote(nid), 350);
  }

  function toggleFocus() {
    if (board.focused()) return board.blur();
    const sel = board.selection();
    if (sel?.kind === "board") board.focus(sel.id);
    else ext.toast("Select an artboard to focus on it.");
  }

  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    propsBtn.setAttribute("aria-pressed", String(open));
    node.classList.toggle("has-panel", open);
    if (open) drawPanel();
  }

  function drawPanel() {
    const sel = board?.selection();
    if (!props) return;
    if (sel?.kind === "board" && index?.boards[sel.id]) {
      const fact = files[sel.id] ?? {};
      props.show({ file: sel.id, title: index.boards[sel.id].title, decl: fact.decl ?? null, values: index.boards[sel.id].props ?? {}, problems: fact.problems ?? [] });
    } else props.hide();
  }

  function menu() {
    const items = [];
    const targets = model.projects.filter((p) => p.id !== index?.project);
    for (const p of targets) items.push({ label: `Move to ${p.name}`, run: () => void model.assign(id, p.id).catch((err) => ext.toast(err.message, { tone: "error" })) });
    if (index?.project) items.push({ label: "Make global", run: () => void model.assign(id, null).catch((err) => ext.toast(err.message, { tone: "error" })) });
    items.push({ label: index?.launch.view === "focused" ? "Open on the whole canvas" : "Open on the selected artboard", disabled: index?.launch.view !== "focused" && board?.selection()?.kind !== "board", run: () => change({ launch: index.launch.view === "focused" ? { view: "canvas" } : { view: "focused", file: board.selection().id } }) });
    items.push("-", { label: "Delete canvas", icon: TRASH, danger: true, run: () => void removeCanvas() });
    ext.ui.menu(menuBtn, items);
  }

  async function removeCanvas() {
    const ok = await ext.ui.confirm(menuBtn, { title: "Delete this canvas?", lines: [["Canvas", index?.title ?? id], ["Artboards", String(Object.keys(index?.boards ?? {}).length)]], note: "Its artboards, assets and notes are deleted for good.", confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    try {
      await model.remove(id);
      handle.close();
    } catch (err) {
      ext.toast(`The canvas was not deleted: ${err.message}`, { tone: "error" });
    }
  }

  function boardMenu(at, file) {
    const b = index.boards[file];
    ext.ui.menu(at, [
      { label: "Focus", run: () => board.focus(file) },
      { label: "Rename", run: () => board.rename(file) },
      { label: "Properties", run: () => { board.select({ kind: "board", id: file }); togglePanel(true); } },
      "-",
      { label: "Bring to front", run: () => change({ order: [file] }) },
      { label: "Send to back", run: () => change({ order: [file, ...index.order.filter((f) => f !== file)] }) },
      { label: b.expand === "fill" ? "Fixed height" : "Grow to the page's height", run: () => change({ boards: { [file]: { expand: b.expand === "fill" ? null : "fill" } } }) },
      ...(index.pages.length ? ["-", ...index.pages.map((p) => ({ label: `${b.page === p.id ? "✓ " : ""}On page ${p.name}`, run: () => change({ boards: { [file]: { page: b.page === p.id ? null : p.id } } }) }))] : []),
      "-",
      { label: "Delete artboard", icon: TRASH, danger: true, run: () => void removeBoard(file) },
    ]);
  }

  async function removeBoard(file) {
    const ok = await ext.ui.confirm(board.node, { title: "Delete this artboard?", lines: [["Artboard", index.boards[file].title || file]], note: "Its file is deleted; the notes stay.", confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    try {
      await model.remove(id, file);
    } catch (err) {
      ext.toast(`The artboard was not deleted: ${err.message}`, { tone: "error" });
    }
  }

  // ---- changes out: optimistic, coalesced, one save at a time ----

  /** A patch merged into the pending one: the newest value per key, boards and notes per id. */
  function merge(into, patch) {
    const out = { ...(into ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if ((key === "boards" || key === "notes") && value && typeof value === "object") {
        out[key] = { ...(out[key] ?? {}) };
        for (const [k, v] of Object.entries(value)) {
          if (v === null || out[key][k] === null || out[key][k] === undefined) out[key][k] = v;
          else {
            const merged = { ...out[key][k], ...v };
            if (v.props && out[key][k].props) merged.props = { ...out[key][k].props, ...v.props };
            out[key][k] = merged;
          }
        }
      } else out[key] = value;
    }
    return out;
  }

  /** Applies a patch to the local index at once, for the redraw, in the small way the board needs. */
  function applyLocally(patch) {
    if (!index) return;
    const next = { ...index, boards: { ...index.boards }, notes: { ...index.notes } };
    if (patch.title) next.title = patch.title;
    if (patch.pages) next.pages = patch.pages;
    if (patch.launch) next.launch = patch.launch;
    if (patch.order) next.order = [...next.order.filter((f) => !patch.order.includes(f)), ...patch.order.filter((f) => next.boards[f])];
    for (const [file, v] of Object.entries(patch.boards ?? {})) {
      if (!next.boards[file]) continue;
      const b = { ...next.boards[file], ...v };
      for (const k of ["title", "page", "expand", "radius"]) if (b[k] === null) delete b[k];
      if (v.props) {
        b.props = { ...(next.boards[file].props ?? {}), ...v.props };
        for (const k of Object.keys(b.props)) if (b.props[k] === null) delete b.props[k];
        if (!Object.keys(b.props).length) delete b.props;
      }
      next.boards[file] = b;
    }
    for (const [nid, v] of Object.entries(patch.notes ?? {})) {
      if (v === null) delete next.notes[nid];
      else {
        const n = { ...(next.notes[nid] ?? {}), ...v };
        for (const k of Object.keys(n)) if (n[k] === null) delete n[k];
        next.notes[nid] = n;
      }
    }
    index = next;
    board?.render(index, files);
    drawTitle();
    drawPages();
    drawPanel();
  }

  function change(patch) {
    if (gone) return;
    applyLocally(patch);
    pending = merge(pending, patch);
    void flush();
  }

  async function flush() {
    if (sending || !pending) return;
    sending = true;
    await new Promise((done) => setTimeout(done, COALESCE_MS));
    const patch = pending;
    pending = null;
    inFlight += 1;
    try {
      const out = await model.save(id, patch, index?.rev);
      if (out.canvas && !pending) {
        index = out.canvas;
        board?.render(index, files);
        drawTitle();
        drawPages();
        drawPanel();
      }
    } catch (err) {
      ext.toast(`The change was not saved: ${err.message}`, { tone: "error" });
      await reload();
    } finally {
      inFlight -= 1;
      sending = false;
      if (pending) void flush();
    }
  }

  // ---- changes in ----

  async function reload() {
    if (gone) return;
    try {
      const out = await model.get(id);
      if (!out.canvas) return;
      index = out.canvas;
      files = out.files ?? {};
      board?.render(index, files);
      drawTitle();
      drawPages();
      drawPanel();
    } catch (err) {
      if (/No canvas/.test(err.message)) showGone();
      else ext.toast(`The canvas could not be read: ${err.message}`, { tone: "error" });
    }
  }

  function showGone() {
    gone = true;
    banner.hidden = false;
    banner.replaceChildren("This canvas was deleted.", el("button", { type: "button", class: "btn is-quiet", onClick: () => handle.close() }, "Close the tab"));
    node.classList.add("is-gone");
  }

  const unwatch = model.onCanvas(id, (event) => {
    if (event.kind === "removed") return showGone();
    if (event.kind !== "changed" || !board) return;
    if (event.own && !inFlight) {
      // This page's own write, echoed: only the files' facts may have moved (an asset upload, say).
      const mine = { ...files };
      for (const [file, fact] of Object.entries(event.files)) mine[file] = { ...(mine[file] ?? {}), ...fact };
      files = mine;
      board.render(index, files);
      return;
    }
    if (event.own || inFlight) return; // our own, or something of ours still on its way: the answer will say
    void reload();
  });

  // ---- keyboard ----

  function onKey(event) {
    if (event.target.closest("input, textarea, select")) return;
    const sel = board.selection();
    const step = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case "Escape":
        if (board.focused()) board.blur();
        else board.select(null);
        break;
      case "Delete":
      case "Backspace":
        if (sel?.kind === "note") change({ notes: { [sel.id]: null } });
        else if (sel?.kind === "board") void removeBoard(sel.id);
        else return;
        break;
      case "Enter":
        if (sel?.kind === "board" && !board.focused()) board.focus(sel.id);
        else if (sel?.kind === "note") board.editNote(sel.id);
        else return;
        break;
      case "ArrowLeft": board.nudge(-step, 0); break;
      case "ArrowRight": board.nudge(step, 0); break;
      case "ArrowUp": board.nudge(0, -step); break;
      case "ArrowDown": board.nudge(0, step); break;
      case "f": case "F": board.fit(); break;
      case "0": board.zoomTo(1); break;
      case "+": case "=": board.zoomBy(1.25); break;
      case "-": case "_": board.zoomBy(1 / 1.25); break;
      default: return;
    }
    event.preventDefault();
  }

  // ---- start ----

  async function start() {
    try {
      const [out, minted] = await Promise.all([model.get(id), ext.frame.url("frame", { canvas: id })]);
      if (!out.canvas) throw new Error("no canvas");
      index = out.canvas;
      files = out.files ?? {};
      base = minted;
    } catch (err) {
      if (/No canvas|no canvas/.test(err.message)) return showGone();
      body.append(el("div", { class: "cv-error" }, `The canvas could not be opened: ${err.message}`));
      return;
    }
    board = createBoard(ext, {
      base,
      onSelect: () => { drawPanel(); focusBtn.classList.toggle("is-on", Boolean(board?.focused())); },
      onChange: change,
      onFocusChange: (file) => { focusBtn.classList.toggle("is-on", Boolean(file)); focusBtn.setAttribute("aria-pressed", String(Boolean(file))); },
      onMenu: boardMenu,
    });
    board.node.addEventListener("cv:view", (event) => { zoomLabel.textContent = `${Math.round(event.detail.k * 100)}%`; });
    board.node.addEventListener("keydown", onKey);
    props = mountProps(ext, panel, {
      onLive: (file, values) => board.preview(file, values),
      onSave: (file, values) => change({ boards: { [file]: { props: values } } }),
    });
    body.append(board.node, panel);
    board.render(index, files);
    drawTitle();
    drawPages();
    if (index.launch.view === "focused" && index.boards[index.launch.file]) setTimeout(() => board.focus(index.launch.file), 50);
    if (handle.params?.rename) setTimeout(rename, 50);
    if (active) model.setActive(id);
  }
  void start();

  return {
    activate() {
      active = true;
      model.setActive(id);
      if (board && !gone) setTimeout(() => board.fit(), 0);
    },
    deactivate() {
      active = false;
      if (model.active === id) model.setActive(null);
    },
    unmount() {
      unwatch();
      if (model.active === id) model.setActive(null);
      props?.dispose();
      board?.dispose();
      node.remove();
    },
  };
}

export { TAB };
