// Editing a map document. Pure: every op takes a document and answers a new one plus what it did, in
// sentences, or throws an Error whose message says what to fix. Nothing here knows about files or the MOO.
//
// Rooms are named three ways, wherever a tool takes one:
//   "r12"                       the map's own id
//   "#123" or "#0A52…-9FC2…"    the MOO room it is linked to (needs the link)
//   { x, y, z?, area? }         the room on that cell; area defaults to the map's first area

import {
  DIRS, OPPOSITE, LONG, PLANAR, EXIT_TYPES, DEFAULT_COLOR, LIMITS, ELEVATOR_DEFAULTS,
  cellKey, completeDoc, checkDoc, dirOf, exitDirFrom, stepDir,
} from "../ui/core/doc.js";

const clone = (doc) => JSON.parse(JSON.stringify(doc));
const isInt = Number.isInteger;
const plural = (n, word) => `${n} ${n === 1 ? word : /(ch|sh|s|x)$/.test(word) ? `${word}es` : `${word}s`}`;
export const at = (r) => `(${r.x},${r.y},${r.z})`;
export const nameOf = (r) => `${r.id} "${r.name}"`;

export class Book {
  constructor(doc, link) {
    this.doc = doc;
    this.link = link;
    this.reindex();
  }
  reindex() {
    const d = this.doc;
    this.areas = new Map(d.areas.map((a) => [a.id, a]));
    this.rooms = new Map(d.rooms.map((r) => [r.id, r]));
    this.cells = new Map(d.rooms.map((r) => [cellKey(r.area, r.x, r.y, r.z), r]));
    this.blocks = new Set(d.blocks.map((b) => cellKey(b.area, b.x, b.y, b.z)));
    this.mooRoom = new Map(Object.entries(this.link?.rooms ?? {}).map(([k, v]) => [v, k]));
  }
  id(prefix) {
    const n = this.doc.nextId;
    this.doc.nextId = n + 1;
    return `${prefix}${n}`;
  }
  area(ref, { required = true } = {}) {
    if (ref === undefined || ref === null || ref === "") return this.doc.areas[0];
    const s = String(ref);
    const a = this.areas.get(s) ?? [...this.areas.values()].find((x) => x.name.toLowerCase() === s.toLowerCase())
      ?? (this.link ? this.areas.get(Object.entries(this.link.areas).find(([, v]) => v === s)?.[0]) : undefined);
    if (!a && required) throw new Error(`the map has no area ${s}. Its areas: ${this.doc.areas.map((x) => `${x.id} "${x.name}"`).join(", ")}.`);
    return a;
  }
  cell(c) {
    const a = this.area(c.area);
    const z = c.z ?? 0;
    if (!isInt(c.x) || !isInt(c.y) || !isInt(z)) throw new Error(`a cell needs integer x and y (and z): got ${JSON.stringify(c)}`);
    return { area: a.id, x: c.x, y: c.y, z };
  }
  roomAt(c) {
    const k = this.cell(c);
    return this.cells.get(cellKey(k.area, k.x, k.y, k.z));
  }
  room(ref, { required = true } = {}) {
    let r;
    if (ref && typeof ref === "object") r = this.roomAt(ref);
    else if (typeof ref === "string" && ref.startsWith("#")) r = this.rooms.get(this.mooRoom.get(ref));
    else r = this.rooms.get(String(ref));
    if (!r && required) {
      const what = typeof ref === "object" ? `on cell ${JSON.stringify(ref)}` : String(ref);
      throw new Error(`the map has no room ${what}.`);
    }
    return r;
  }
  exitsOf(r) {
    return this.doc.exits.filter((e) => e.a === r.id || e.b === r.id);
  }
  /** Each exit of r with its direction from r and the room at the far end. */
  sides(r) {
    return this.exitsOf(r).map((e) => {
      const other = this.rooms.get(e.a === r.id ? e.b : e.a);
      const dir = exitDirFrom(this.doc, e, r, this.rooms);
      return { e, other, dir, adjacent: other && other.area === r.area && stepDir(r, other) === dir };
    });
  }
  done(lines) {
    const problems = checkDoc(this.doc);
    if (problems.length) throw new Error(problems.join(" "));
    return { doc: this.doc, lines };
  }
}

