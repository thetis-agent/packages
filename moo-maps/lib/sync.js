// The link between a map and the world, in both directions. Pure: the MOO is reached in lib/moo.js and
// the tools only glue the two, so every rule here is tested without a server.
//
// `project` reads a live snapshot of the map's linked areas into map space: every room, exit and edge the
// link knows gets its local id, and what the link does not know is "foreign" -- something made in the
// world (by @dig, the website, another map) since this map last looked. Publish compares the map with that
// projection and plans the ops that make the world match; pull merges the projection into the map.
//
// The rules that keep a publish safe:
//   - Only the map's own linked areas are touched. Exits that leave them are never touched (`external`).
//   - Something foreign is never deleted by a publish: it is reported, and map_pull brings it in.
//   - Something the map knew (it is in the link) and no longer has is deleted.
//   - A map element linked to an object that is gone from the world is made again.
//   - Colour and notes are the map's own; the MOO does not keep them.
//   - An exit whose side is named something other than a compass word (in, out, a custom name) keeps it.

import { DIRS, OPPOSITE, LONG, applyPatch, completeDoc, diffDocs, dirOf, exitDirFrom, cellKey, DEFAULT_COLOR } from "../ui/core/doc.js";

const invert = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const pairKey = (x, y) => [String(x), String(y)].sort().join("|");
const joinDesc = (d) => (Array.isArray(d) ? d.map(String).join("\n") : String(d ?? ""));
/** The type as the MOO can tell it apart: a lockless door reads back as door, a special exit as open. */
const liveType = (t) => (t === "locked" ? "door" : t === "special" ? "open" : t);

/**
 * The snapshot in map space. Answers:
 *   remote   a document of what the world holds that the link knows (local ids)
 *   foreign  { rooms: [...], exits: [...], edges: [...] } in the world, unknown to the link
 *   external [{ room, moo, dir, to, to_name, to_area, to_area_name }] exits leaving the map's areas
 *   gone     { areas: [local ids] } linked areas that no longer exist
 *   live     { rooms: Map(moo id -> live room), exitsByPair: Map(pairKey -> live pair) }
 * With `adopt` (pull), foreign things get fresh local ids from `alloc(prefix)` and join `remote`, and
 * `link` comes back with them added.
 */
