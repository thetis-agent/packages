// The coordinate space a build is authored in, and the picture of it.
//
// Torchship's convention, shared by $building_utils:calc_relative_coordinates,
// $room:set_xyz_rec and the website's mapper: x grows east, y grows SOUTH, z
// grows DOWN (0 is ground level, up is negative). Neighbours differ by one.
// Keeping the MOO's own convention means a coordinate the tools report is the
// same number `lmap`, `@dig` and the mapper use, with no translation layer to
// get wrong.

// The direction tables live in ui/core/doc.js, shared with the tab: the 8 planar, up/down and the 16
// vertical diagonals (nu "northup" .. nwd "northwestdown").
export { DIRS, OPPOSITE, LONG, dirOf } from "../ui/core/doc.js";
import { DIRS } from "../ui/core/doc.js";

export const key = (x, y, z) => `${x},${y},${z}`;
export const cellOf = (r) => key(r.x, r.y, r.z);

export function step(c, dir) {
  const [dx, dy, dz] = DIRS[dir];
  return { x: c.x + dx, y: c.y + dy, z: c.z + dz };
}

/** The direction from a to b when b is a's immediate neighbour, else undefined. */
export function dirBetween(a, b) {
  for (const [d, [dx, dy, dz]] of Object.entries(DIRS)) {
    if (a.x + dx === b.x && a.y + dy === b.y && a.z + dz === b.z) return d;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

// Two characters per label, so a cell is four wide: `[0a]`.
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
export function label(i) {
  const n = i + 1;
  return n < 36 * 36 ? DIGITS[Math.floor(n / 36)] + DIGITS[n % 36] : "##";
}

/**
 * Labels in reading order: level by level from the top, then row by row from
 * the north, then west to east. The same build always gets the same labels.
 */
export function labelled(rooms) {
  const sorted = [...rooms].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || String(a.id).localeCompare(String(b.id)));
  return new Map(sorted.map((r, i) => [r.id, label(i)]));
}

/**
 * Draw every level of a build as a grid. Connectors are drawn only for exits
 * that join geometric neighbours inside the build, which is exactly the set a
 * coordinate-space author controls; anything else is listed under the map.
 *
 *   -  |  /  \  an exit pair (X where two diagonals cross)
 *   +           a door
 *   :           a hidden exit
 */
export function renderLevels(build, { z } = {}) {
  const rooms = build.rooms;
  if (!rooms.length) return "(no rooms yet)";
  const labels = labelled(rooms);
  const at = new Map(rooms.map((r) => [cellOf(r), r]));
  const xs = rooms.map((r) => r.x), ys = rooms.map((r) => r.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const levels = [...new Set(rooms.map((r) => r.z))].sort((a, b) => a - b).filter((lz) => z === undefined || lz === z);
  if (!levels.length) return `(no rooms on level z=${z}; levels: ${[...new Set(rooms.map((r) => r.z))].sort((a, b) => a - b).join(", ")})`;

  // How the pair between two neighbouring cells is drawn, or undefined.
  const join = (a, dir) => {
    const ex = a.exits.find((e) => e.compass === dir && e.adjacent);
    if (!ex) return undefined;
    if (ex.hidden) return ":";
    if (ex.type === "door" || ex.type === "locked") return "+";
    return null; // the plain glyph for this orientation
  };
  const glyph = (a, dir, plain) => {
    if (!a) return " ";
    const j = join(a, dir);
    return j === undefined ? " " : j ?? plain;
  };

  const pad = Math.max(`y${minY}`.length, `y${maxY}`.length) + 1;
  const out = [];
  for (const lz of levels) {
    out.push(`level z=${lz}${lz === 0 ? " (ground)" : lz < 0 ? " (above ground)" : " (below ground)"}`);
    let head = " ".repeat(pad);
    for (let x = minX; x <= maxX; x++) head += String(x).padStart(3).padEnd(5);
    out.push(`${"x→".padStart(pad)}${head.slice(pad)}`.trimEnd());
    for (let y = minY; y <= maxY; y++) {
      let row = `y${y}`.padStart(pad - 1) + " ";
      let below = " ".repeat(pad);
      for (let x = minX; x <= maxX; x++) {
        const r = at.get(key(x, y, lz));
        const vert = r && r.exits.some((e) => e.adjacent && DIRS[e.compass]?.[2]);
        row += r ? (vert ? `<${labels.get(r.id)}>` : `[${labels.get(r.id)}]`) : "    ";
        if (x < maxX) row += glyph(r, "e", "-");
        if (y < maxY) {
          below += " " + glyph(r, "s", "|") + "  ";
          if (x < maxX) {
            const se = glyph(r, "se", "\\");
            const ne = glyph(at.get(key(x, y + 1, lz)), "ne", "/");
            below += se !== " " && ne !== " " ? "X" : se !== " " ? se : ne;
          }
        }
      }
      out.push(row.trimEnd());
      if (y < maxY) out.push(below.trimEnd());
    }
    out.push("");
  }
  out.push("[0a] a room   <0a> a room with an exit up or down (straight or diagonal; see its exits line)   - | / \\ X exits   + door   : hidden");
  return out.join("\n");
}

/** One line per room: label, id, name, cell, and every exit with where it goes. */
export function legend(build) {
  const labels = labelled(build.rooms);
  const byId = new Map(build.rooms.map((r) => [r.id, r]));
  const rows = [...build.rooms].sort((a, b) => labels.get(a.id).localeCompare(labels.get(b.id)));
  return rows.map((r) => {
    const exits = r.exits.map((e) => {
      const name = e.compass ?? e.dir ?? "?";
      const flags = [e.type !== "open" ? e.type : "", e.hidden ? "hidden" : ""].filter(Boolean).join(",");
      const tag = flags ? `[${flags}]` : "";
      if (e.adjacent) return `${name}${tag}`;
      const there = byId.get(e.to);
      if (there) return `${name}${tag}→${labels.get(there.id)} (not adjacent)`;
      if (e.to === "#-1") return `${name}${tag}→nowhere (broken twin)`;
      return `${name}${tag}→${e.to} "${e.to_name}" (outside this build, area ${e.to_area})`;
    });
    const extra = [r.players ? `${r.players} player${r.players === 1 ? "" : "s"} here` : "", r.edges?.length ? `${r.edges.length} edge${r.edges.length === 1 ? "" : "s"}` : "", ...(r.lifts ?? []).map((l) => `in → elevator ${l.elevator} stop ${l.label}`)].filter(Boolean);
    return `${labels.get(r.id)} ${r.id} "${r.name}" (${r.x},${r.y},${r.z})  exits: ${exits.join(" ") || "none"}${extra.length ? "  · " + extra.join(", ") : ""}`;
  }).join("\n");
}