const book = (doc, link) => new Book(clone(doc), link);

function exitSpec(x) {
  const o = typeof x === "string" ? { dir: x } : { ...x };
  const dir = dirOf(o.dir);
  if (!dir) throw new Error(`"${o.dir}" is not a direction: use n ne e se s sw w nw up down.`);
  const type = o.type ?? "open";
  if (!EXIT_TYPES.includes(type)) throw new Error(`exit type "${type}" is not one of ${EXIT_TYPES.join(", ")}.`);
  return { dir, type, hidden: Boolean(o.hidden) };
}

function text(v, max, what) {
  if (typeof v !== "string") throw new Error(`${what} must be a string.`);
  if (v.length > max) throw new Error(`${what} is ${v.length} characters; at most ${max}.`);
  return v;
}

/** A description given as a string or as a list of paragraphs. */
const descOf = (v) => text(Array.isArray(v) ? v.map(String).join("\n") : v, LIMITS.description, "description");

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Set rooms by cell (or by id): an empty cell gets a new room, an occupied one is updated. `exits`, when
 * given, is the room's whole set of exits to its grid neighbours in the same area: missing pairs are
 * added, unlisted ones removed. Exits to non-neighbours and other areas are left alone.
 */
export function setRooms(doc, link, specs) {
  if (!Array.isArray(specs) || !specs.length) throw new Error("rooms must be a non-empty list.");
  const b = book(doc, link);
  const lines = [];
  const placed = [];
  // Pass 1: every room exists before any exit is made.
  for (const s of specs) {
    let r = s.room !== undefined ? b.room(s.room) : b.roomAt(s);
    if (!r) {
      if (typeof s.name !== "string" || !s.name.trim()) throw new Error(`a new room at ${JSON.stringify({ x: s.x, y: s.y, z: s.z ?? 0 })} needs a name.`);
      const c = b.cell(s);
      if (b.blocks.has(cellKey(c.area, c.x, c.y, c.z))) throw new Error(`(${c.x},${c.y},${c.z}) in ${c.area} is blocked out; unblock it first.`);
      r = { id: b.id("r"), area: c.area, x: c.x, y: c.y, z: c.z, name: text(s.name.trim(), LIMITS.name, "name"), color: DEFAULT_COLOR, description: "", notes: "" };
      b.doc.rooms.push(r);
      b.rooms.set(r.id, r);
      b.cells.set(cellKey(c.area, c.x, c.y, c.z), r);
      lines.push(`made ${nameOf(r)} at ${at(r)} in ${r.area}`);
    } else {
      const changed = [];
      if (s.name !== undefined && s.name !== r.name) { r.name = text(String(s.name).trim(), LIMITS.name, "name"); changed.push("name"); }
      if (changed.length) lines.push(`renamed ${nameOf(r)}`);
    }
    const changed = [];
    if (s.description !== undefined) { const d = descOf(s.description); if (d !== r.description) { r.description = d; changed.push("description"); } }
    if (s.notes !== undefined) { const n = text(String(s.notes), LIMITS.notes, "notes"); if (n !== r.notes) { r.notes = n; changed.push("notes"); } }
    if (s.color !== undefined) { const c = text(String(s.color), 32, "color"); if (c !== r.color) { r.color = c; changed.push("color"); } }
    if (changed.length) lines.push(`set ${changed.join(", ")} of ${nameOf(r)}`);
    placed.push([r, s]);
  }
  // Pass 2: exits to neighbours, declaratively.
  for (const [r, s] of placed) {
    if (!Array.isArray(s.exits)) continue;
    const want = new Map(s.exits.map((x) => { const e = exitSpec(x); return [e.dir, e]; }));
    for (const side of b.sides(r)) {
      if (!side.adjacent) continue;
      const w = want.get(side.dir);
      if (!w) {
        b.doc.exits = b.doc.exits.filter((x) => x !== side.e);
        lines.push(`removed exit ${side.e.id} ${nameOf(r)} ${side.dir} ⇄ ${nameOf(side.other)}`);
        continue;
      }
      want.delete(side.dir);
      const e = side.e;
      if (e.type !== w.type || e.hidden !== w.hidden) {
        e.type = w.type; e.hidden = w.hidden;
        lines.push(`exit ${e.id} ${nameOf(r)} ${side.dir} is now ${w.type}${w.hidden ? ", hidden" : ""}`);
      }
    }
    for (const w of want.values()) {
      const [dx, dy, dz] = DIRS[w.dir];
      const o = b.cells.get(cellKey(r.area, r.x + dx, r.y + dy, r.z + dz));
      if (!o) throw new Error(`${nameOf(r)} at ${at(r)} has no room to its ${LONG[w.dir]} (${r.x + dx},${r.y + dy},${r.z + dz}) to join. Make that room in the same call, or leave ${w.dir} out.`);
      const clash = b.exitsOf(r).find((e) => e.a === o.id || e.b === o.id);
      if (clash) throw new Error(`${nameOf(r)} and ${nameOf(o)} are already joined by ${clash.id}.`);
      const e = { id: b.id("e"), a: r.id, b: o.id, type: w.type, hidden: w.hidden, dir: "both" };
      b.doc.exits.push(e);
      lines.push(`joined ${nameOf(r)} ${w.dir} ⇄ ${OPPOSITE[w.dir]} ${nameOf(o)}${w.type !== "open" ? ` [${w.type}]` : ""}${w.hidden ? " [hidden]" : ""}`);
    }
  }
  return b.done(lines);
}

