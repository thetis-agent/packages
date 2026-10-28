// The map document, shared by the tools in the fence, the commands in the gateway and the tab in the
// browser. Pure: no DOM, no Node, so the same rules run in all three and under node:test.
//
// A document is the website cartographer's mudmap v4 (torchsite src/mapper/engine.js exportJSON) plus
// `nextId`, so a deleted local id is never handed out again while its MOO link might still be remembered:
//
//   { format: "mudmap", version: 4, name, nextId,
//     areas:  [{ id, name }],
//     rooms:  [{ id, area, x, y, z, name, color, description, notes }],
//     exits:  [{ id, a, b, type, hidden, dir: "both"|"ab"|"ba", adir?, bdir? }],
//     edges:  [{ id, from, dir, success, fail, hidden }],
//     blocks: [{ area, x, y, z }],
//     elevators: [{ id, name, description, door, travel, stops: [{ label, room }] }] }
//
// An elevator is one carriage room that lives off the grid, and its stops in shaft order, top first: each
// a button label ("10", "G", "B2") and the lobby room on this map whose `in` exit opens on it. Lobbies may be
// in any area. door is how long the doors stay open (seconds), travel the time per floor.
//
// Coordinates are Torchship's: x grows east, y grows SOUTH, z grows DOWN (0 is ground, up is negative).
// One room per cell per area. Local ids are a<n>, r<n>, e<n>, j<n>, v<n> (elevators).

export const PLANAR = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const PLANAR_STEP = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
const PLANAR_LONG = { n: "north", ne: "northeast", e: "east", se: "southeast", s: "south", sw: "southwest", w: "west", nw: "northwest" };
const PLANAR_OPP = { n: "s", s: "n", e: "w", w: "e", ne: "sw", sw: "ne", nw: "se", se: "nw" };
// The sixteen vertical diagonals, Torchship's $building_utils.cardinals 13..28: <planar><u|d>, e.g. nu
// "northup" is one floor up and one cell north; its twin is sd "southdown".
export const VERTICAL_DIAGONALS = PLANAR.flatMap((p) => [p + "u", p + "d"]);
/** Every direction: code -> [dx, dy, dz]. x grows east, y south, z DOWN (up is -1). */
export const DIRS = {
  ...Object.fromEntries(PLANAR.map((p) => [p, [...PLANAR_STEP[p], 0]])),
  up: [0, 0, -1], down: [0, 0, 1],
  ...Object.fromEntries(PLANAR.flatMap((p) => [[p + "u", [...PLANAR_STEP[p], -1]], [p + "d", [...PLANAR_STEP[p], 1]]])),
};
export const OPPOSITE = {
  ...PLANAR_OPP, up: "down", down: "up",
  ...Object.fromEntries(PLANAR.flatMap((p) => [[p + "u", PLANAR_OPP[p] + "d"], [p + "d", PLANAR_OPP[p] + "u"]])),
};
/** What a MOO exit's .direction holds for each code. */
export const LONG = {
  ...PLANAR_LONG, up: "up", down: "down",
  ...Object.fromEntries(PLANAR.flatMap((p) => [[p + "u", PLANAR_LONG[p] + "up"], [p + "d", PLANAR_LONG[p] + "down"]])),
};
export const EXIT_TYPES = ["open", "door", "locked", "climb", "swim", "special"];
export const ROOM_COLORS = ["#2a3140", "#4a3038", "#4a4028", "#2c4436", "#283a4a", "#3c3050", "#233"];
export const DEFAULT_COLOR = ROOM_COLORS[0];

export const LIMITS = { rooms: 5000, exits: 20000, edges: 2000, blocks: 20000, areas: 200, name: 200, description: 20000, notes: 4000, elevators: 200, stops: 100, label: 16 };
export const ELEVATOR_DEFAULTS = { door: 8, travel: 3 };