export function project(snap, linkIn, { adopt = false, alloc, keep } = {}) {
  const link = { areas: { ...linkIn.areas }, rooms: { ...linkIn.rooms }, exits: { ...linkIn.exits }, edges: { ...linkIn.edges }, elevators: { ...(linkIn.elevators ?? {}) } };
  const rev = { areas: invert(link.areas), rooms: invert(link.rooms), exits: invert(link.exits), edges: invert(link.edges), elevators: invert(link.elevators) };
  const remote = { name: keep?.name ?? "", areas: [], rooms: [], exits: [], edges: [], blocks: [], elevators: [] };
  const foreign = { rooms: [], exits: [], edges: [], elevators: [] };
  const external = [];
  const gone = { areas: [], elevators: [] };
  const liveRooms = new Map(); // moo id -> { room, area local id, local id or null }
  const keepRoom = new Map((keep?.rooms ?? []).map((r) => [r.id, r]));

  for (const a of snap.areas ?? []) {
    const local = rev.areas[a.id];
    if (a.missing) {
      if (local) gone.areas.push(local);
      continue;
    }
    if (!local) continue; // asked about but not linked: not this map's
    remote.areas.push({ id: local, name: String(a.name ?? "") });
    const cells = new Set();
    for (const r of a.rooms ?? []) {
      const k = cellKey(local, r.x, r.y, r.z);
      let id = rev.rooms[r.id] ?? null;
      const dup = cells.has(k);
      cells.add(k);
      if (!id && adopt && !dup) {
        id = alloc("r");
        link.rooms[id] = r.id;
        rev.rooms[r.id] = id;
      }
      liveRooms.set(r.id, { room: r, area: local, id: dup && !rev.rooms[r.id] ? null : id });
      if (!id || (dup && !linkIn.rooms[id])) {
        foreign.rooms.push({ moo: r.id, area: local, x: r.x, y: r.y, z: r.z, name: r.name, players: r.players, ...(dup ? { duplicateCell: true } : {}) });
        continue;
      }
      const k0 = keepRoom.get(id);
      remote.rooms.push({ id, area: local, x: r.x, y: r.y, z: r.z, name: String(r.name ?? ""), color: k0?.color ?? DEFAULT_COLOR, description: joinDesc(r.description), notes: k0?.notes ?? "", players: r.players ?? 0 });
    }
    for (const b of Array.isArray(a.blocks) ? a.blocks : []) {
      if (Array.isArray(b) && b.length === 3) remote.blocks.push({ area: local, x: b[0], y: b[1], z: b[2] });
    }
  }

  // Exits: one per twinned pair, seen from either side.
  const seen = new Set();
  const exitsByPair = new Map();
  for (const [mooId, lr] of liveRooms) {
    for (const e of lr.room.exits ?? []) {
      const far = liveRooms.get(e.to);
      if (!far) {
        external.push({ room: lr.id, moo: mooId, exit: e.id, dir: e.dir, to: e.to, to_name: e.to_name, to_area: e.to_area, to_area_name: e.to_area_name, type: e.type, broken: e.to === "#-1" });
        continue;
      }
      const pk = pairKey(e.id, e.twin);
      if (seen.has(pk)) continue;
      seen.add(pk);
      const twin = (far.room.exits ?? []).find((x) => x.id === e.twin);
      const known = rev.exits[e.id] ?? rev.exits[e.twin] ?? null;
      // Orient the pair the way the map has it when the map knows it, else from this side.
      let sideA = { lr, e }, sideB = { lr: far, e: twin ?? { dir: "", hidden: 0 } };
      const live = { pair: pk, ids: [e.id, e.twin], rooms: [mooId, e.to] };
      exitsByPair.set(pairKey(mooId, e.to), live);
      let id = known;
      if (!id && adopt && lr.id && far.id) {
        id = alloc("e");
        link.exits[id] = e.id;
      }
      if (!id || !lr.id || !far.id) {
        foreign.exits.push({ moo: e.id, a: lr.id ?? mooId, b: far.id ?? e.to, dir: e.dir, type: e.type });
        continue;
      }
      live.id = id;
      const ex = {
        id, a: sideA.lr.id, b: sideB.lr.id, type: e.type, hidden: Boolean(e.hidden || twin?.hidden), dir: "both",
        adir: dirOf(sideA.e.dir) ?? null, bdir: dirOf(sideB.e.dir) ?? null,
        names: [sideA.e.dir, sideB.e.dir],
      };
      remote.exits.push(ex);
    }
    for (const g of lr.room.edges ?? []) {
      const s = liveRooms.get(g.success), f = liveRooms.get(g.fail);
      let id = rev.edges[g.id] ?? null;
      if (!id && adopt && lr.id && s?.id && f?.id) {
        id = alloc("j");
        link.edges[id] = g.id;
      }
      if (!id || !lr.id || !s?.id || !f?.id) {
        foreign.edges.push({ moo: g.id, from: lr.id ?? mooId, dir: g.dir, success: s?.id ?? g.success, fail: f?.id ?? g.fail });
        continue;
      }
      remote.edges.push({ id, from: lr.id, dir: DIRS[g.dir] && !DIRS[g.dir][2] ? g.dir : "n", success: s.id, fail: f.id, hidden: Boolean(g.hidden) });
    }
  }
  // Elevators: carriages the link knows or that a lobby here opens on.
  const elevatorApi = Boolean(snap.elevator_api);
  for (const moo of snap.carriages_gone ?? []) if (rev.elevators[moo]) gone.elevators.push(rev.elevators[moo]);
  for (const c of snap.elevators ?? []) {
    let id = rev.elevators[c.id] ?? null;
    if (c.error) {
      if (id) remote.elevators.push({ id, unreadable: c.error, name: "", description: "", door: 0, travel: 0, stops: [] });
      continue;
    }
    const stops = (c.stops ?? []).map(([label, moo]) => ({ label: String(label), room: liveRooms.get(moo)?.id ?? null, moo }));
    if (!id && adopt && stops.length && stops.every((x) => x.room)) {
      id = alloc("v");
      link.elevators[id] = c.id;
    }
    if (!id) { foreign.elevators.push({ moo: c.id, name: c.name, stops: stops.map((x) => `${x.label}=${x.room ?? x.moo}`) }); continue; }
    const outside = stops.filter((x) => !x.room);
    remote.elevators.push({ id, name: String(c.name ?? ""), description: joinDesc(c.description), door: c.door, travel: c.travel, stops: stops.filter((x) => x.room).map(({ label, room }) => ({ label, room })), ...(outside.length ? { outside: outside.map((x) => ({ label: x.label, moo: x.moo })) } : {}) });
  }
  return { remote, foreign, external, gone, link, elevatorApi, live: { rooms: liveRooms, exitsByPair } };
}