/** Delete rooms, with their exits, edges that start or land in them. */
export function deleteRooms(doc, link, refs) {
  const b = book(doc, link);
  const gone = new Set(refs.map((ref) => b.room(ref).id));
  const ex = b.doc.exits.filter((e) => gone.has(e.a) || gone.has(e.b)).length;
  const eg = b.doc.edges.filter((g) => gone.has(g.from) || gone.has(g.success) || gone.has(g.fail)).length;
  const names = b.doc.rooms.filter((r) => gone.has(r.id)).map(nameOf);
  b.doc.rooms = b.doc.rooms.filter((r) => !gone.has(r.id));
  b.doc.exits = b.doc.exits.filter((e) => !gone.has(e.a) && !gone.has(e.b));
  b.doc.edges = b.doc.edges.filter((g) => !gone.has(g.from) && !gone.has(g.success) && !gone.has(g.fail));
  let st = 0;
  for (const v of b.doc.elevators) { const n = v.stops.length; v.stops = v.stops.filter((x) => !gone.has(x.room)); st += n - v.stops.length; }
  return b.done([`deleted ${names.join(", ")}`, ...(ex ? [`and ${plural(ex, "exit")}`] : []), ...(eg ? [`and ${plural(eg, "edge")}`] : []), ...(st ? [`and ${plural(st, "elevator stop")}`] : [])]);
}

/**
 * Move rooms: by an offset (dx, dy, dz), or one room to a cell (to), and optionally into another area.
 * The whole set moves at once, so rooms may shift into cells the set itself vacates. Exits between
 * rooms that stop being neighbours stay (they become non-adjacent); across areas they get adir/bdir.
 */
