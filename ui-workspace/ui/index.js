/* The browser module of @thetis/ui-workspace. The shell calls `install(ext)` once; it builds the one
 * model the three surfaces share and registers them: the Workspace place (the explorer beside the tabs,
 * the file view and the status strip), the Files dock (`dock.js`) and the file links in the transcript
 * (`links.js`). Opening the place with `{ path, line }` reveals that file in the explorer and opens it in
 * a tab at that line; `{ dir }` reveals and opens a folder. Everything a tab shows comes from
 * `createViewer`, which routes by the file's `preview` (a plain text file is the editor inside it), each
 * mounted in its own pane and kept while its tab stays open, so switching tabs never reloads a file.
 * `open` returns the unmount, which takes the explorer, the tabs, every view and the strip down. */

import { createModel, nameOf } from "./model.js";
import { openMenu, setExt, closeMenu } from "./menu.js";
import { fileMenu } from "./file-menu.js";
import { mountExplorer } from "./explorer.js";
import { mountTabs } from "./tabs.js";
import { ICONS } from "./icons.js";
import { detectEol } from "./editor.js";
import { createViewer } from "./viewer.js";
import { mountStrip } from "./strip.js";
import { bindDialogs, confirmDelete, downloadFile, downloadZip, newEntry, rename, upload } from "./dialogs.js";
import { drawDock } from "./dock.js";
import { installLinks } from "./links.js";

const PHONE = "(max-width: 760px)";

export default function install(ext) {
  setExt(ext);
  const model = createModel(ext);
  bindDialogs(ext, model);
  ext.place("workspace", { open: (root, params) => openPlace(ext, model, root, params ?? {}) });
  ext.dock("files", { draw: () => drawDock(ext, model) });
  installLinks(ext, model);
  ext.conversation.watch(() => ext.redraw("files"));
  model.watch((event) => {
    if (event.kind === "roots") ext.redraw("files");
  });
}

