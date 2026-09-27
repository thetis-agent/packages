/* The notes on a board: a sticky (a filled card of text) or a title (one bold line over a row of
 * artboards). Each is an absolutely placed element in the notes layer; the board moves it during a drag
 * and this module draws it, edits its text in place on a double-click, and offers its menu (fill, bold,
 * size, delete). Every change goes out as one layout patch through `onChange`. */

import { NOTE_FILLS } from "./fills.js";

export function createNotes(ext, { layer, onChange, onSelect }) {
  const { el, clear } = ext.dom;
  const nodes = new Map(); // id -> { node, text, note }
  let editing = null;

  function place(entry, n) {
    const { node } = entry;
    node.style.left = `${n.x}px`;
    node.style.top = `${n.y}px`;
    if (n.kind === "title1") {
      node.style.width = "";
      node.style.maxWidth = `${n.maxW ?? 600}px`;
    } else {
      node.style.width = `${n.w ?? 240}px`;
      node.style.maxWidth = "";
      node.style.maxHeight = `${n.maxH ?? Math.round(((n.w ?? 240) * 4) / 3)}px`;
    }
    node.style.fontSize = n.size ? `${n.size}px` : "";
    node.style.color = n.color && /^#/.test(n.color) ? n.color : "";
    node.className = `cv-note ${n.kind === "title1" ? "is-title1" : "is-sticky"} is-fill-${n.fill && NOTE_FILLS.includes(n.fill) ? n.fill : "gray"}${n.bold ? " is-bold" : ""}${n.color && NOTE_FILLS.includes(n.color) ? ` is-color-${n.color}` : ""}`;
    entry.text.textContent = n.text;
    entry.note = n;
  }

  function make(id, n) {
    const text = el("div", { class: "cv-note-text" });
    const node = el("div", { class: "cv-note", "data-note": id, tabindex: "0" }, text);
    node.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      edit(id);
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect?.(id);
      menu({ x: event.clientX, y: event.clientY }, id);
    });
    const entry = { node, text, note: n };
    nodes.set(id, entry);
    layer.append(node);
    place(entry, n);
    return entry;
  }

  /** Draws the notes on `page`: new ones made, gone ones removed, the rest moved and restyled. An edit in progress is left alone. */
  function render(notes, page) {
    for (const [id, entry] of nodes) if (!notes[id]) {
      entry.node.remove();
      nodes.delete(id);
      if (editing === id) editing = null;
    }
    for (const [id, n] of Object.entries(notes)) {
      const entry = nodes.get(id) ?? make(id, n);
      if (editing !== id) place(entry, n);
      const shown = page === null || n.page === undefined || n.page === page;
      entry.node.hidden = !shown;
    }
  }

  function edit(id) {
    const entry = nodes.get(id);
    if (!entry || editing === id) return;
    editing = id;
    const before = entry.note.text;
    const area = el("textarea", { class: "cv-note-edit", "aria-label": "Note text", spellcheck: "true" });
    area.value = before;
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      editing = null;
      const text = area.value.trim();
      area.replaceWith(entry.text);
      if (commit && text && text !== before) onChange({ notes: { [id]: { text } } });
      else entry.text.textContent = before;
    };
    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      }
      if (event.key === "Escape") finish(false);
    });
    area.addEventListener("blur", () => finish(true));
    area.addEventListener("pointerdown", (event) => event.stopPropagation());
    entry.text.replaceWith(area);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function menu(at, id) {
    const n = nodes.get(id)?.note;
    if (!n) return;
    const items = [{ label: "Edit text", run: () => edit(id) }];
    if (n.kind !== "title1") items.push({ label: "Fill ▸", disabled: true }, ...NOTE_FILLS.map((fill) => ({ label: `  ${fill}${(n.fill ?? "gray") === fill ? " ✓" : ""}`, run: () => onChange({ notes: { [id]: { fill } } }) })));
    items.push("-", { label: n.bold ? "Regular" : "Bold", run: () => onChange({ notes: { [id]: { bold: !n.bold } } }) });
    for (const [label, size] of n.kind === "title1" ? [["Smaller", 48], ["Larger", 96]] : [["Small", 12], ["Medium", 14], ["Large", 18]]) items.push({ label, run: () => onChange({ notes: { [id]: { size } } }) });
    items.push("-", { label: "Delete note", danger: true, run: () => onChange({ notes: { [id]: null } }) });
    ext.ui.menu(at, items);
  }

  return {
    render,
    edit,
    menu,
    nodeOf: (id) => nodes.get(id)?.node ?? null,
    noteOf: (id) => nodes.get(id)?.note ?? null,
    /** During a drag: the node moves; the patch goes out when the drag ends. */
    move(id, x, y) {
      const entry = nodes.get(id);
      if (!entry) return;
      entry.node.style.left = `${x}px`;
      entry.node.style.top = `${y}px`;
    },
    select(id) {
      for (const [k, entry] of nodes) entry.node.classList.toggle("is-selected", k === id);
    },
    isEditing: () => editing !== null,
    dispose() {
      clear(layer);
      nodes.clear();
    },
  };
}