export function moveRooms(doc, link, { rooms, dx = 0, dy = 0, dz = 0, to, area }) {
  const b = book(doc, link);
  const list = (rooms ?? []).map((ref) => b.room(ref));
  if (!list.length) throw new Error("name the rooms to move.");
  const target = area !== undefined ? b.area(area).id : undefined;
  if (to) {
    if (list.length !== 1) throw new Error("to moves one room; give dx/dy/dz to move several.");
    const c = { x: to.x, y: to.y, z: to.z ?? list[0].z };
    if (!isInt(c.x) || !isInt(c.y) || !isInt(c.z)) throw new Error("to needs integer x and y (and z).");
    dx = c.x - list[0].x; dy = c.y - list[0].y; dz = c.z - list[0].z;
  }
  if (![dx, dy, dz].every(isInt)) throw new Error("dx, dy and dz must be integers.");
  const moving = new Set(list.map((r) => r.id));
  const before = new Map(list.map((r) => [r.id, { ...r }]));
  for (const r of list) {
    const n = { area: target ?? r.area, x: r.x + dx, y: r.y + dy, z: r.z + dz };
    const k = cellKey(n.area, n.x, n.y, n.z);
    const o = b.cells.get(k);
    if (o && !moving.has(o.id)) throw new Error(`${nameOf(r)} cannot move to ${at(n)} in ${n.area}: ${nameOf(o)} is there.`);
    if (b.blocks.has(k)) throw new Error(`${nameOf(r)} cannot move to ${at(n)} in ${n.area}: that cell is blocked out.`);
  }
  for (const r of list) Object.assign(r, { area: target ?? r.area, x: r.x + dx, y: r.y + dy, z: r.z + dz });
  b.reindex();
  // Exits that now cross areas keep the directions they had, as adir/bdir.
  for (const e of b.doc.exits) {
    if (!moving.has(e.a) && !moving.has(e.b)) continue;
    const ra = b.rooms.get(e.a), rb = b.rooms.get(e.b);
    if (ra.area !== rb.area && (!e.adir || !e.bdir)) {
      const was = { ...b.doc, rooms: b.doc.rooms.map((r) => before.get(r.id) ?? r) };
      const byId = new Map(was.rooms.map((r) => [r.id, r]));
      e.adir = e.adir || exitDirFrom(was, e, byId.get(e.a), byId) || "e";
      e.bdir = e.bdir || exitDirFrom(was, e, byId.get(e.b), byId) || OPPOSITE[e.adir];
    }
  }
  const lines = [`moved ${plural(list.length, "room")} by (${dx},${dy},${dz})${target ? ` into ${target}` : ""}`];
  const broke = b.doc.exits.filter((e) => (moving.has(e.a) !== moving.has(e.b)) && b.rooms.get(e.a).area === b.rooms.get(e.b).area && !stepDir(b.rooms.get(e.a), b.rooms.get(e.b)));
  if (broke.length) lines.push(`${plural(broke.length, "exit")} now join rooms that are not neighbours: ${broke.map((e) => e.id).join(", ")}. Publishing them names each side by the general direction; consider map_unlink or moving the rest along.`);
  return b.done(lines);
}

// ---------------------------------------------------------------------------
// Exits and edges
// ---------------------------------------------------------------------------

/**
 * Join two rooms. Neighbours in one area need nothing more; rooms in different areas need the direction
 * each side is named by (adir from `from`, bdir from `to`), defaulting to the general direction between
 * them. Changing an existing exit between them updates it instead.
 */
export function link(doc, lnk, { from, to, dir, type = "open", hidden = false, adir, bdir }) {
  const b = book(doc, lnk);
  const a = b.room(from);
  let o;
  if (to !== undefined) o = b.room(to);
  else {
    const d = dirOf(dir);
    if (!d) throw new Error("give to (a room) or dir (a neighbouring cell's direction).");
    const [dx, dy, dz] = DIRS[d];
    o = b.cells.get(cellKey(a.area, a.x + dx, a.y + dy, a.z + dz));
    if (!o) throw new Error(`${nameOf(a)} has no room to its ${LONG[d]}.`);
  }
  if (a.id === o.id) throw new Error("an exit needs two different rooms.");
  if (!EXIT_TYPES.includes(type)) throw new Error(`exit type "${type}" is not one of ${EXIT_TYPES.join(", ")}.`);
  const da = adir !== undefined ? dirOf(adir) : undefined, db = bdir !== undefined ? dirOf(bdir) : undefined;
  if (adir !== undefined && !da) throw new Error(`adir "${adir}" is not a direction.`);
  if (bdir !== undefined && !db) throw new Error(`bdir "${bdir}" is not a direction.`);
  let e = b.doc.exits.find((x) => (x.a === a.id && x.b === o.id) || (x.a === o.id && x.b === a.id));
  const lines = [];
  if (e) {
    e.type = type; e.hidden = Boolean(hidden);
    const flip = e.a !== a.id;
    if (da) e[flip ? "bdir" : "adir"] = da;
    if (db) e[flip ? "adir" : "bdir"] = db;
    lines.push(`updated exit ${e.id} between ${nameOf(a)} and ${nameOf(o)}`);
  } else {
    e = { id: b.id("e"), a: a.id, b: o.id, type, hidden: Boolean(hidden), dir: "both" };
    if (a.area !== o.area || da || db) {
      const gen = exitDirFrom({ ...b.doc, exits: [] }, { a: a.id, b: o.id }, a, new Map([[a.id, a], [o.id, { ...o, area: a.area }]]));
      e.adir = da ?? gen ?? "e";
      e.bdir = db ?? OPPOSITE[e.adir];
    }
    b.doc.exits.push(e);
    lines.push(`joined ${nameOf(a)} ${exitDirFrom(b.doc, e, a, b.rooms)} ⇄ ${exitDirFrom(b.doc, e, o, b.rooms)} ${nameOf(o)}${type !== "open" ? ` [${type}]` : ""}${hidden ? " [hidden]" : ""}`);
  }
  // Each side must be free in its direction.
  for (const r of [a, o]) {
    const d = exitDirFrom(b.doc, e, r, b.rooms);
    const clash = b.sides(r).find((s) => s.e !== e && s.dir === d);
    if (clash) throw new Error(`${nameOf(r)} already has a ${LONG[d]} exit (${clash.e.id} to ${nameOf(clash.other)}). Give adir/bdir, or unlink that one first.`);
  }
  return b.done(lines);
}