// Every spelling $building_utils.cardinals accepts, ship words included, so an exit dug as `fore` reads as n.
const SPELLINGS = {
  n: ["n", "north", "fore"], s: ["s", "south", "aft"], e: ["e", "east", "starboard", "star"], w: ["w", "west", "port"],
  ne: ["ne", "northeast", "northe"], nw: ["nw", "northwest", "northw"], se: ["se", "southeast", "southe"], sw: ["sw", "southwest", "southw"],
  up: ["up", "u"], down: ["down", "d"],
  ...Object.fromEntries(VERTICAL_DIAGONALS.map((c) => [c, [c, LONG[c], LONG[c].replace(/(up|down)$/, " $1"), `${c.endsWith("u") ? "up" : "down"} ${PLANAR_LONG[c.slice(0, -1)]}`, `${c.endsWith("u") ? "up" : "down"}${PLANAR_LONG[c.slice(0, -1)]}`, `${c.endsWith("u") ? "up" : "down"} ${c.slice(0, -1)}`]])),
};
const BY_SPELLING = Object.fromEntries(Object.entries(SPELLINGS).flatMap(([k, list]) => list.map((s) => [s, k])));
/** The short compass code for any spelling ("north", "N", "fore"), or undefined. */
export const dirOf = (v) => BY_SPELLING[String(v ?? "").trim().toLowerCase()];

export const cellKey = (area, x, y, z) => `${area}:${x},${y},${z}`;
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const str = (v, max) => String(v ?? "").slice(0, max);
const asArr = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);

/** The direction from room a to room b when b is a's grid neighbour in the same area, else undefined. */
export function stepDir(a, b) {
  if (!a || !b || a.area !== b.area) return undefined;
  for (const [d, [dx, dy, dz]] of Object.entries(DIRS)) if (a.x + dx === b.x && a.y + dy === b.y && a.z + dz === b.z) return d;
  return undefined;
}

/** The direction exit `e` leaves room `r` by, as the editor draws it; undefined when it has none. */
export function exitDirFrom(doc, e, r, byId) {
  const rooms = byId ?? new Map(doc.rooms.map((x) => [x.id, x]));
  const o = rooms.get(e.a === r.id ? e.b : e.a);
  if (!o) return undefined;
  if (o.area === r.area) {
    const s = stepDir(r, o);
    if (s) return s;
    const dx = Math.sign(o.x - r.x), dy = Math.sign(o.y - r.y), dz = Math.sign(o.z - r.z);
    return Object.keys(DIRS).find((d) => DIRS[d][0] === dx && DIRS[d][1] === dy && DIRS[d][2] === dz);
  }
  return e.a === r.id ? e.adir || "e" : e.bdir || OPPOSITE[e.adir || "e"];
}

