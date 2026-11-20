// Publish state area by area. One map can hold the whole world: every area in it is in one of
//
//   draft      not in the world yet (never published: no MOO area is linked to it)
//   changed    in the world, with edits on the map that are not published yet
//   outdated   the world changed since the map last looked (seen by map_status, map_publish or map_pull)
//   published  in step with the world as last seen
//
// A change is put down to every area it touches: a room to its area (both, when it moved), an exit to the
// areas of both its ends, an edge to its room's area, a block to its area, an elevator to its stops' areas,
// a transit line to its train's area.

import { diffDocs } from "../ui/core/doc.js";

const IGNORE = { ignore: ["color", "notes"] };

/** For each area id, how many changes in `patch` (a diffDocs from `base` to `next`) touch it. */
export function attribute(patch, base, next) {
  const counts = new Map();
  const bump = (a) => { if (a) counts.set(a, (counts.get(a) ?? 0) + 1); };
  const roomArea = new Map();
  for (const r of base?.rooms ?? []) roomArea.set(r.id, r.area);
  for (const r of next?.rooms ?? []) if (!roomArea.has(r.id)) roomArea.set(r.id, r.area);
  const nextRoomArea = new Map((next?.rooms ?? []).map((r) => [r.id, r.area]));
  const baseById = (c) => new Map((base?.[c] ?? []).map((o) => [o.id, o]));
  const each = (set, fn) => set.forEach(fn);
  if (patch.areas) {
    for (const o of [...patch.areas.add, ...patch.areas.put]) bump(o.id);
    for (const id of patch.areas.del) bump(id);
  }
  if (patch.rooms) {
    const old = baseById("rooms");
    for (const o of patch.rooms.add) bump(o.area);
    for (const o of patch.rooms.put) {
      const was = old.get(o.id)?.area;
      bump(o.area);
      if (was && was !== o.area) bump(was);
    }
    for (const id of patch.rooms.del) bump(old.get(id)?.area);
  }
  const ends = (ids) => new Set(ids.map((id) => nextRoomArea.get(id) ?? roomArea.get(id)).filter(Boolean));
  if (patch.exits) {
    const old = baseById("exits");
    for (const o of [...patch.exits.add, ...patch.exits.put]) each(ends([o.a, o.b, ...(old.has(o.id) ? [old.get(o.id).a, old.get(o.id).b] : [])]), bump);
    for (const id of patch.exits.del) { const o = old.get(id); if (o) each(ends([o.a, o.b]), bump); }
  }
  if (patch.edges) {
    const old = baseById("edges");
    for (const o of [...patch.edges.add, ...patch.edges.put]) each(ends([o.from]), bump);
    for (const id of patch.edges.del) { const o = old.get(id); if (o) each(ends([o.from]), bump); }
  }
  if (patch.elevators) {
    const old = baseById("elevators");
    const stopsOf = (v) => (v?.stops ?? []).map((s) => s.room);
    for (const o of [...patch.elevators.add, ...patch.elevators.put]) each(ends([...stopsOf(o), ...stopsOf(old.get(o.id))]), bump);
    for (const id of patch.elevators.del) each(ends(stopsOf(old.get(id))), bump);
  }
  if (patch.transits) {
    // A line is put down to its train's area only: its platforms' rooms are not changed by it.
    const old = baseById("transits");
    for (const o of [...patch.transits.add, ...patch.transits.put]) bump(o.area);
    for (const id of patch.transits.del) bump(old.get(id)?.area);
  }
  if (patch.blocks) for (const b of [...patch.blocks.add, ...patch.blocks.del]) bump(b.area);
  return counts;
}

/**
 * One row per area of the map, in the map's order:
 * `{ id, name, moo, state, pending, drift, rooms, label }`. `drift` comes from the last world check
 * (`link.drift`), so it is as fresh as that check.
 */
export function areaStates(record) {
  const { doc, link } = record;
  const pending = link.published ? attribute(diffDocs(link.published, doc, IGNORE), link.published, doc) : new Map();
  const drift = link.drift?.areas ?? {};
  const rooms = new Map();
  for (const r of doc.rooms) rooms.set(r.area, (rooms.get(r.area) ?? 0) + 1);
  return doc.areas.map((a) => {
    const moo = link.areas[a.id] ?? null;
    const p = pending.get(a.id) ?? 0;
    const d = moo ? drift[a.id] ?? 0 : 0;
    let state;
    if (!moo) state = "draft";
    else if (!link.published) state = "linked";
    else if (d) state = "outdated";
    else if (p) state = "changed";
    else state = "published";
    const bits = [];
    if (state === "draft") bits.push("not in the world yet");
    if (moo && p) bits.push(`${p} unpublished change${p === 1 ? "" : "s"}`);
    if (d) bits.push(`${d} change${d === 1 ? "" : "s"} in the world since the last sync`);
    if (state === "published") bits.push("in step with the world");
    if (state === "linked") bits.push("linked, not yet compared");
    return { id: a.id, name: a.name, moo, state, pending: moo ? p : rooms.get(a.id) ?? 0, drift: d, rooms: rooms.get(a.id) ?? 0, label: bits.join("; ") };
  });
}