/** Remove exits: by exit id, or by room and direction. */
export function unlink(doc, lnk, { exit, from, dir }) {
  const b = book(doc, lnk);
  let e;
  if (exit) {
    const s = String(exit);
    e = b.doc.exits.find((x) => x.id === s || lnk?.exits?.[x.id] === s);
    if (!e) throw new Error(`the map has no exit ${s}.`);
  } else {
    const r = b.room(from);
    const d = dirOf(dir);
    e = b.sides(r).find((x) => x.dir === d)?.e;
    if (!e) throw new Error(`${nameOf(r)} has no ${dir} exit.`);
  }
  b.doc.exits = b.doc.exits.filter((x) => x !== e);
  return b.done([`removed exit ${e.id} between ${nameOf(b.rooms.get(e.a))} and ${nameOf(b.rooms.get(e.b))}`]);
}

/** Add or change a jump edge (one per room per direction), or remove it. */
export function edge(doc, lnk, { from, dir, success, fail, hidden, remove }) {
  const b = book(doc, lnk);
  const r = b.room(from);
  const d = dirOf(dir);
  if (!PLANAR.includes(d)) throw new Error(`an edge leaves by a planar direction (${PLANAR.join(" ")}), not "${dir}".`);
  const g = b.doc.edges.find((x) => x.from === r.id && x.dir === d);
  if (remove) {
    if (!g) throw new Error(`${nameOf(r)} has no ${d} edge.`);
    b.doc.edges = b.doc.edges.filter((x) => x !== g);
    return b.done([`removed edge ${g.id}`]);
  }
  const s = success !== undefined ? b.room(success) : g ? b.rooms.get(g.success) : undefined;
  const f = fail !== undefined ? b.room(fail) : g ? b.rooms.get(g.fail) : undefined;
  if (!s || !f) throw new Error("a new edge needs success and fail rooms.");
  if (g) {
    Object.assign(g, { success: s.id, fail: f.id, ...(hidden !== undefined ? { hidden: Boolean(hidden) } : {}) });
    return b.done([`updated edge ${g.id}`]);
  }
  const n = { id: b.id("j"), from: r.id, dir: d, success: s.id, fail: f.id, hidden: Boolean(hidden) };
  b.doc.edges.push(n);
  return b.done([`added edge ${n.id}: jump ${d} from ${nameOf(r)}, success ${nameOf(s)}, fail ${nameOf(f)}`]);
}

// ---------------------------------------------------------------------------
// Elevators
// ---------------------------------------------------------------------------

