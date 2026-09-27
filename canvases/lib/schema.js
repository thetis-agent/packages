// The shape of `canvas.json`, in two halves: `completeIndex` fills what an older or hand-edited file may
// lack and drops what cannot be right (an artboard with a bad name, a note with no text), so callers never
// test for fields; `checkIndex` refuses, with a sentence, an index that breaks a limit — it runs on every
// write, so what a tool or the page sends is checked once, in one place, whichever side wrote it.
import { isProjectId } from "./projects.js";

const KEY = /^[A-Za-z0-9_-]{1,32}$/;
const PROP = /^[a-z][a-z0-9_-]{0,31}$/;
const BOARD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.html$/;
const isBoardName = (name) => typeof name === "string" && BOARD.test(name) && !name.includes("..");
const LIMITS = { title: 120, boards: 64, notes: 256, pages: 16, props: 32, text: 4096, name: 80, coord: 1_000_000, sizeMin: 16, sizeMax: 16384, radius: 512 };
const NOTE_FILLS = ["gray", "red", "orange", "green", "teal", "blue", "purple", "pink"];

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);
const str = (v) => (typeof v === "string" ? v : "");
const fail = (message) => {
  throw new Error(message);
};

/** A prop value as it is stored: text, a number or a switch. Anything else is dropped. */
const propValue = (v) => (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ? v : undefined);

function completeBoard(b) {
  const out = { x: num(b.x, 0), y: num(b.y, 0), w: num(b.w, 1440), h: num(b.h, 900) };
  if (typeof b.title === "string" && b.title.trim()) out.title = b.title;
  if (typeof b.page === "string" && KEY.test(b.page)) out.page = b.page;
  if (b.expand === "fill") out.expand = "fill";
  if (typeof b.radius === "number" && Number.isFinite(b.radius)) out.radius = Math.round(b.radius);
  if (isObj(b.props)) {
    const props = {};
    for (const [key, value] of Object.entries(b.props)) {
      const v = propValue(value);
      if (PROP.test(key) && v !== undefined) props[key] = v;
    }
    if (Object.keys(props).length) out.props = props;
  }
  return out;
}

function completeNote(n) {
  const out = { x: num(n.x, 0), y: num(n.y, 0), text: n.text };
  if (n.kind === "title1") out.kind = "title1";
  for (const key of ["w", "maxW", "size"]) if (typeof n[key] === "number" && Number.isFinite(n[key])) out[key] = Math.round(n[key]);
  if (n.bold === true) out.bold = true;
  if (typeof n.color === "string" && n.color) out.color = n.color;
  if (typeof n.fill === "string" && n.fill) out.fill = n.fill;
  if (typeof n.page === "string" && KEY.test(n.page)) out.page = n.page;
  return out;
}

/** Fills the fields an older or hand-edited index may lack and drops what cannot be right. */
export function completeIndex(record) {
  const boards = {};
  for (const [file, b] of Object.entries(isObj(record.boards) ? record.boards : {})) if (isBoardName(file) && isObj(b)) boards[file] = completeBoard(b);
  const order = (Array.isArray(record.order) ? record.order : []).filter((f, i, a) => typeof f === "string" && boards[f] && a.indexOf(f) === i);
  for (const file of Object.keys(boards)) if (!order.includes(file)) order.push(file);
  const pages = [];
  for (const p of Array.isArray(record.pages) ? record.pages : []) if (isObj(p) && typeof p.id === "string" && KEY.test(p.id) && typeof p.name === "string" && !pages.some((q) => q.id === p.id)) pages.push({ id: p.id, name: p.name });
  const notes = {};
  for (const [id, n] of Object.entries(isObj(record.notes) ? record.notes : {})) if (KEY.test(id) && isObj(n) && typeof n.text === "string") notes[id] = completeNote(n);
  const launch = isObj(record.launch) && record.launch.view === "focused" && isBoardName(record.launch.file) && boards[record.launch.file] ? { view: "focused", file: record.launch.file } : { view: "canvas" };
  return {
    v: 1,
    id: record.id,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Untitled canvas",
    project: isProjectId(record.project) ? record.project : null,
    createdBy: typeof record.createdBy === "string" && record.createdBy ? record.createdBy : null,
    launch,
    pages,
    boards,
    order,
    notes,
    rev: Number.isInteger(record.rev) && record.rev >= 0 ? record.rev : 0,
    createdAt: str(record.createdAt),
    updatedAt: str(record.updatedAt),
  };
}