/** A projection made into a plain mudmap document (for `link.published` and for pull). */
export function remoteDoc(proj, keep) {
  const rooms = new Map(proj.remote.rooms.map((r) => [r.id, r]));
  const mine = new Map((keep?.exits ?? []).map((e) => [e.id, e]));
  const exits = proj.remote.exits.map(({ names, ...x }) => {
    let e = { ...x };
    const k = mine.get(e.id);
    // The map's orientation, so a/b and adir/bdir compare like for like.
    if (k && k.a === e.b && k.b === e.a) e = { ...e, a: e.b, b: e.a, adir: e.bdir, bdir: e.adir };
    // A finer type the MOO cannot tell apart (locked reads back as door, special as open) stays the map's.
    if (k && liveType(k.type) === liveType(e.type)) e.type = k.type;
    if (k) e.dir = k.dir;
    const ra = rooms.get(e.a), rb = rooms.get(e.b);
    if (ra && rb && ra.area === rb.area) {
      // Same area: the map draws the direction from the grid and ignores adir/bdir, so carry the map's
      // own (usually none) rather than report a difference nobody can see.
      if (k?.adir) e.adir = k.adir; else delete e.adir;
      if (k?.bdir) e.bdir = k.bdir; else delete e.bdir;
    }
    if (!e.adir) delete e.adir;
    if (!e.bdir) delete e.bdir;
    return e;
  });
  const elevators = proj.remote.elevators.filter((v) => !v.unreadable);
  const doc = completeDoc({ ...proj.remote, name: keep?.name ?? proj.remote.name, exits, elevators, nextId: keep?.nextId ?? 1 });
  return doc;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const PHASES = ["areas", "removals", "moves", "rooms", "joins", "elevators"];

/**
 * What publishing `doc` does to the world, given the projection of the world and the link. Answers
 * `{ phases: { areas, removals, moves, rooms, joins }, adopt, notes, counts }`. Ops name map things by
 * local id in `ref` fields ({ area: "a1" }) that the runner resolves to MOO ids phase by phase, since a
 * room made in one phase is joined in the next.
 */
export function planPublish(doc, proj, link, base) {
  const phases = Object.fromEntries(PHASES.map((p) => [p, []]));
  const notes = [];
  const adopt = { rooms: {}, exits: {} };
  const remote = proj.remote;
  const R = {
    areas: new Map(remote.areas.map((a) => [a.id, a])),
    rooms: new Map(remote.rooms.map((r) => [r.id, r])),
    exits: new Map(remote.exits.map((e) => [e.id, e])),
    edges: new Map(remote.edges.map((g) => [g.id, g])),
  };
  const D = {
    areas: new Map(doc.areas.map((a) => [a.id, a])),
    rooms: new Map(doc.rooms.map((r) => [r.id, r])),
    exits: new Map(doc.exits.map((e) => [e.id, e])),
    edges: new Map(doc.edges.map((g) => [g.id, g])),
  };
  const goneAreas = new Set(proj.gone.areas);

  // Areas: made when unlinked or gone; renamed when the name differs. An area dropped from the map is
  // unlinked, never recycled: a MOO area can hold far more than this map drew.
  for (const a of doc.areas) {
    if (!link.areas[a.id] || goneAreas.has(a.id)) {
      if (goneAreas.has(a.id)) notes.push(`area ${a.id} "${a.name}" was linked to ${link.areas[a.id]}, which no longer exists; a new area is made.`);
      phases.areas.push({ op: "area_create", name: a.name, local: a.id });
    } else if (R.areas.get(a.id) && R.areas.get(a.id).name !== a.name) {
      phases.areas.push({ op: "area_rename", ref: { area: a.id }, name: a.name, local: a.id });
    }
  }
  for (const local of Object.keys(link.areas)) {
    if (!D.areas.has(local)) notes.push(`area ${local} (${link.areas[local]}) is no longer on the map: it is unlinked and left as it is in the world, with whatever rooms the map did not delete.`);
  }

  // Foreign rooms sitting on a cell the map has an unlinked room for are adopted rather than collided with.
  const foreignAt = new Map(proj.foreign.rooms.filter((f) => !f.duplicateCell).map((f) => [cellKey(f.area, f.x, f.y, f.z), f]));

  // Rooms.
  const deleting = new Set();
  for (const [id, r] of R.rooms) {
    if (!D.rooms.has(id)) {
      deleting.add(id);
      phases.removals.push({ op: "room_delete", ref: { room: id }, local: id, name: r.name, players: r.players });
      if (r.players) notes.push(`room ${id} "${r.name}" has ${r.players} player${r.players === 1 ? "" : "s"} in it; deleting it is refused unless publish runs with force.`);
    }
  }
  for (const r of doc.rooms) {
    const live = R.rooms.get(r.id);
    if (!live) {
      const f = foreignAt.get(cellKey(r.area, r.x, r.y, r.z));
      if (f && link.areas[r.area] && !goneAreas.has(r.area)) {
        adopt.rooms[r.id] = f.moo;
        notes.push(`room ${r.id} "${r.name}" takes over ${f.moo} "${f.name}", already in the world at (${r.x},${r.y},${r.z}).`);
        const upd = { op: "room_update", ref: { room: r.id }, local: r.id };
        if (f.name !== r.name) upd.name = r.name;
        upd.description = r.description;
        phases.rooms.push(upd);
        continue;
      }
      if (link.rooms[r.id]) notes.push(`room ${r.id} "${r.name}" was linked to ${link.rooms[r.id]}, which is gone from the world; it is made again.`);
      phases.rooms.push({ op: "room_create", ref: { area: r.area }, local: r.id, x: r.x, y: r.y, z: r.z, name: r.name, description: r.description });
      continue;
    }
    if (live.area !== r.area || live.x !== r.x || live.y !== r.y || live.z !== r.z) {
      phases.moves.push({ op: "room_move", ref: { room: r.id, area: r.area }, local: r.id, x: r.x, y: r.y, z: r.z, from: { area: live.area, x: live.x, y: live.y, z: live.z } });
    }
    const upd = { op: "room_update", ref: { room: r.id }, local: r.id };
    if (live.name !== r.name) upd.name = r.name;
    if (live.description !== r.description) upd.description = r.description;
    if (upd.name !== undefined || upd.description !== undefined) phases.rooms.push(upd);
  }

  // Exits. The wanted directions come from the map's geometry (or the stored adir/bdir across areas).
  const want = (e) => {
    const a = D.rooms.get(e.a), b = D.rooms.get(e.b);
    return { adir: exitDirFrom(doc, e, a, D.rooms), bdir: exitDirFrom(doc, e, b, D.rooms) };
  };
  const liveByPair = new Map(remote.exits.map((x) => [pairKey(x.a, x.b), x]));
  for (const [id, x] of R.exits) {
    const e = D.exits.get(id);
    const ends = e && pairKey(e.a, e.b) === pairKey(x.a, x.b);
    if (!ends && !deleting.has(x.a) && !deleting.has(x.b)) phases.removals.push({ op: "exit_delete", ref: { exit: id }, local: id });
  }
  const foreignPair = new Map(proj.foreign.exits.map((f) => [pairKey(f.a, f.b), f]));
  for (const e of doc.exits) {
    const w = want(e);
    const x = R.exits.get(e.id);
    if (x && pairKey(e.a, e.b) === pairKey(x.a, x.b)) {
      // The same two rooms: bring type, hidden and the side names in line.
      const flip = x.a !== e.a;
      const xa = flip ? x.bdir : x.adir, xb = flip ? x.adir : x.bdir;
      const upd = { op: "exit_update", ref: { exit: e.id, a: e.a }, local: e.id };
      if (liveType(x.type) !== liveType(e.type)) upd.type = e.type;
      if (x.hidden !== e.hidden) upd.hidden = e.hidden;
      if (xa && w.adir && xa !== w.adir) upd.adir = w.adir;
      if (xb && w.bdir && xb !== w.bdir) upd.bdir = w.bdir;
      if (Object.keys(upd).length > 4) phases.joins.push(upd);
      continue;
    }
    if (!w.adir || !w.bdir) {
      notes.push(`exit ${e.id} has no direction on one side, so it cannot be made.`);
      continue;
    }
    const other = liveByPair.get(pairKey(e.a, e.b));
    if (other && !D.exits.has(other.id)) {
      // Unreachable in practice: a linked exit between these rooms that the map dropped is deleted above.
    }
    const f = foreignPair.get(pairKey(e.a, e.b));
    if (f) {
      adopt.exits[e.id] = f.moo;
      notes.push(`exit ${e.id} takes over ${f.moo}, already joining those two rooms in the world.`);
      phases.joins.push({ op: "exit_update", ref: { exit: e.id, a: e.a }, local: e.id, type: e.type, hidden: e.hidden });
      continue;
    }
    phases.joins.push({ op: "exit_create", ref: { a: e.a, b: e.b }, local: e.id, adir: w.adir, bdir: w.bdir, type: e.type, hidden: e.hidden });
  }

  // Edges.
  for (const [id] of R.edges) {
    const g = D.edges.get(id);
    if ((!g || g.from !== R.edges.get(id).from) && !deleting.has(R.edges.get(id).from)) phases.removals.push({ op: "edge_delete", ref: { edge: id }, local: id });
  }
  for (const g of doc.edges) {
    const x = R.edges.get(g.id);
    if (x && x.from === g.from) {
      const upd = { op: "edge_update", ref: { edge: g.id }, local: g.id };
      if (x.dir !== g.dir) upd.dir = g.dir;
      if (x.success !== g.success) upd.ref.success = g.success;
      if (x.fail !== g.fail) upd.ref.fail = g.fail;
      if (x.hidden !== g.hidden) upd.hidden = g.hidden;
      if (Object.keys(upd).length > 3 || Object.keys(upd.ref).length > 1) phases.joins.push(upd);
      continue;
    }
    phases.joins.push({ op: "edge_create", ref: { from: g.from, success: g.success, fail: g.fail }, local: g.id, dir: g.dir, hidden: g.hidden });
  }

  // Blocks: added when missing; removed when the map had them before (base) and dropped them.
  const bk = (b) => cellKey(b.area, b.x, b.y, b.z);
  const live = new Set(remote.blocks.map(bk));
  const mine = new Set(doc.blocks.map(bk));
  const before = new Set((base?.blocks ?? []).map(bk));
  for (const b of doc.blocks) if (!live.has(bk(b))) phases.joins.push({ op: "block_add", ref: { area: b.area }, x: b.x, y: b.y, z: b.z });
  for (const b of remote.blocks) if (!mine.has(bk(b)) && before.has(bk(b))) phases.removals.push({ op: "block_remove", ref: { area: b.area }, x: b.x, y: b.y, z: b.z });

  // Elevators, last: every lobby must exist first. Ones dropped from the map go before any room is deleted,
  // so a carriage takes its lobby exits with it.
  const RV = new Map(remote.elevators.map((v) => [v.id, v]));
  const goneLifts = new Set(proj.gone.elevators);
  const wantLifts = doc.elevators ?? [];
  if (wantLifts.length && !proj.elevatorApi) {
    notes.push(`${wantLifts.length === 1 ? "1 elevator is" : `${wantLifts.length} elevators are`} on the map, but the MOO has no elevator system yet ($elevator:mapper_set), so they wait: publish again once it does.`);
  } else {
    for (const local of Object.keys(link.elevators ?? {})) {
      if (!wantLifts.some((v) => v.id === local) && !goneLifts.has(local)) phases.removals.push({ op: "elevator_delete", ref: { elevator: local }, local });
    }
    for (const v of wantLifts) {
      const spec = { name: v.name, description: v.description, door: v.door, travel: v.travel, stops: v.stops.map((x) => ({ label: x.label, room: x.room })) };
      if (!spec.stops.length) { notes.push(`elevator ${v.id} "${v.name}" has no stops, so it is not made.`); continue; }
      const live = link.elevators?.[v.id] && !goneLifts.has(v.id) ? RV.get(v.id) : undefined;
      if (!live) {
        if (goneLifts.has(v.id)) notes.push(`elevator ${v.id} "${v.name}" was linked to ${link.elevators[v.id]}, which is gone from the world; it is made again.`);
        phases.elevators.push({ op: "elevator_create", local: v.id, ...spec });
        continue;
      }
      if (live.outside?.length) notes.push(`elevator ${v.id} "${v.name}" also stops at ${live.outside.map((x) => `${x.label} (${x.moo})`).join(", ")}, outside this map; publishing it drops ${live.outside.length === 1 ? "that stop" : "those stops"}.`);
      const same = !live.unreadable && !live.outside?.length && live.name === spec.name && live.description === spec.description && live.door === spec.door && live.travel === spec.travel
        && JSON.stringify(live.stops) === JSON.stringify(spec.stops);
      if (!same) phases.elevators.push({ op: "elevator_update", ref: { elevator: v.id }, local: v.id, ...spec });
    }
  }

  // Removals in a safe order: elevators, edges, then exits, then blocks, then rooms.
  const rank = { elevator_delete: -1, edge_delete: 0, exit_delete: 1, block_remove: 2, room_delete: 3 };
  phases.removals.sort((p, q) => rank[p.op] - rank[q.op]);
  // Rooms before their joins: exits and edges need both ends.
  const counts = Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { phases, adopt, notes, counts, total };
}

/** An op with its `ref` local ids resolved against `link`, or `{ error }` naming what is missing. */
export function resolveOp(op, link) {
  const out = { ...op };
  delete out.ref;
  delete out.local;
  delete out.from;
  delete out.players;
  for (const [field, local] of Object.entries(op.ref ?? {})) {
    const table = field === "area" ? link.areas : field === "exit" ? link.exits : field === "edge" ? link.edges : field === "elevator" ? (link.elevators ?? {}) : link.rooms;
    const id = table[local];
    if (!id) return { error: `${field} ${local} has no counterpart in the world (it was not made)` };
    out[field] = id;
  }
  if (out.op === "exit_update" && op.ref?.a) out.a = link.rooms[op.ref.a];
  if (op.stops) {
    out.stops = [];
    for (const x of op.stops) {
      const id = link.rooms[x.room];
      if (!id) return { error: `stop ${x.label}'s lobby ${x.room} has no counterpart in the world (it was not made)` };
      out.stops.push({ label: x.label, room: id });
    }
  }
  return { op: out };
}

/** One line per op, for a plan or a report. */
export function describeOp(op, doc) {
  const room = (id) => {
    const r = doc.rooms.find((x) => x.id === id);
    return r ? `${id} "${r.name}"` : id;
  };
  const at = (o) => `(${o.x},${o.y},${o.z})`;
  switch (op.op) {
    case "area_create": return `make area ${op.local} "${op.name}"`;
    case "area_rename": return `rename area ${op.local} → "${op.name}"`;
    case "room_create": return `make room ${room(op.local)} at ${at(op)} in ${op.ref.area}`;
    case "room_update": return `update room ${room(op.local)}:${op.name !== undefined ? ` name` : ""}${op.description !== undefined ? ` description` : ""}`;
    case "room_move": return `move room ${room(op.local)} ${at(op.from)} → ${at(op)}${op.from.area !== op.ref.area ? ` into ${op.ref.area}` : ""}`;
    case "room_delete": return `delete room ${op.local} "${op.name}"${op.players ? ` (${op.players} player${op.players === 1 ? "" : "s"} inside)` : ""}`;
    case "exit_create": return `make exit ${op.local}: ${room(op.ref.a)} ${op.adir} ⇄ ${op.bdir} ${room(op.ref.b)}${op.type !== "open" ? ` [${op.type}]` : ""}${op.hidden ? " [hidden]" : ""}`;
    case "exit_update": return `update exit ${op.local}:${["type", "hidden", "adir", "bdir"].filter((k) => op[k] !== undefined).map((k) => ` ${k}=${op[k]}`).join("")}`;
    case "exit_delete": return `delete exit ${op.local}`;
    case "edge_create": return `make edge ${op.local}: ${room(op.ref.from)} ${op.dir} → success ${op.ref.success}, fail ${op.ref.fail}`;
    case "edge_update": return `update edge ${op.local}`;
    case "edge_delete": return `delete edge ${op.local}`;
    case "block_add": return `block (${op.x},${op.y},${op.z}) in ${op.ref.area}`;
    case "block_remove": return `unblock (${op.x},${op.y},${op.z}) in ${op.ref.area}`;
    case "elevator_create": return `make elevator ${op.local} "${op.name}": a carriage and ${op.stops.length} lobby exit${op.stops.length === 1 ? "" : "s"} (${op.stops.map((x) => `${x.label}=${room(x.room)}`).join(", ")})`;
    case "elevator_update": return `update elevator ${op.local} "${op.name}": stops ${op.stops.map((x) => `${x.label}=${x.room}`).join(", ")}, door ${op.door}s, travel ${op.travel}s`;
    case "elevator_delete": return `delete elevator ${op.local}: its carriage and lobby exits`;
    default: return JSON.stringify(op);
  }
}

/** The link after one op's result: made things are linked, deleted things unlinked. */
export function linkAfter(link, op, result) {
  if (!result?.ok) return;
  const v = typeof result.value === "string" ? result.value : null;
  switch (op.op) {
    case "area_create": if (v) link.areas[op.local] = v; break;
    case "room_create": if (v) link.rooms[op.local] = v; break;
    case "exit_create": if (v) link.exits[op.local] = v; break;
    case "edge_create": if (v) link.edges[op.local] = v; break;
    case "elevator_create": if (v) (link.elevators ??= {})[op.local] = v; break;
    case "elevator_delete": delete link.elevators?.[op.local]; break;
    case "room_delete": delete link.rooms[op.local]; break;
    case "exit_delete": delete link.exits[op.local]; break;
    case "edge_delete": delete link.edges[op.local]; break;
    default: break;
  }
}

export { PHASES, LONG, OPPOSITE };

// ---------------------------------------------------------------------------
// Pull: the world's changes since the map last looked, merged under the map's own
// ---------------------------------------------------------------------------


/**
 * `doc` with what changed in the world since `base` applied on top. An element the map also changed since
 * `base` keeps the map's version (and is listed in `kept`). With no base (a map never published or pulled)
 * the world is taken whole for what it knows, and the map's own unlinked things are kept.
 */
export function mergePull(doc, base, world) {
  const ignore = ["color", "notes"];
  const from = base ?? { ...world, areas: [], rooms: [], exits: [], edges: [], blocks: [], elevators: [] };
  const theirs = diffDocs(from, world, { ignore });
  const mine = base ? diffDocs(base, doc, { ignore }) : {};
  const kept = [];
  for (const c of ["areas", "rooms", "exits", "edges", "elevators"]) {
    const p = theirs[c];
    if (!p) continue;
    const touched = new Set([...(mine[c]?.add ?? []), ...(mine[c]?.put ?? [])].map((o) => o.id).concat(mine[c]?.del ?? []));
    const keep = (id) => {
      if (!touched.has(id)) return true;
      kept.push(`${c.slice(0, -1)} ${id}`);
      return false;
    };
    // Colour and notes are the map's: a room the world changed keeps the map's.
    const own = new Map((doc[c] ?? []).map((o) => [o.id, o]));
    const withOwn = (o) => (c === "rooms" && own.has(o.id) ? { ...o, color: own.get(o.id).color, notes: own.get(o.id).notes } : o);
    theirs[c] = { add: p.add.filter((o) => keep(o.id)).map(withOwn), put: p.put.filter((o) => keep(o.id)).map(withOwn), del: p.del.filter(keep) };
  }
  delete theirs.name;
  const { doc: merged, conflicts } = applyPatch(doc, theirs);
  return { doc: merged, kept, conflicts, theirs };
}