/** An elevator by local id, MOO id of its carriage, or name. */
function findElevator(b, ref) {
  const s = String(ref ?? "");
  const v = b.doc.elevators.find((x) => x.id === s || b.link?.elevators?.[x.id] === s) ?? b.doc.elevators.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!v) throw new Error(`the map has no elevator ${s}. Its elevators: ${b.doc.elevators.map((x) => `${x.id} "${x.name}"`).join(", ") || "none"}.`);
  return v;
}
const RANGE = { door: [2, 120], travel: [1, 60] };
const seconds = (v, what) => {
  const [lo, hi] = RANGE[what];
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} is a whole number of seconds from ${lo} to ${hi}.`);
  return v;
};
function stopsOf(b, list) {
  if (!Array.isArray(list)) throw new Error("stops is a list of { label, room }, top floor first.");
  const out = [], rooms = new Set(), labels = new Set();
  for (const st of list) {
    const label = text(String(st?.label ?? "").trim(), LIMITS.label, "a stop's label");
    if (!label) throw new Error("every stop needs a label: the button players press, like 10, G or B2.");
    const r = b.room(st.room);
    if (rooms.has(r.id)) throw new Error(`${nameOf(r)} is a stop twice; a lobby has one stop per elevator.`);
    if (labels.has(label.toLowerCase())) throw new Error(`two stops are labelled "${label}"; labels pick the floor, so they must differ.`);
    rooms.add(r.id); labels.add(label.toLowerCase());
    out.push({ label, room: r.id });
  }
  if (out.length > LIMITS.stops) throw new Error(`at most ${LIMITS.stops} stops.`);
  return out;
}
const stopLine = (b, v) => v.stops.map((st) => `${st.label}=${nameOf(b.rooms.get(st.room))}`).join(", ") || "no stops";

/**
 * Make, change or remove an elevator. `stops` replaces the whole stop list (top floor first); `add` puts
 * stops in (at `at`, a 0-based position, else by the lobbies' floors), `drop` takes them out by room or label.
 */
export function elevator(doc, lnk, { elevator: ref, name, description, door, travel, stops, add, drop, remove }) {
  const b = book(doc, lnk);
  const lines = [];
  let v = ref !== undefined ? findElevator(b, ref) : undefined;
  if (remove) {
    if (!v) throw new Error("name the elevator to remove.");
    b.doc.elevators = b.doc.elevators.filter((x) => x !== v);
    return b.done([`removed elevator ${v.id} "${v.name}" (its carriage and every lobby's in exit go on publish)`]);
  }
  if (!v) {
    v = { id: b.id("v"), name: "Elevator", description: "", ...ELEVATOR_DEFAULTS, stops: [] };
    b.doc.elevators.push(v);
    lines.push(`made elevator ${v.id}`);
  }
  if (name !== undefined) v.name = text(String(name).trim() || "Elevator", LIMITS.name, "name");
  if (description !== undefined) v.description = descOf(description);
  if (door !== undefined) v.door = seconds(door, "door");
  if (travel !== undefined) v.travel = seconds(travel, "travel");
  if (stops !== undefined) v.stops = stopsOf(b, stops);
  for (const d of drop ?? []) {
    const s = typeof d === "string" && !d.startsWith("#") && !/^r\d+$/.test(d) ? v.stops.find((x) => x.label.toLowerCase() === d.toLowerCase()) : v.stops.find((x) => x.room === b.room(d).id);
    if (!s) throw new Error(`elevator ${v.id} has no stop ${typeof d === "object" ? JSON.stringify(d) : d}.`);
    v.stops = v.stops.filter((x) => x !== s);
  }
  for (const a of add ?? []) {
    const [st] = stopsOf(b, [a]);
    const merged = stopsOf(b, [...v.stops, st]); // checks duplicates against the rest
    if (Number.isInteger(a.at)) v.stops.splice(Math.max(0, Math.min(a.at, v.stops.length)), 0, st);
    else {
      // By floor: top (most negative z) first, so a new lobby lands where the shaft has it.
      const z = b.rooms.get(st.room).z;
      const i = v.stops.findIndex((x) => b.rooms.get(x.room).z > z);
      v.stops.splice(i < 0 ? v.stops.length : i, 0, st);
    }
    void merged;
  }
  if (name !== undefined || description !== undefined || door !== undefined || travel !== undefined || stops !== undefined || add || drop) lines.push(`elevator ${v.id} "${v.name}": door ${v.door}s, travel ${v.travel}s per floor; stops top first: ${stopLine(b, v)}`);
  if (v.stops.length === 1) lines.push("an elevator with one stop goes nowhere: add another.");
  const res = b.done(lines);
  res.elevator = v.id;
  return res;
}

/** One line per elevator. */
export function elevatorLines(doc, lnk) {
  const b = new Book(doc, lnk);
  return b.doc.elevators.map((v) => `${v.id}${lnk?.elevators?.[v.id] ? ` ${lnk.elevators[v.id]}` : ""} "${v.name}"  door ${v.door}s · travel ${v.travel}s/floor  stops (top first): ${stopLine(b, v)}`);
}