const within = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function checkProps(props, where) {
  if (!isObj(props)) fail(`${where}: props must be an object of values by prop name.`);
  const keys = Object.keys(props);
  if (keys.length > LIMITS.props) fail(`${where}: at most ${LIMITS.props} props.`);
  for (const key of keys) {
    if (!PROP.test(key)) fail(`${where}: ${JSON.stringify(key)} is not a prop name (lowercase letters, digits, _ and -, starting with a letter, up to 32).`);
    const v = props[key];
    if (typeof v === "string" ? v.length > LIMITS.text : typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))) fail(`${where}: the prop ${key} must be text of at most ${LIMITS.text} characters, a number, or true/false.`);
  }
}

/** Refuses, with a sentence, an index that breaks a limit or names what it does not hold. */
export function checkIndex(index) {
  if (!index.title || index.title.length > LIMITS.title) fail(`The title is 1 to ${LIMITS.title} characters.`);
  const files = Object.keys(index.boards);
  if (files.length > LIMITS.boards) fail(`A canvas holds at most ${LIMITS.boards} artboards.`);
  if (index.pages.length > LIMITS.pages) fail(`A canvas holds at most ${LIMITS.pages} pages.`);
  const pageIds = new Set(index.pages.map((p) => p.id));
  for (const p of index.pages) if (!p.name.trim() || p.name.length > LIMITS.name) fail(`A page's name is 1 to ${LIMITS.name} characters.`);
  for (const [file, b] of Object.entries(index.boards)) {
    const where = `artboard ${file}`;
    if (!within(b.x, -LIMITS.coord, LIMITS.coord) || !within(b.y, -LIMITS.coord, LIMITS.coord)) fail(`${where}: x and y are whole numbers within ±${LIMITS.coord}.`);
    if (!within(b.w, LIMITS.sizeMin, LIMITS.sizeMax) || !within(b.h, LIMITS.sizeMin, LIMITS.sizeMax)) fail(`${where}: w and h are whole numbers from ${LIMITS.sizeMin} to ${LIMITS.sizeMax}.`);
    if (b.title !== undefined && b.title.length > LIMITS.title) fail(`${where}: the title is at most ${LIMITS.title} characters.`);
    if (b.page !== undefined && !pageIds.has(b.page)) fail(`${where}: no page ${b.page} on this canvas.`);
    if (b.radius !== undefined && !within(b.radius, 0, LIMITS.radius)) fail(`${where}: radius is 0 to ${LIMITS.radius}.`);
    if (b.props !== undefined) checkProps(b.props, where);
  }
  if (index.order.length !== files.length || !index.order.every((f) => index.boards[f])) fail("order must name every artboard once.");
  const noteIds = Object.keys(index.notes);
  if (noteIds.length > LIMITS.notes) fail(`A canvas holds at most ${LIMITS.notes} notes.`);
  for (const [id, n] of Object.entries(index.notes)) {
    const where = `note ${id}`;
    if (!n.text.trim() || n.text.length > LIMITS.text) fail(`${where}: the text is 1 to ${LIMITS.text} characters.`);
    if (!within(n.x, -LIMITS.coord, LIMITS.coord) || !within(n.y, -LIMITS.coord, LIMITS.coord)) fail(`${where}: x and y are whole numbers within ±${LIMITS.coord}.`);
    for (const key of ["w", "maxW"]) if (n[key] !== undefined && !within(n[key], LIMITS.sizeMin, LIMITS.sizeMax)) fail(`${where}: ${key} is ${LIMITS.sizeMin} to ${LIMITS.sizeMax}.`);
    if (n.size !== undefined && !within(n.size, 8, 200)) fail(`${where}: size is a font size from 8 to 200.`);
    if (n.fill !== undefined && !NOTE_FILLS.includes(n.fill)) fail(`${where}: fill is one of ${NOTE_FILLS.join(", ")}.`);
    if (n.color !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(n.color) && !NOTE_FILLS.includes(n.color)) fail(`${where}: color is a hex color or one of ${NOTE_FILLS.join(", ")}.`);
    if (n.page !== undefined && !pageIds.has(n.page)) fail(`${where}: no page ${n.page} on this canvas.`);
  }
  if (index.launch.view === "focused" && !index.boards[index.launch.file]) fail(`launch names ${index.launch.file}, which is not an artboard here.`);
  return index;
}

export { KEY, PROP, LIMITS as INDEX_LIMITS, NOTE_FILLS, isBoardName, isObj };