/** The highest number used by any local id, plus one, never below `doc.nextId`. */
export function nextIdOf(doc) {
  let max = 0;
  for (const list of [doc.areas, doc.rooms, doc.exits, doc.edges, doc.elevators]) {
    for (const o of list ?? []) {
      const m = /^[arejv](\d+)$/.exec(String(o.id));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return Math.max(max + 1, Number.isInteger(doc.nextId) ? doc.nextId : 1);
}

/**
 * Any mudmap-shaped value made into a complete, consistent document: unknown fields dropped, defaults
 * filled, dangling references and second occupants of a cell dropped, the way the editor's parseImport
 * reads a file. Never throws; `checkDoc` is the strict gate for writes.
 */
export function completeDoc(d) {
  const src = d && typeof d === "object" ? d : {};
  const doc = { format: "mudmap", version: 4, name: str(src.name || "Untitled map", LIMITS.name), nextId: 1, areas: [], rooms: [], exits: [], edges: [], blocks: [], elevators: [] };
  const areas = new Set();
  for (const a of asArr(src.areas)) {
    const id = str(a?.id, 64);
    if (!id || areas.has(id)) continue;
    areas.add(id);
    doc.areas.push({ id, name: str(a.name || "Area", LIMITS.name) });
  }
  const cells = new Set();
  const rooms = new Set();
  for (const r of asArr(src.rooms)) {
    const id = str(r?.id, 64);
    const [x, y, z] = [int(r?.x), int(r?.y), int(r?.z ?? 0)];
    if (!id || rooms.has(id) || ![x, y, z].every(Number.isFinite)) continue;
    let area = str(r.area, 64);
    if (!areas.has(area)) {
      if (!doc.areas.length) {
        doc.areas.push({ id: "a1", name: "Main" });
        areas.add("a1");
      }
      area = doc.areas[0].id;
    }
    const k = cellKey(area, x, y, z);
    if (cells.has(k)) continue;
    cells.add(k);
    rooms.add(id);
    doc.rooms.push({ id, area, x, y, z, name: str(r.name, LIMITS.name), color: typeof r.color === "string" && r.color ? r.color.slice(0, 32) : DEFAULT_COLOR, description: str(r.description, LIMITS.description), notes: str(r.notes, LIMITS.notes) });
  }
  const byId = new Map(doc.rooms.map((r) => [r.id, r]));
  const exitIds = new Set();
  const pairs = new Set();
  for (const e of asArr(src.exits)) {
    const id = str(e?.id, 64), a = str(e?.a, 64), b = str(e?.b, 64);
    if (!id || exitIds.has(id) || !byId.has(a) || !byId.has(b) || a === b) continue;
    const pair = [a, b].sort().join("|");
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    exitIds.add(id);
    const ex = { id, a, b, type: EXIT_TYPES.includes(e.type) ? e.type : "open", hidden: Boolean(e.hidden), dir: ["both", "ab", "ba"].includes(e.dir) ? e.dir : "both" };
    if (byId.get(a).area !== byId.get(b).area) {
      ex.adir = DIRS[e.adir] ? e.adir : "e";
      ex.bdir = DIRS[e.bdir] ? e.bdir : OPPOSITE[ex.adir];
    } else {
      if (DIRS[e.adir]) ex.adir = e.adir;
      if (DIRS[e.bdir]) ex.bdir = e.bdir;
    }
    doc.exits.push(ex);
  }
  const edgeIds = new Set();
  for (const g of asArr(src.edges)) {
    const id = str(g?.id, 64), from = str(g?.from, 64), success = str(g?.success, 64), fail = str(g?.fail, 64);
    if (!id || edgeIds.has(id) || !byId.has(from) || !byId.has(success) || !byId.has(fail)) continue;
    edgeIds.add(id);
    doc.edges.push({ id, from, dir: PLANAR.includes(g.dir) ? g.dir : "n", success, fail, hidden: Boolean(g.hidden) });
  }
  const blocks = new Set();
  for (const b of asArr(src.blocks)) {
    const [x, y, z] = [int(b?.x), int(b?.y), int(b?.z ?? 0)];
    const area = str(b?.area, 64);
    if (!areas.has(area) || ![x, y, z].every(Number.isFinite)) continue;
    const k = cellKey(area, x, y, z);
    if (cells.has(k) || blocks.has(k)) continue;
    blocks.add(k);
    doc.blocks.push({ area, x, y, z });
  }
  const elevIds = new Set();
  for (const v of asArr(src.elevators)) {
    const id = str(v?.id, 64);
    if (!id || elevIds.has(id)) continue;
    elevIds.add(id);
    doc.elevators.push(completeElevator(v, id, byId));
  }
  if (!doc.areas.length) doc.areas.push({ id: "a1", name: "Main" });
  doc.nextId = Math.max(nextIdOf(doc), int(src.nextId) || 1);
  return doc;
}

const secs = (v, d) => { const n = int(v); return Number.isFinite(n) && n >= 1 && n <= 600 ? n : d; };
/** An elevator made whole: stops on rooms the map has, each lobby once, labels trimmed and unique. */
function completeElevator(v, id, byId) {
  const stops = [];
  const rooms = new Set(), labels = new Set();
  for (const st of asArr(v?.stops)) {
    const room = str(st?.room, 64), label = str(st?.label, LIMITS.label).trim();
    if (!byId.has(room) || rooms.has(room) || !label || labels.has(label.toLowerCase())) continue;
    rooms.add(room); labels.add(label.toLowerCase());
    stops.push({ label, room });
  }
  return { id, name: str(v?.name || "Elevator", LIMITS.name), description: str(v?.description, LIMITS.description), door: secs(v?.door, ELEVATOR_DEFAULTS.door), travel: secs(v?.travel, ELEVATOR_DEFAULTS.travel), stops };
}

/** The elevators with a stop in this room, each with that stop. */
export function elevatorsAt(doc, roomId) {
  const out = [];
  for (const v of doc.elevators ?? []) { const st = v.stops.find((s) => s.room === roomId); if (st) out.push({ elevator: v, stop: st }); }
  return out;
}

/** The problems that make a document unfit to write, as sentences. Empty when it is fine. */
export function checkDoc(doc) {
  const out = [];
  if (doc.rooms.length > LIMITS.rooms) out.push(`${doc.rooms.length} rooms; at most ${LIMITS.rooms} in one map.`);
  if (doc.exits.length > LIMITS.exits) out.push(`${doc.exits.length} exits; at most ${LIMITS.exits}.`);
  if (doc.areas.length > LIMITS.areas) out.push(`${doc.areas.length} areas; at most ${LIMITS.areas}.`);
  const areas = new Set(doc.areas.map((a) => a.id));
  const cells = new Map();
  for (const r of doc.rooms) {
    if (!areas.has(r.area)) out.push(`room ${r.id} is in area ${r.area}, which the map does not have.`);
    const k = cellKey(r.area, r.x, r.y, r.z);
    if (cells.has(k)) out.push(`rooms ${cells.get(k)} and ${r.id} are both at (${r.x},${r.y},${r.z}) in ${r.area}.`);
    cells.set(k, r.id);
  }
  for (const b of doc.blocks) if (cells.has(cellKey(b.area, b.x, b.y, b.z))) out.push(`(${b.x},${b.y},${b.z}) in ${b.area} is both blocked and a room.`);
  if ((doc.elevators?.length ?? 0) > LIMITS.elevators) out.push(`${doc.elevators.length} elevators; at most ${LIMITS.elevators}.`);
  const rooms = new Set(doc.rooms.map((r) => r.id));
  for (const v of doc.elevators ?? []) {
    if (v.stops.length > LIMITS.stops) out.push(`elevator ${v.id} has ${v.stops.length} stops; at most ${LIMITS.stops}.`);
    const seen = new Set(), labels = new Set();
    for (const st of v.stops) {
      if (!rooms.has(st.room)) out.push(`elevator ${v.id} stops at room ${st.room}, which the map does not have.`);
      if (seen.has(st.room)) out.push(`elevator ${v.id} stops at room ${st.room} twice.`);
      if (!st.label) out.push(`elevator ${v.id} has a stop with no label.`);
      if (labels.has(st.label.toLowerCase())) out.push(`elevator ${v.id} has two stops labelled "${st.label}".`);
      seen.add(st.room); labels.add(st.label.toLowerCase());
    }
  }
  return out;
}

// ---- patches: what one writer changed, applied on top of what another wrote ----

const COLLECTIONS = ["areas", "rooms", "exits", "edges", "elevators"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const blockKey = (b) => cellKey(b.area, b.x, b.y, b.z);

/**
 * The element-level difference from `base` to `next`: per collection the elements added or changed
 * (`put`) and the ids removed (`del`), the blocks added and removed, and the name. Two writers' patches
 * against the same base touch different elements far more often than the same one, so applying one on
 * top of the other keeps both.
 */
export function diffDocs(base, next, { ignore = [] } = {}) {
  const patch = {};
  if (base.name !== next.name) patch.name = next.name;
  const strip = ignore.length ? (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !ignore.includes(k))) : o) : (o) => o;
  for (const c of COLLECTIONS) {
    const before = new Map((base[c] ?? []).map((o) => [o.id, o]));
    const after = new Map((next[c] ?? []).map((o) => [o.id, o]));
    const add = [...after.values()].filter((o) => !before.has(o.id));
    const put = [...after.values()].filter((o) => before.has(o.id) && !same(strip(before.get(o.id)), strip(o)));
    const del = [...before.keys()].filter((id) => !after.has(id));
    if (add.length || put.length || del.length) patch[c] = { add, put, del };
  }
  const bb = new Set(base.blocks.map(blockKey)), nb = new Set(next.blocks.map(blockKey));
  const add = next.blocks.filter((b) => !bb.has(blockKey(b)));
  const del = base.blocks.filter((b) => !nb.has(blockKey(b)));
  if (add.length || del.length) patch.blocks = { add, del };
  if (Number.isInteger(next.nextId) && next.nextId > base.nextId) patch.nextId = next.nextId;
  return patch;
}

export const isEmptyPatch = (p) => !p || Object.keys(p).filter((k) => k !== "nextId").length === 0;

/**
 * `patch` applied to `doc`, completed. A room put onto a cell another room now holds displaces nothing:
 * the later writer's room is dropped by completeDoc, and `conflicts` says so. With `renumber`, an element
 * the patch adds under an id the document already has is taken as a second writer's and given a new id.
 */
export function applyPatch(doc, patchIn, { renumber = false } = {}) {
  if (!renumber) return applyPatchAs(doc, patchIn);
  const { patch, renumbered } = renumberAdds(doc, patchIn);
  const res = applyPatchAs(doc, patch);
  if (renumbered.length) res.renumbered = renumbered;
  return res;
}

/**
 * Two writers on the same revision hand out the same next ids. An element the patch adds under an id the
 * document already holds is the other writer's, not this one's: the added one gets a fresh id, and every
 * reference to it inside the patch follows.
 */
function renumberAdds(doc, patch) {
  const PREFIX = { areas: "a", rooms: "r", exits: "e", edges: "j", elevators: "v" };
  let next = Math.max(nextIdOf(doc), Number.isInteger(patch.nextId) ? patch.nextId : 0);
  const map = {};
  const renumbered = [];
  for (const c of COLLECTIONS) {
    const have = new Set((doc[c] ?? []).map((o) => o.id));
    for (const o of patch[c]?.add ?? []) {
      if (!have.has(o.id)) continue;
      const id = `${PREFIX[c]}${next++}`;
      map[`${c}:${o.id}`] = id;
      renumbered.push(`${o.id}→${id}`);
    }
  }
  if (!renumbered.length) return { patch, renumbered };
  const ref = (c, id) => map[`${c}:${id}`] ?? id;
  const out = { ...patch, nextId: next };
  for (const c of COLLECTIONS) {
    if (!patch[c]) continue;
    const fix = (o) => {
      const n = { ...o };
      if (c === "rooms") n.area = ref("areas", o.area);
      if (c === "exits") { n.a = ref("rooms", o.a); n.b = ref("rooms", o.b); }
      if (c === "edges") { n.from = ref("rooms", o.from); n.success = ref("rooms", o.success); n.fail = ref("rooms", o.fail); }
      if (c === "elevators") n.stops = (o.stops ?? []).map((st) => ({ ...st, room: ref("rooms", st.room) }));
      return n;
    };
    out[c] = { add: (patch[c].add ?? []).map((o) => ({ ...fix(o), id: ref(c, o.id) })), put: (patch[c].put ?? []).map(fix), del: patch[c].del ?? [] };
  }
  if (patch.blocks) out.blocks = { add: (patch.blocks.add ?? []).map((b) => ({ ...b, area: ref("areas", b.area) })), del: patch.blocks.del ?? [] };
  return { patch: out, renumbered };
}

function applyPatchAs(doc, patch) {
  const out = { ...doc };
  if (typeof patch.name === "string") out.name = patch.name;
  for (const c of COLLECTIONS) {
    const p = patch[c];
    if (!p) continue;
    const del = new Set(p.del ?? []);
    const put = new Map([...(p.add ?? []), ...(p.put ?? [])].map((o) => [o.id, o]));
    const list = (doc[c] ?? []).filter((o) => !del.has(o.id)).map((o) => (put.has(o.id) ? put.get(o.id) : o));
    for (const [id, o] of put) if (!(doc[c] ?? []).some((x) => x.id === id) && !del.has(id)) list.push(o);
    out[c] = list;
  }
  if (patch.blocks) {
    const del = new Set((patch.blocks.del ?? []).map(blockKey));
    const list = doc.blocks.filter((b) => !del.has(blockKey(b)));
    const have = new Set(list.map(blockKey));
    for (const b of patch.blocks.add ?? []) if (!have.has(blockKey(b))) list.push(b);
    out.blocks = list;
  }
  if (Number.isInteger(patch.nextId)) out.nextId = Math.max(doc.nextId ?? 1, patch.nextId);
  const done = completeDoc(out);
  const conflicts = [];
  const kept = new Set(done.rooms.map((r) => r.id));
  for (const r of [...(patch.rooms?.add ?? []), ...(patch.rooms?.put ?? [])]) if (!kept.has(r.id)) conflicts.push(`room ${r.id} "${r.name}" could not be placed at (${r.x},${r.y},${r.z}): the cell is taken.`);
  return { doc: done, conflicts };
}

/** Counts for a list row. */
export function countsOf(doc) {
  return { areas: doc.areas.length, rooms: doc.rooms.length, exits: doc.exits.length, edges: doc.edges.length, blocks: doc.blocks.length, elevators: doc.elevators?.length ?? 0 };
}