// ---------------------------------------------------------------------------
// Areas and blocks
// ---------------------------------------------------------------------------

export function areas(doc, lnk, { add = [], rename = {}, remove = [] }) {
  const b = book(doc, lnk);
  const lines = [];
  for (const a of add) {
    const name = text(String(typeof a === "string" ? a : a?.name ?? "").trim(), LIMITS.name, "area name");
    if (!name) throw new Error("a new area needs a name.");
    const n = { id: b.id("a"), name };
    b.doc.areas.push(n);
    lines.push(`added area ${n.id} "${name}"`);
  }
  b.reindex();
  for (const [ref, name] of Object.entries(rename)) {
    const a = b.area(ref);
    a.name = text(String(name).trim(), LIMITS.name, "area name");
    lines.push(`renamed area ${a.id} to "${a.name}"`);
  }
  for (const ref of remove) {
    const a = b.area(ref);
    const n = b.doc.rooms.filter((r) => r.area === a.id).length;
    if (n) throw new Error(`area ${a.id} "${a.name}" still has ${plural(n, "room")}: delete or move them first.`);
    if (b.doc.areas.length === 1) throw new Error("a map keeps at least one area.");
    b.doc.areas = b.doc.areas.filter((x) => x !== a);
    b.doc.blocks = b.doc.blocks.filter((x) => x.area !== a.id);
    lines.push(`removed area ${a.id} "${a.name}"`);
  }
  return b.done(lines);
}

export function blocks(doc, lnk, { add = [], remove = [] }) {
  const b = book(doc, lnk);
  const lines = [];
  for (const c of add) {
    const k = b.cell(c);
    const key = cellKey(k.area, k.x, k.y, k.z);
    if (b.cells.has(key)) throw new Error(`${at(k)} holds ${nameOf(b.cells.get(key))}; a room's cell cannot be blocked.`);
    if (!b.blocks.has(key)) { b.doc.blocks.push(k); b.blocks.add(key); lines.push(`blocked ${at(k)} in ${k.area}`); }
  }
  for (const c of remove) {
    const k = b.cell(c);
    const key = cellKey(k.area, k.x, k.y, k.z);
    const before = b.doc.blocks.length;
    b.doc.blocks = b.doc.blocks.filter((x) => cellKey(x.area, x.x, x.y, x.z) !== key);
    if (b.doc.blocks.length !== before) lines.push(`unblocked ${at(k)} in ${k.area}`);
  }
  return b.done(lines);
}

// ---------------------------------------------------------------------------
// Search and replace
// ---------------------------------------------------------------------------

export const TEXT_FIELDS = ["name", "description", "notes"];