function openPlace(ext, model, root, params) {
  const { el, icon, clear, setHidden } = ext.dom;
  const session = ext.conversation.current ?? null;
  let alive = true;
  const panes = new Map(); // path -> { path, host, banners, view, kind, file, entry }

  // ---- the frame ----

  const explorerHost = el("aside", { class: "ws-explorer-col", "aria-label": "Explorer" });
  const handle = el("div", { class: "ws-resize", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize the explorer", tabindex: "0", title: "Drag to resize; arrow keys nudge" });
  const back = el("button", { type: "button", class: "ws-back", onClick: () => showList() }, icon(ICONS.back, { size: 16, width: 1.7 }), "Files");
  const tabsHost = el("div", { class: "ws-tabs-host" });
  const body = el("div", { class: "ws-body" });
  const empty = el("div", { class: "ws-empty" }, el("div", { class: "ws-empty-title" }, "Nothing open"), el("div", { class: "ws-empty-hint" }, "Choose a file in the explorer. Enter opens it, F2 renames, n makes a new file."));
  const stripHost = el("div", { class: "ws-strip-host" });
  const editorCol = el("section", { class: "ws-editor", "aria-label": "Editor" }, el("div", { class: "ws-editor-top" }, back, tabsHost), body, stripHost);
  const place = el("div", { class: "ws-place" }, explorerHost, handle, editorCol);
  place.style.setProperty("--ws-explorer-w", `${model.explorerWidth}px`);
  body.append(empty);
  root.append(place);

  const strip = mountStrip(stripHost);
  const phone = typeof matchMedia === "function" ? matchMedia(PHONE) : null;
  const showList = () => place.classList.remove("is-file");
  const showFile = () => place.classList.add("is-file");

  // ---- the explorer and its actions ----

  const hostActions = {
    open: (entry) => openFile(entry.path),
    upload: (entry, { files } = {}) => (files?.length ? upload(ext, model, { dir: entry.path, files, onDone: () => model.invalidate(entry.path) }) : pickFiles(entry)),
    download: (entry) => (entry.kind === "dir" ? downloadZip(ext, model, entry) : downloadFile(ext, entry)),
    remove: (entry, { anchor } = {}) => confirmDelete(anchor ?? place, ext, model, entry),
    count: (entry) => model.count(entry.path),
    newFile: (entry) => newEntry(explorer, entry.path, "file"),
    newFolder: (entry) => newEntry(explorer, entry.path, "dir"),
    rename: (entry) => rename(explorer, entry),
  };

  function pickFiles(entry) {
    const input = el("input", { type: "file", multiple: true, class: "ws-file-input", "aria-hidden": "true", tabindex: "-1" });
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length) hostActions.upload(entry, { files });
    });
    place.append(input);
    input.click();
  }

  const explorer = mountExplorer(explorerHost, { model, ext, session, onOpen: (entry) => openFile(entry.path), actions: hostActions });

  // ---- tabs and panes ----

  const tabs = mountTabs(tabsHost, {
    model,
    ext,
    onClose: (tab) => dropPane(tab.path),
  });

  function dropPane(path) {
    const pane = panes.get(path);
    if (!pane) return;
    panes.delete(path);
    try {
      pane.view?.destroy?.();
    } catch (err) {
      console.error("a workspace view threw while closing:", err);
    }
    pane.host.remove();
  }

  /** A tab's pane, built on first sight: `stat`, the text when it is textual, then the editor or viewer. */
  async function ensurePane(tab) {
    if (panes.has(tab.path)) return panes.get(tab.path);
    const banners = el("div", { class: "ws-banners" });
    const host = el("div", { class: "ws-pane", "data-path": tab.path }, banners, el("div", { class: "ws-empty is-loading" }, `Opening ${tab.name}…`));
    const pane = { path: tab.path, host, banners, view: null, kind: null, file: null, entry: null, loading: true };
    panes.set(tab.path, pane);
    body.append(host);
    try {
      const stat = await model.stat(tab.path);
      if (!alive || panes.get(tab.path) !== pane) return pane;
      const file = { ...stat, path: stat.path || tab.path };
      const textual = (stat.preview === "text" || stat.preview === "markdown") && !stat.tooLarge && !stat.binary;
      if (textual) {
        const read = await model.readText(file.path);
        if (!alive || panes.get(tab.path) !== pane) return pane;
        file.text = read.text;
        file.etag = read.etag ?? stat.etag;
        file.truncated = Boolean(read.truncated);
      }
      host.querySelector(".ws-empty")?.remove();
      const mode = stat.mode ?? (stat.writable === false ? "ro" : "rw");
      pane.entry = { path: file.path, name: nameOf(file.path), kind: "file", mode, root: stat.root, display: stat.display };
      const callbacks = {
        line: tab.line ?? undefined,
        banner: banners,
        active: model.tabs.active()?.path === tab.path,
        onCursor: (cursor) => activeIs(tab.path) && strip.set({ cursor }),
        onSaved: ({ etag, size, mtime }) => {
          file.etag = etag ?? file.etag;
          if (size != null) file.size = size;
          if (mtime != null) file.mtime = mtime;
          if (activeIs(tab.path)) strip.set({ size: file.size, saved: file.mtime, dirty: false });
        },
        onDirty: (dirty) => activeIs(tab.path) && strip.set({ dirty }),
      };
      pane.kind = stat.preview === "text" && textual ? "editor" : "viewer";
      pane.file = file;
      pane.view = createViewer(host, { ext, model, file, text: file.text, etag: file.etag, session, actions: { download: () => hostActions.download(pane.entry) }, ...callbacks });
      model.tabs.update(tab.path, { kind: pane.kind, mode, root: stat.root ?? null, name: nameOf(file.path) });
    } catch (err) {
      if (!alive || panes.get(tab.path) !== pane) return pane;
      clear(host);
      host.append(banners, el("div", { class: "ws-empty is-err" }, el("div", { class: "ws-empty-title" }, `${tab.name} could not be opened`), el("div", { class: "ws-empty-hint" }, err?.message || "The workspace did not answer.")));
    }
    pane.loading = false;
    if (activeIs(tab.path)) showPane(pane);
    return pane;
  }

  const activeIs = (path) => model.tabs.active()?.path === path;

  /** Shows one pane, hides the others, fills the strip and the right cluster from it. */
  function showPane(pane) {
    for (const other of panes.values()) {
      const on = other === pane;
      setHidden(other.host, !on);
      if (other.view?.setActive && other !== pane) other.view.setActive(false);
    }
    setHidden(empty, true);
    pane.view?.setActive?.(true);
    const tab = model.tabs.list().find((t) => t.path === pane.path);
    const file = pane.file;
    if (file) {
      strip.set({
        path: file.display ?? file.path,
        root: file.root ?? "",
        mode: pane.entry?.mode ?? "",
        language: file.language ?? "",
        size: file.size,
        saved: file.mtime,
        dirty: Boolean(tab?.dirty),
        readOnly: pane.entry?.mode === "ro" || file.writable === false,
        encoding: "UTF-8",
        eol: typeof file.text === "string" ? detectEol(file.text) : "",
        cursor: null,
      });
    } else strip.clear();
    drawRight(pane);
    if (tab?.line && pane.view?.goTo) {
      pane.view.goTo(tab.line);
      model.tabs.update(pane.path, { line: null });
    }
  }

  function drawRight(pane) {
    const entry = pane.entry;
    const download = entry ? el("button", { type: "button", class: "icon-btn sm", title: "Download", "aria-label": "Download", onClick: () => hostActions.download(entry) }, icon(ICONS.download, { size: 16, width: 1.6 })) : null;
    const more = entry
      ? el("button", { type: "button", class: "icon-btn sm", title: "More…", "aria-label": `More for ${entry.name}`, onClick: () => openMenu(more, fileMenu(entry, "explorer", boundActions(entry, more))) }, icon(ICONS.more, { size: 16, width: 2.2 }))
      : null;
    tabs.right.replaceChildren(...[pane.view?.controls ?? null, download, more].filter(Boolean));
  }

  /** The file menu's actions for the open file, each carrying the anchor the dialogs want. */
  function boundActions(entry, anchor) {
    const out = {};
    for (const name of ["open", "download", "copyPath", "rename", "remove", "count"]) {
      if (name === "copyPath") out[name] = (e) => copyPath(e.path);
      else if (typeof hostActions[name] === "function") out[name] = (e) => hostActions[name](e, { anchor });
    }
    return out;
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      ext.toast(`Copied ${path}`);
    } catch {
      ext.toast(`The path could not be copied: ${path}`, { tone: "warn" });
    }
  }

  function syncPanes() {
    if (!alive) return;
    const open = new Set(model.tabs.list().map((t) => t.path));
    for (const path of [...panes.keys()]) if (!open.has(path)) dropPane(path);
    const active = model.tabs.active();
    if (!active) {
      for (const pane of panes.values()) setHidden(pane.host, true);
      setHidden(empty, false);
      strip.clear();
      tabs.right.replaceChildren();
      showList();
      return;
    }
    const pane = panes.get(active.path);
    if (pane && !pane.loading) showPane(pane);
    else {
      for (const other of panes.values()) setHidden(other.host, other.path !== active.path);
      setHidden(empty, true);
      if (!pane) ensurePane(active);
    }
  }

  /** Opens a file in a tab (or brings its tab forward), at a line when one is given. */
  function openFile(path, { line, activate = true } = {}) {
    if (!path) return;
    model.tabs.open(path, { line, activate, name: nameOf(path) });
    if (activate) showFile();
    const pane = panes.get(path);
    if (line && pane?.view?.goTo && !pane.loading) {
      pane.view.goTo(line);
      model.tabs.update(path, { line: null });
    }
  }

  const stopTabs = model.watch((event) => {
    if (event.kind === "tabs") syncPanes();
  });

  // ---- the resize handle ----

  const range = model.explorerWidthRange;
  let dragging = null;
  const setWidth = (px) => {
    const width = Math.max(range.min, Math.min(range.max, Math.round(px)));
    place.style.setProperty("--ws-explorer-w", `${width}px`);
    return width;
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = { pointer: event.pointerId, width: model.explorerWidth };
    handle.setPointerCapture(event.pointerId);
    place.classList.add("is-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== dragging.pointer) return;
    dragging.width = setWidth(event.clientX - place.getBoundingClientRect().left);
  });
  const endDrag = (event) => {
    if (!dragging || (event && event.pointerId !== dragging.pointer)) return;
    model.setExplorerWidth(dragging.width);
    dragging = null;
    place.classList.remove("is-resizing");
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      model.setExplorerWidth(setWidth(model.explorerWidth + (event.key === "ArrowLeft" ? -step : step)));
    } else if (event.key === "Home") {
      event.preventDefault();
      model.setExplorerWidth(setWidth(range.default));
    }
  });
  handle.addEventListener("dblclick", () => model.setExplorerWidth(setWidth(range.default)));

  // ---- the opening request ----

  syncPanes();
  (async () => {
    if (typeof params.path === "string" && params.path && params.rename === true) {
      // Asked to rename from somewhere without a row (a chat link): reveal the entry and start there.
      await explorer.reveal(params.path);
      if (alive) explorer.beginRename(params.path);
    } else if (typeof params.path === "string" && params.path) {
      const line = Number.isFinite(Number(params.line)) && Number(params.line) > 0 ? Number(params.line) : undefined;
      openFile(params.path, { line });
      await explorer.reveal(params.path);
    } else if (typeof params.dir === "string" && params.dir) {
      await explorer.reveal(params.dir);
      if (alive) model.setExpanded(params.dir, true);
      showList();
    } else if (phone?.matches && model.tabs.active()) showFile();
  })().catch((err) => console.error("the workspace could not open what it was asked:", err));

  return function unmount() {
    alive = false;
    stopTabs();
    closeMenu();
    for (const path of [...panes.keys()]) dropPane(path);
    try {
      explorer.destroy();
    } catch (err) {
      console.error("the explorer threw while closing:", err);
    }
    tabs.destroy();
    strip.destroy?.();
    place.remove();
  };
}
