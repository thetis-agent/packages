// One patch shape for the layout, whoever sends it: the `canvas_layout` tool and the page's `save` both
// hand `applyPatch` an index and a patch, and get a new index back (or a sentence). A patch is field-level
// — the frame of one artboard, one note, the order — so two writers rarely collide, and it never touches an
// artboard's HTML: that is `canvas_write_board`'s alone.
import { checkIndex, checkProps, isBoardName, isObj, KEY } from "./schema.js";

const fail = (message) => {
  throw new Error(message);
};

const intOf = (v, what) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what} must be a number.`);
  return Math.round(v);
};

function pages(list) {
  if (!Array.isArray(list)) fail("pages must be a list of { id, name }.");
  const out = [];
  for (const p of list) {
    if (!isObj(p) || typeof p.id !== "string" || !KEY.test(p.id)) fail("A page's id is letters, digits, _ and -, up to 32.");
    if (typeof p.name !== "string" || !p.name.trim()) fail(`The page ${p.id} needs a name.`);
    if (out.some((q) => q.id === p.id)) fail(`The page ${p.id} is listed twice.`);
    out.push({ id: p.id, name: p.name.trim() });
  }
  return out;
}

function board(before, change, file) {
  if (!isObj(change)) fail(`boards.${file} must be an object of changes.`);
  const next = { ...before, ...(before.props ? { props: { ...before.props } } : {}) };
  for (const key of ["x", "y", "w", "h"]) if (change[key] !== undefined) next[key] = intOf(change[key], `${file}: ${key}`);
  if (change.title !== undefined) {
    if (change.title === null || (typeof change.title === "string" && !change.title.trim())) delete next.title;
    else if (typeof change.title === "string") next.title = change.title.trim();
    else fail(`${file}: title must be text or null.`);
  }
  if (change.page !== undefined) {
    if (change.page === null) delete next.page;
    else if (typeof change.page === "string" && KEY.test(change.page)) next.page = change.page;
    else fail(`${file}: page must be a page id or null.`);
  }
  if (change.expand !== undefined) {
    if (change.expand === null) delete next.expand;
    else if (change.expand === "fill") next.expand = "fill";
    else fail(`${file}: expand is "fill" or null.`);
  }
  if (change.radius !== undefined) {
    if (change.radius === null) delete next.radius;
    else next.radius = intOf(change.radius, `${file}: radius`);
  }
  if (change.props !== undefined) {
    if (!isObj(change.props)) fail(`${file}: props must be an object; a key set to null drops that override.`);
    const props = { ...(next.props ?? {}) };
    for (const [key, value] of Object.entries(change.props)) {
      if (value === null) delete props[key];
      else props[key] = value;
    }
    checkProps(props, `artboard ${file}`);
    if (Object.keys(props).length) next.props = props;
    else delete next.props;
  }
  return next;
}

function note(before, change, id) {
  if (!isObj(change)) fail(`notes.${id} must be an object, or null to delete the note.`);
  const next = { ...(before ?? {}) };
  for (const key of ["x", "y"]) if (change[key] !== undefined) next[key] = intOf(change[key], `note ${id}: ${key}`);
  if (change.text !== undefined) {
    if (typeof change.text !== "string") fail(`note ${id}: text must be text.`);
    next.text = change.text;
  }
  if (change.kind !== undefined) {
    if (change.kind === null) delete next.kind;
    else if (change.kind === "title1") next.kind = "title1";
    else fail(`note ${id}: kind is "title1" for a title, or nothing for a sticky.`);
  }
  for (const key of ["w", "maxW", "size"]) {
    if (change[key] === undefined) continue;
    if (change[key] === null) delete next[key];
    else next[key] = intOf(change[key], `note ${id}: ${key}`);
  }
  if (change.bold !== undefined) {
    if (change.bold === true) next.bold = true;
    else if (change.bold === false || change.bold === null) delete next.bold;
    else fail(`note ${id}: bold is true or false.`);
  }
  for (const key of ["color", "fill", "page"]) {
    if (change[key] === undefined) continue;
    if (change[key] === null) delete next[key];
    else if (typeof change[key] === "string" && change[key]) next[key] = change[key];
    else fail(`note ${id}: ${key} must be text or null.`);
  }
  if (!before && (next.x === undefined || next.y === undefined || typeof next.text !== "string")) fail(`note ${id} is new and needs x, y and text.`);
  return next;
}

/**
 * The index with `patch` applied, checked. `title`; `launch`; `pages` (the whole list; an artboard or note
 * on a page that went is on every page again); `boards` by file (frames, title, page, expand, radius, props,
 * where null drops a field or a prop override; an artboard that is not there is refused, since HTML is
 * written elsewhere); `order` (the files named go to the front, in that order; the rest keep theirs);
 * `notes` by id (null deletes; an unknown id with x, y and text is a new note).
 */
export function applyPatch(index, patch) {
  if (!isObj(patch)) fail("A layout patch is an object.");
  const next = { ...index, boards: { ...index.boards }, notes: { ...index.notes }, pages: [...index.pages], order: [...index.order], launch: { ...index.launch } };
  const touched = [];
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || !patch.title.trim()) fail("title must be text, and not empty.");
    next.title = patch.title.trim();
    touched.push("title");
  }
  if (patch.pages !== undefined) {
    next.pages = pages(patch.pages);
    const ids = new Set(next.pages.map((p) => p.id));
    for (const [file, b] of Object.entries(next.boards)) if (b.page !== undefined && !ids.has(b.page)) next.boards[file] = { ...b, page: undefined };
    for (const [id, n] of Object.entries(next.notes)) if (n.page !== undefined && !ids.has(n.page)) next.notes[id] = { ...n, page: undefined };
    for (const b of Object.values(next.boards)) if (b.page === undefined) delete b.page;
    for (const n of Object.values(next.notes)) if (n.page === undefined) delete n.page;
    touched.push(`pages: ${next.pages.length}`);
  }
  if (patch.boards !== undefined) {
    if (!isObj(patch.boards)) fail("boards must be an object of changes by artboard file.");
    let n = 0;
    for (const [file, change] of Object.entries(patch.boards)) {
      if (!isBoardName(file) || !next.boards[file]) fail(`No artboard ${file} on this canvas; write it first with canvas_write_board.`);
      next.boards[file] = board(next.boards[file], change, file);
      n += 1;
    }
    touched.push(n === 1 ? `artboard ${Object.keys(patch.boards)[0]}` : `${n} artboards`);
  }
  if (patch.order !== undefined) {
    if (!Array.isArray(patch.order)) fail("order must be a list of artboard files.");
    const named = [];
    for (const file of patch.order) {
      if (!isBoardName(file) || !next.boards[file]) fail(`order names ${JSON.stringify(file)}, which is not an artboard here.`);
      if (!named.includes(file)) named.push(file);
    }
    next.order = [...next.order.filter((f) => !named.includes(f)), ...named];
    touched.push("order");
  }
  if (patch.notes !== undefined) {
    if (!isObj(patch.notes)) fail("notes must be an object of changes by note id, null to delete one.");
    let n = 0;
    for (const [id, change] of Object.entries(patch.notes)) {
      if (!KEY.test(id)) fail(`${JSON.stringify(id)} is not a note id: letters, digits, _ and -, up to 32.`);
      if (change === null) delete next.notes[id];
      else next.notes[id] = note(next.notes[id], change, id);
      n += 1;
    }
    touched.push(n === 1 ? "1 note" : `${n} notes`);
  }
  if (patch.launch !== undefined) {
    if (!isObj(patch.launch) || (patch.launch.view !== "canvas" && patch.launch.view !== "focused")) fail('launch is { view: "canvas" } or { view: "focused", file }.');
    if (patch.launch.view === "focused") {
      if (!isBoardName(patch.launch.file) || !next.boards[patch.launch.file]) fail(`launch names ${JSON.stringify(patch.launch.file)}, which is not an artboard here.`);
      next.launch = { view: "focused", file: patch.launch.file };
    } else next.launch = { view: "canvas" };
    touched.push("launch");
  }
  checkIndex(next);
  return { index: next, touched };
}
