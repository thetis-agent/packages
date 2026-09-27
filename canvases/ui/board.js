/* The board: a world under a translate-and-scale transform, the artboards as absolutely placed frames in
 * it (a name strip, the sandboxed iframe, a shield over it, handles when selected), the notes beside them,
 * and the gestures — the wheel pans, ctrl or ⌘ with it zooms about the cursor, the background drags to
 * pan, a frame or a note drags to move, a handle drags to resize. The shield is why any of that works:
 * an iframe swallows the pointer, so a transparent div over each one takes the clicks and drags instead,
 * and every iframe is inert while a gesture runs. In focus mode one frame is live — its shield off, the
 * artboard usable — and the rest stay pictures. Frames are diffed by file and a frame is reloaded only when
 * its file's time changed; props are posted into it live. One `message` listener serves every frame,
 * routed by the frame's own window and nonce. */

import { createFrame } from "./frame.js";
import { boundsOf, fitView, MAX_K, MIN_K, onPage, resizeBox, snap, toCanvas, zoomAt } from "./geometry.js";
import { createNotes } from "./notes.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const DRAG_START = 4;

const nonceOf = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2));

export function createBoard(ext, { base, onSelect, onChange, onFocusChange, onMenu, onEmpty }) {
  const { el, icon } = ext.dom;
  const root = el("div", { class: "cv-board", tabindex: "0", role: "region", "aria-label": "Canvas" });
  const world = el("div", { class: "cv-world" });
  const framesLayer = el("div", { class: "cv-frames" });
  const notesLayer = el("div", { class: "cv-notes" });
  const emptyNote = el("div", { class: "cv-board-empty", hidden: true });
  world.append(notesLayer, framesLayer);
  root.append(world, emptyNote);

  const view = { x: 0, y: 0, k: 1 };
  let fitted = false;
  let index = null;
  let files = {};
  let page = null;
  let selected = null; // { kind: "board", id: file } | { kind: "note", id }
  let focused = null;
  let before = null; // the view before focus
  const frames = new Map(); // file -> { node, strip, name, frame, box, reported }
  const sizes = {}; // file -> the rendered height of an expand:fill frame
  let gesture = null;

  const notes = createNotes(ext, { layer: notesLayer, onChange, onSelect: (id) => select({ kind: "note", id }) });

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    root.style.setProperty("--cv-k", String(view.k));
    root.style.backgroundPosition = `${view.x}px ${view.y}px`;
    root.style.backgroundSize = `${Math.max(8, 24 * view.k)}px ${Math.max(8, 24 * view.k)}px`;
    root.dispatchEvent(new CustomEvent("cv:view", { detail: { ...view } }));
  }

  const setView = (next) => {
    Object.assign(view, next);
    applyView();
  };

  const size = () => ({ w: root.clientWidth, h: root.clientHeight });

  function fit() {
    const { w, h } = size();
    if (!w || !h) return;
    setView(fitView(boundsOf(index ?? { boards: {}, notes: {} }, page, sizes), w, h, { pad: 48, max: 1 }));
    fitted = true;
  }

  function zoomBy(factor) {
    const { w, h } = size();
    setView(zoomAt(view, view.k * factor, w / 2, h / 2));
  }

  function zoomTo(k) {
    const { w, h } = size();
    setView(zoomAt(view, k, w / 2, h / 2));
  }

  // ---- frames ----

  function heightOf(file) {
    const b = index.boards[file];
    return b.expand === "fill" && sizes[file] ? Math.max(b.h, sizes[file]) : b.h;
  }

  function placeFrame(entry, file) {
    const b = index.boards[file];
    const { node } = entry;
    node.style.left = `${b.x}px`;
    node.style.top = `${b.y}px`;
    node.style.width = `${b.w}px`;
    node.style.height = `${heightOf(file)}px`;
    node.style.borderRadius = b.radius ? `${b.radius}px` : "";
    entry.name.textContent = b.title || file;
    entry.box = { x: b.x, y: b.y, w: b.w, h: b.h };
  }

  function makeFrame(file) {
    const nonce = nonceOf();
    const frame = createFrame({
      base,
      file,
      nonce,
      title: index.boards[file].title || file,
      onSize: ({ height }) => {
        const entry = frames.get(file);
        if (!entry || !index?.boards[file]) return;
        if (index.boards[file].expand === "fill" && sizes[file] !== height) {
          sizes[file] = height;
          entry.node.style.height = `${heightOf(file)}px`;
        }
      },
    });
    const name = el("span", { class: "cv-frame-name-text" });
    const strip = el("div", { class: "cv-frame-name", title: "Drag to move; double-click to rename" }, name);
    strip.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      rename(file);
    });
    const shield = el("div", { class: "cv-frame-shield" });
    const node = el("div", { class: "cv-frame", "data-file": file }, strip, frame.node, shield, ...HANDLES.map((dir) => el("div", { class: `cv-handle is-${dir}`, "data-dir": dir })));
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      select({ kind: "board", id: file });
      onMenu?.({ x: event.clientX, y: event.clientY }, file);
    });
    const entry = { node, strip, name, frame, box: null };
    frames.set(file, entry);
    framesLayer.append(node);
    return entry;
  }

  function rename(file) {
    const entry = frames.get(file);
    if (!entry) return;
    const input = el("input", { type: "text", class: "cv-frame-rename", value: index.boards[file].title || file, "aria-label": "Artboard name", spellcheck: "false" });
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const title = input.value.trim();
      input.replaceWith(entry.name);
      if (commit && title !== (index.boards[file].title || file)) onChange({ boards: { [file]: { title: title === file ? null : title } } });
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    entry.name.replaceWith(input);
    input.focus();
    input.select();
  }

  /** Draws `next` with its files' facts: frames diffed by file, each reloaded only when its file's time changed. */
  function render(next, nextFiles) {
    index = next;
    files = nextFiles ?? files;
    for (const [file, entry] of frames) if (!index.boards[file]) {
      entry.frame.dispose();
      entry.node.remove();
      frames.delete(file);
      delete sizes[file];
      if (selected?.kind === "board" && selected.id === file) select(null);
      if (focused === file) blur();
    }
    for (const file of index.order) {
      const entry = frames.get(file) ?? makeFrame(file);
      placeFrame(entry, file);
      framesLayer.append(entry.node); // back to front: the order of the layer
      const shown = onPage(index.boards[file], page);
      entry.node.hidden = !shown;
      const fact = files[file];
      entry.node.classList.toggle("is-missing", Boolean(fact?.missing));
      if (fact && !fact.missing && fact.mtime !== entry.frame.version) entry.frame.load(fact.mtime);
      entry.frame.postProps(index.boards[file].props ?? {});
    }
    notes.render(index.notes, page);
    const empty = !Object.keys(index.boards).length && !Object.keys(index.notes).length;
    emptyNote.hidden = !empty;
    if (empty) emptyNote.replaceChildren(...(onEmpty?.() ?? ["Nothing here yet. Ask for a design in a chat, and it appears on this canvas."]));
    if (!fitted && root.clientWidth) fit();
    if (selected) select(selected);
  }

  // ---- selection ----

  function select(next) {
    selected = next && ((next.kind === "board" && index?.boards[next.id]) || (next.kind === "note" && index?.notes[next.id])) ? next : null;
    for (const [file, entry] of frames) entry.node.classList.toggle("is-selected", selected?.kind === "board" && selected.id === file);
    notes.select(selected?.kind === "note" ? selected.id : null);
    onSelect?.(selected);
  }

  // ---- focus mode ----

  function focus(file) {
    if (!index?.boards[file]) return;
    if (!focused) before = { ...view };
    focused = file;
    root.classList.add("is-focused");
    for (const [f, entry] of frames) entry.node.classList.toggle("is-live", f === file);
    const b = index.boards[file];
    const { w, h } = size();
    root.classList.add("is-moving");
    setView(fitView({ x: b.x, y: b.y, w: b.w, h: heightOf(file) }, w, h, { pad: 24, max: 2 }));
    setTimeout(() => root.classList.remove("is-moving"), 220);
    select({ kind: "board", id: file });
    onFocusChange?.(file);
  }

  function blur() {
    if (!focused) return;
    focused = null;
    root.classList.remove("is-focused");
    for (const entry of frames.values()) entry.node.classList.remove("is-live");
    if (before) {
      root.classList.add("is-moving");
      setView(before);
      setTimeout(() => root.classList.remove("is-moving"), 220);
    }
    before = null;
    onFocusChange?.(null);
  }

  // ---- gestures ----

  root.addEventListener("pointerdown", (event) => {
    if (event.button === 2) return;
    if (event.target.closest(".cv-note-edit, .cv-frame-rename, input, textarea")) return;
    const handle = event.target.closest(".cv-handle");
    const frameNode = event.target.closest(".cv-frame");
    const noteNode = event.target.closest(".cv-note");
    const middle = event.button === 1;
    const pan = middle || event.target === root || event.target === world || event.target === framesLayer || event.target === notesLayer || event.target === emptyNote || (event.altKey && !handle);
    if (handle && frameNode && !middle) {
      const file = frameNode.dataset.file;
      select({ kind: "board", id: file });
      gesture = { kind: "resize", file, dir: handle.dataset.dir, sx: event.clientX, sy: event.clientY, box: { ...frames.get(file).box }, moved: false };
    } else if (frameNode && !pan) {
      const file = frameNode.dataset.file;
      if (focused === file) return; // the live artboard takes its own clicks
      select({ kind: "board", id: file });
      gesture = { kind: "move", target: "board", id: file, sx: event.clientX, sy: event.clientY, box: { ...frames.get(file).box }, moved: false };
    } else if (noteNode && !pan) {
      const id = noteNode.dataset.note;
      select({ kind: "note", id });
      const n = notes.noteOf(id);
      gesture = { kind: "move", target: "note", id, sx: event.clientX, sy: event.clientY, box: { x: n.x, y: n.y }, moved: false };
    } else {
      gesture = { kind: "pan", sx: event.clientX, sy: event.clientY, ox: view.x, oy: view.y, moved: false, middle };
      root.classList.add("is-panning");
    }
    root.classList.add("is-gesturing");
    root.setPointerCapture(event.pointerId);
    root.focus({ preventScroll: true });
    event.preventDefault();
  });

  root.addEventListener("pointermove", (event) => {
    if (!gesture) return;
    const dx = event.clientX - gesture.sx;
    const dy = event.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_START) return;
    gesture.moved = true;
    if (gesture.kind === "pan") {
      setView({ x: gesture.ox + dx, y: gesture.oy + dy });
      return;
    }
    const grid = event.altKey ? 1 : 8;
    const cx = dx / view.k;
    const cy = dy / view.k;
    if (gesture.kind === "move") {
      const x = snap(gesture.box.x + cx, grid);
      const y = snap(gesture.box.y + cy, grid);
      gesture.at = { x, y };
      if (gesture.target === "board") {
        const node = frames.get(gesture.id)?.node;
        if (node) {
          node.style.left = `${x}px`;
          node.style.top = `${y}px`;
          node.classList.add("is-dragging");
        }
      } else notes.move(gesture.id, x, y);
    } else if (gesture.kind === "resize") {
      const box = resizeBox(gesture.box, gesture.dir, cx, cy, 64);
      const snapped = { x: box.x, y: box.y, w: snap(box.w, grid), h: snap(box.h, grid) };
      if (gesture.dir.includes("w")) snapped.x = gesture.box.x + gesture.box.w - snapped.w;
      if (gesture.dir.includes("n")) snapped.y = gesture.box.y + gesture.box.h - snapped.h;
      gesture.at = snapped;
      const node = frames.get(gesture.file)?.node;
      if (node) {
        node.style.left = `${snapped.x}px`;
        node.style.top = `${snapped.y}px`;
        node.style.width = `${snapped.w}px`;
        node.style.height = `${snapped.h}px`;
        node.classList.add("is-dragging");
      }
    }
  });

  function endGesture(event, cancelled) {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    root.classList.remove("is-gesturing", "is-panning");
    for (const entry of frames.values()) entry.node.classList.remove("is-dragging");
    try {
      root.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (cancelled) {
      if (index) render(index, files);
      return;
    }
    if (g.kind === "pan") {
      if (!g.moved && !g.middle) select(null);
      return;
    }
    if (!g.moved || !g.at) return;
    if (g.kind === "move" && g.target === "board") onChange({ boards: { [g.id]: { x: g.at.x, y: g.at.y } } });
    else if (g.kind === "move") onChange({ notes: { [g.id]: { x: g.at.x, y: g.at.y } } });
    else if (g.kind === "resize") onChange({ boards: { [g.file]: g.at } });
  }
  root.addEventListener("pointerup", (event) => endGesture(event, false));
  root.addEventListener("pointercancel", (event) => endGesture(event, true));

  root.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const r = root.getBoundingClientRect();
      const dx = event.deltaMode === 1 ? event.deltaX * 16 : event.deltaX;
      const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (event.ctrlKey || event.metaKey) setView(zoomAt(view, view.k * Math.exp(-dy * 0.0025), event.clientX - r.left, event.clientY - r.top));
      else setView({ x: view.x - dx, y: view.y - dy });
    },
    { passive: false }
  );

  root.addEventListener("dblclick", (event) => {
    const frameNode = event.target.closest(".cv-frame");
    if (frameNode && !event.target.closest(".cv-frame-name") && focused !== frameNode.dataset.file) focus(frameNode.dataset.file);
  });

  // ---- messages from the frames: one listener, routed by the frame's window and its nonce ----

  const onMessage = (event) => {
    if (!event.data || typeof event.data !== "object") return;
    for (const entry of frames.values()) {
      if (event.source === entry.frame.node.contentWindow) {
        if (event.data.nonce === entry.frame.nonce) {
          const { nonce: _nonce, ...data } = event.data;
          entry.frame.handle(data);
        }
        return;
      }
    }
  };
  window.addEventListener("message", onMessage);

  // The first draw may come before the pane is laid out; fit once it has a size.
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (!fitted && root.clientWidth && index) fit(); }) : null;
  observer?.observe(root);
  applyView();

  return {
    node: root,
    render,
    fit,
    zoomBy,
    zoomTo,
    view: () => ({ ...view }),
    setPage(id) {
      page = id;
      if (index) render(index, files);
      fit();
    },
    page: () => page,
    select,
    selection: () => selected,
    focus,
    blur,
    focused: () => focused,
    rename,
    editNote: (id) => notes.edit(id),
    noteMenu: (at, id) => notes.menu(at, id),
    /** Posts prop values into one frame without saving: the panel's live preview. */
    preview(file, values) {
      frames.get(file)?.frame.postProps(values ?? {});
    },
    /** Where the middle of the viewport is, in canvas coordinates: where a new note goes. */
    centre() {
      const { w, h } = size();
      const p = toCanvas(view, w / 2, h / 2);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    },
    nudge(dx, dy) {
      if (!selected) return;
      if (selected.kind === "board") {
        const b = index.boards[selected.id];
        onChange({ boards: { [selected.id]: { x: b.x + dx, y: b.y + dy } } });
      } else {
        const n = index.notes[selected.id];
        onChange({ notes: { [selected.id]: { x: n.x + dx, y: n.y + dy } } });
      }
    },
    dispose() {
      window.removeEventListener("message", onMessage);
      observer?.disconnect();
      for (const entry of frames.values()) entry.frame.dispose();
      frames.clear();
      notes.dispose();
      root.remove();
    },
  };
}

export { MAX_K, MIN_K };
