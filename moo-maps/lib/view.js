// A map seen through the text grid and the picture renderer (lib/grid.js, lib/image.js, the same ones
// @bitmuse/moo-build draws with). They take one area at a time in "build" shape: rooms each with
// exits { id, twin, to, compass, type, hidden, adjacent } and edges { dir, success }. Exits into another
// area of the map, or into the world beyond it, are drawn as portal stubs.

import { elevatorLines } from "./ops.js";
import { exitDirFrom, stepDir } from "../ui/core/doc.js";
import { renderLevels, legend, labelled } from "./grid.js";
import { publishState } from "./store.js";

export function areaBuild(doc, areaId, link) {
  const area = doc.areas.find((a) => a.id === areaId);
  const byId = new Map(doc.rooms.map((r) => [r.id, r]));
  const areaName = new Map(doc.areas.map((a) => [a.id, a.name]));
  const rooms = doc.rooms.filter((r) => r.area === areaId).map((r) => ({
    id: r.id, name: r.name, x: r.x, y: r.y, z: r.z, color: r.color, description: r.description,
    lifts: (doc.elevators ?? []).flatMap((v) => v.stops.filter((st) => st.room === r.id).map((st) => ({ elevator: v.id, name: v.name, label: st.label }))),
    exits: [], edges: doc.edges.filter((g) => g.from === r.id).map((g) => ({ id: g.id, dir: g.dir, success: g.success, fail: g.fail, hidden: g.hidden })),
  }));
  const mine = new Map(rooms.map((r) => [r.id, r]));
  for (const e of doc.exits) {
    for (const [self, otherId, side] of [[e.a, e.b, "a"], [e.b, e.a, "b"]]) {
      const r = mine.get(self);
      if (!r) continue;
      const src = byId.get(self), other = byId.get(otherId);
      const compass = exitDirFrom(doc, e, src, byId);
      const inArea = other.area === areaId;
      r.exits.push({
        id: `${e.id}${side}`, twin: `${e.id}${side === "a" ? "b" : "a"}`, to: inArea ? otherId : `${otherId}`,
        to_name: other.name, to_area: other.area, to_area_name: areaName.get(other.area),
        compass, dir: compass, type: e.type, hidden: e.hidden, adjacent: inArea && stepDir(src, other) === compass,
      });
    }
  }
  // Exits the world has into rooms the map does not hold.
  for (const x of link?.external ?? []) {
    const r = mine.get(x.room);
    if (!r) continue;
    r.exits.push({ id: x.exit, twin: "", to: x.to, to_name: x.to_name, to_area: x.to_area, to_area_name: x.to_area_name, compass: x.compass, dir: x.dir, type: x.type ?? "open", hidden: false, adjacent: false, world: true });
  }
  return { id: areaId, name: area?.name ?? areaId, rooms };
}

export function header(record) {
  const s = publishState(record);
  const d = record.doc;
  const where = Object.keys(record.link.areas).length
    ? d.areas.map((a) => `${a.id} "${a.name}"${record.link.areas[a.id] ? ` → ${record.link.areas[a.id]}` : " (not in the world yet)"}`).join("; ")
    : d.areas.map((a) => `${a.id} "${a.name}"`).join("; ");
  return [
    `${record.id} "${d.name}" · rev ${record.rev} · ${d.rooms.length} rooms, ${d.exits.length} exits${d.edges.length ? `, ${d.edges.length} edges` : ""}${d.blocks.length ? `, ${d.blocks.length} blocks` : ""}`,
    `state: ${s.label}`,
    `areas: ${where}`,
  ].join("\n");
}

/** Text grid and legend of every area (or one), with world links and players marked. */
export function textMap(record, { area, z, descriptions = false } = {}) {
  const d = record.doc;
  const out = [];
  for (const a of d.areas) {
    if (area && a.id !== area) continue;
    const b = areaBuild(d, a.id, record.link);
    out.push(`── area ${a.id} "${a.name}"${record.link.areas[a.id] ? ` (${record.link.areas[a.id]})` : ""} ──`);
    if (!b.rooms.length) { out.push("(no rooms yet)", ""); continue; }
    out.push(renderLevels(b, { z }), "");
    const labels = labelled(b.rooms);
    const lines = legend(b).split("\n").map((line) => {
      const id = line.split(" ")[1];
      const moo = record.link.rooms[id];
      const r = d.rooms.find((x) => x.id === id);
      let s = moo ? line.replace(` ${id} `, ` ${id} ${moo} `) : line;
      if (r?.notes) s += `  · notes: ${r.notes.replace(/\n/g, " ").slice(0, 80)}`;
      if (descriptions && r) s += `\n     ${r.description ? r.description.replace(/\n/g, "\n     ") : "(no description)"}`;
      else if (r && !r.description) s += "  · no description";
      return s;
    });
    out.push("Rooms (label id [moo id] \"name\" (x,y,z) exits):", ...lines, "");
    void labels;
  }
  const ev = elevatorLines(d, record.link);
  if (ev.length) out.push("Elevators (each a carriage off the grid; a lobby's `in` opens on it):", ...ev, "");
  return out.join("\n").trimEnd();
}