/** How many areas are in each state: { draft: 7, changed: 1, published: 135, ... }. */
export function stateCounts(rows) {
  const out = {};
  for (const r of rows) out[r.state] = (out[r.state] ?? 0) + 1;
  return out;
}

export const STATE_ORDER = ["draft", "changed", "outdated", "linked", "published"];

/** "7 draft · 1 changed · 135 published". */
export function countsText(counts) {
  return STATE_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(" · ");
}

/** Which areas each element of a doc belongs to, for publishing some areas and not others. */
export function areasOfOp(op, doc, remote) {
  const roomArea = new Map();
  for (const r of remote?.rooms ?? []) roomArea.set(r.id, r.area);
  for (const r of doc.rooms) roomArea.set(r.id, r.area);
  const ofRoom = (id) => roomArea.get(id);
  const ref = op.ref ?? {};
  switch (op.op) {
    case "area_create": case "area_rename": return [op.local];
    case "room_create": return [ref.area];
    case "room_move": return [ref.area, op.from?.area];
    case "room_update": case "room_delete": return [ofRoom(op.local)];
    case "exit_create": return [ofRoom(ref.a), ofRoom(ref.b)];
    case "exit_update": case "exit_delete": {
      const e = doc.exits.find((x) => x.id === op.local) ?? remote?.exits?.find((x) => x.id === op.local);
      return e ? [ofRoom(e.a), ofRoom(e.b)] : [];
    }
    case "edge_create": return [ofRoom(ref.from)];
    case "edge_update": case "edge_delete": {
      const g = doc.edges.find((x) => x.id === op.local) ?? remote?.edges?.find((x) => x.id === op.local);
      return g ? [ofRoom(g.from)] : [];
    }
    case "block_add": case "block_remove": return [ref.area];
    case "elevator_create": case "elevator_update": return (op.stops ?? []).map((s) => ofRoom(s.room));
    case "transit_set": return [ref.area, ofRoom(ref.car), ...(op.stations ?? []).map((s) => ofRoom(s.room))];
    case "transit_clear": return [ref.area];
    case "elevator_delete": {
      const v = remote?.elevators?.find((x) => x.id === op.local);
      return v ? v.stops.map((s) => ofRoom(s.room)) : [];
    }
    default: return [];
  }
}

/**
 * `fresh` (the world as read back after a publish) for the areas in `only`, and `old` (the map's earlier
 * picture of the world) for the rest, so an area left out of a publish keeps its own pending changes and
 * any world drift still shows.
 */
export function mergePublished(old, fresh, only) {
  if (!old) return fresh;
  const inOnly = (a) => only.has(a);
  const freshRoomArea = new Map(fresh.rooms.map((r) => [r.id, r.area]));
  const oldRoomArea = new Map(old.rooms.map((r) => [r.id, r.area]));
  const areaOf = (id) => freshRoomArea.get(id) ?? oldRoomArea.get(id);
  const touches = (ids) => ids.some((id) => inOnly(areaOf(id)));
  const pick = (c, mine) => {
    const kept = (old[c] ?? []).filter((o) => !mine(o));
    const took = (fresh[c] ?? []).filter(mine);
    return [...kept, ...took];
  };
  return {
    ...fresh,
    areas: pick("areas", (a) => inOnly(a.id)),
    rooms: pick("rooms", (r) => inOnly(r.area) || inOnly(oldRoomArea.get(r.id))),
    exits: pick("exits", (e) => touches([e.a, e.b])),
    edges: pick("edges", (g) => touches([g.from])),
    blocks: pick("blocks", (b) => inOnly(b.area)),
    elevators: pick("elevators", (v) => touches(v.stops.map((s) => s.room))),
    transits: pick("transits", (t) => inOnly(t.area)),
  };
}

/** Each area's drift: what the world changed since `base`, put down to areas. */
export function driftByArea(base, world) {
  if (!base) return {};
  const patch = diffDocs(base, world, IGNORE);
  delete patch.name;
  return Object.fromEntries(attribute(patch, base, world));
}

/** Per area, how many things the world has there that the map does not (rooms, exits, edges). */
export function foreignByArea(proj, doc) {
  const roomArea = new Map(doc.rooms.map((r) => [r.id, r.area]));
  const out = {};
  const bump = (a) => { if (a) out[a] = (out[a] ?? 0) + 1; };
  for (const f of proj.foreign.rooms) if (!f.duplicateCell) bump(f.area); // a room stacked on a taken cell cannot be drawn, so it is not news
  for (const f of proj.foreign.exits) bump(roomArea.get(f.a));
  for (const f of proj.foreign.edges) bump(roomArea.get(f.from));
  for (const f of proj.foreign.transits ?? []) bump(f.area);
  return out;
}

/** The drift record a world check leaves on the link. */
export function driftRecord(base, world, proj, doc) {
  const areas = driftByArea(base, world);
  const foreign = foreignByArea(proj, doc);
  for (const [a, n] of Object.entries(foreign)) areas[a] = (areas[a] ?? 0) + n;
  return { at: new Date().toISOString(), areas, foreign };
}

export const sameDrift = (p, q) => JSON.stringify(p?.areas ?? {}) === JSON.stringify(q?.areas ?? {});