function matcher(pattern, { regex = false, ignore_case = false } = {}) {
  if (typeof pattern !== "string" || !pattern) throw new Error("pattern must be a non-empty string.");
  const flags = "g" + (ignore_case ? "i" : "");
  try {
    return new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (e) {
    throw new Error(`pattern is not a valid regular expression: ${e.message}`);
  }
}

function scope(b, { rooms, area, z }) {
  let list = b.doc.rooms;
  if (rooms) { const ids = new Set(rooms.map((ref) => b.room(ref).id)); list = list.filter((r) => ids.has(r.id)); }
  if (area !== undefined) { const a = b.area(area).id; list = list.filter((r) => r.area === a); }
  if (z !== undefined) list = list.filter((r) => r.z === z);
  return list;
}

/** Every match of `pattern` in the rooms' text, with a little context, and area names. */
export function search(doc, lnk, { pattern, regex, ignore_case, fields = TEXT_FIELDS, rooms, area, z, limit = 200 }) {
  const b = new Book(doc, lnk);
  const re = matcher(pattern, { regex, ignore_case });
  const hits = [];
  for (const r of scope(b, { rooms, area, z })) {
    for (const f of fields) {
      const s = String(r[f] ?? "");
      for (const m of s.matchAll(re)) {
        const i = m.index;
        hits.push({ room: r.id, name: r.name, cell: at(r), field: f, match: m[0], context: (i > 30 ? "…" : "") + s.slice(Math.max(0, i - 30), i + m[0].length + 30).replace(/\n/g, "⏎") + (i + m[0].length + 30 < s.length ? "…" : "") });
        if (!m[0].length) break;
      }
    }
  }
  if (fields.includes("area")) for (const a of doc.areas) for (const m of a.name.matchAll(re)) { hits.push({ area: a.id, field: "area", match: m[0], context: a.name }); if (!m[0].length) break; }
  return { hits: hits.slice(0, limit), total: hits.length };
}

/** Replace `pattern` with `replacement` (JS replacement syntax: $1, $&) in the rooms' text. */
export function replace(doc, lnk, { pattern, replacement, regex, ignore_case, fields = TEXT_FIELDS, rooms, area, z }) {
  if (typeof replacement !== "string") throw new Error("replacement must be a string (empty to delete the match).");
  const b = book(doc, lnk);
  const re = matcher(pattern, { regex, ignore_case });
  const lines = [];
  let total = 0;
  for (const r of scope(b, { rooms, area, z })) {
    const changed = [];
    for (const f of fields) {
      if (!TEXT_FIELDS.includes(f)) continue;
      const s = String(r[f] ?? "");
      let n = 0;
      const out = s.replace(re, (...m) => { n++; return replacement.replace(/\$(\d+|&)/g, (_, g) => (g === "&" ? m[0] : m[Number(g)] ?? "")); });
      if (n && out !== s) {
        const max = f === "description" ? LIMITS.description : f === "notes" ? LIMITS.notes : LIMITS.name;
        r[f] = text(f === "name" ? out.trim() : out, max, `${r.id}'s ${f}`);
        changed.push(`${f}×${n}`);
        total += n;
      }
    }
    if (changed.length) lines.push(`${nameOf(r)}: ${changed.join(", ")}`);
  }
  if (fields.includes("area")) for (const a of b.doc.areas) { const out = a.name.replace(re, replacement); if (out !== a.name) { lines.push(`area ${a.id}: "${a.name}" → "${out}"`); a.name = out; total++; } }
  const res = b.done(lines);
  res.total = total;
  return res;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Rooms filtered by area, level, a bounding box and a name/description query. */
export function listRooms(doc, lnk, { area, z, query, box, rooms } = {}) {
  const b = new Book(doc, lnk);
  let list = scope(b, { rooms, area, z });
  if (box) list = list.filter((r) => (box.x0 === undefined || r.x >= box.x0) && (box.x1 === undefined || r.x <= box.x1) && (box.y0 === undefined || r.y >= box.y0) && (box.y1 === undefined || r.y <= box.y1));
  if (query) { const q = String(query).toLowerCase(); list = list.filter((r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.id === query); }
  return list.sort((p, q) => p.area.localeCompare(q.area) || p.z - q.z || p.y - q.y || p.x - q.x);
}

/** The exits of a room as one line each: "n ⇄ r3 "Hall"", with type and flags. */
export function exitLines(b, r) {
  const out = b.sides(r).map(({ e, other, dir, adjacent }) => {
    const flags = [e.type !== "open" ? e.type : "", e.hidden ? "hidden" : "", other.area !== r.area ? `into ${other.area}` : "", !adjacent && other.area === r.area ? "not adjacent" : ""].filter(Boolean);
    return `${dir ?? "?"} → ${nameOf(other)} ${at(other)} [${e.id}]${flags.length ? " " + flags.join(", ") : ""}`;
  });
  for (const g of b.doc.edges.filter((x) => x.from === r.id)) out.push(`edge ${g.dir} → success ${nameOf(b.rooms.get(g.success))}, fail ${nameOf(b.rooms.get(g.fail))} [${g.id}]${g.hidden ? " hidden" : ""}`);
  for (const g of b.doc.edges.filter((x) => x.from !== r.id && (x.success === r.id || x.fail === r.id))) out.push(`landing of edge ${g.id} from ${nameOf(b.rooms.get(g.from))}`);
  for (const v of b.doc.elevators) { const st = v.stops.find((x) => x.room === r.id); if (st) out.push(`in → elevator ${v.id} "${v.name}", stop ${st.label}`); }
  return out;
}

export { completeDoc, checkDoc, clone };
