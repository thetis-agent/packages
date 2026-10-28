// A build as a picture, one image per populated level, drawn the way the
// website's map editor (torchsite src/mapper/engine.js) draws it: the same
// cell and room sizes, palette, exit colours by type, door crossbars, dashed
// hidden exits, up/down triangles, portal tags for exits into other areas,
// pink jump-edge arcs, the dotted grid and the ghost of the level below.
//
// Two additions for a reader who cannot hover: each room carries its label
// from map_get's legend in the corner, and the margins are numbered with
// x and y, so the picture and the text name the same rooms and cells.
//
// The SVG is rasterised by resvg with a bundled DejaVu Sans Mono, so the
// picture does not depend on which fonts a fence happens to see.

import { fileURLToPath } from "node:url";
import { DIRS, dirOf, labelled } from "./grid.js";

const CELL = 104;
const ROOM = 62;
const EXIT_HEX = { open: "#9aa8bd", door: "#d98e3f", locked: "#e26666", climb: "#5fc08b", swim: "#58b7e8", special: "#b48bf2" };
const EDGE_HEX = "#e685b5";
const ROOM_FILL = "#2a3140";
const C = { bg: "#14171d", panel: "#1c212a", line: "#313a49", ink: "#dfe6f1", muted: "#8a94a6", faint: "#5b6472", accent: "#f6b73c", dot: "#3a4456", danger: "#e26666" };
const FONT = "DejaVu Sans Mono";
const HEADER = 40;
const GUTTER = 24;

const FONT_FILES = ["DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf"].map((f) => fileURLToPath(new URL(`../fonts/${f}`, import.meta.url)));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v) => Math.round(v * 100) / 100;
const attrs = (a) => Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}="${typeof v === "number" ? n(v) : esc(v)}"`).join(" ");
const tag = (name, a, body) => (body === undefined ? `<${name} ${attrs(a)}/>` : `<${name} ${attrs(a)}>${body}</${name}>`);

/** The editor's two-line name: ten characters a line, broken at a space when one is near. */
export function splitName(name) {
  if (!name) return ["", ""];
  const MAX = 10;
  if (name.length <= MAX) return [name, ""];
  let brk = name.lastIndexOf(" ", MAX);
  if (brk < 3) brk = MAX;
  let l1 = name.slice(0, brk).trim(), l2 = name.slice(brk).trim();
  if (l1.length > MAX) l1 = l1.slice(0, MAX - 1) + "…";
  if (l2.length > MAX) l2 = l2.slice(0, MAX - 1) + "…";
  return [l1, l2];
}

/** The levels that have rooms, top first. */
export function populatedLevels(build) {
  return [...new Set(build.rooms.map((r) => r.z))].sort((a, b) => a - b);
}

export function levelName(z) {
  return z === 0 ? "ground" : z < 0 ? `${-z} up` : `${z} down`;
}

const arrowHead = (hx, hy, ux, uy, L, W, fill) => {
  const px = -uy, py = ux;
  return tag("path", { fill, d: `M ${n(hx)} ${n(hy)} L ${n(hx - ux * L + px * W)} ${n(hy - uy * L + py * W)} L ${n(hx - ux * L - px * W)} ${n(hy - uy * L - py * W)} Z` });
};

/** A dashed pill with a label, where an exit or edge leaves this picture. */
function portalTag(ex, ey, ux, uy, label, col, grow) {
  const tw = label.length * 6.4 + 12, th = 16;
  const cx = ex + ux * (tw / 2 + 7), cy = ey + uy * (th / 2 + 7);
  grow(cx - tw / 2, cy - th / 2);
  grow(cx + tw / 2, cy + th / 2);
  return (
    tag("rect", { x: cx - tw / 2, y: cy - th / 2, width: tw, height: th, rx: 8, fill: C.panel, stroke: col, "stroke-width": 1.3, "stroke-dasharray": "3 3" }) +
    tag("text", { x: cx, y: cy + 3, "text-anchor": "middle", fill: col, "font-size": 9.5, "font-weight": 700 }, esc(label))
  );
}

/**
 * One level of a build as SVG, sized to its rooms with a cell of margin, the
 * way the editor's fit-to-view frames a floor. Answers `{ svg, width, height }`.
 */
export function levelSvg(build, z, { ghost = true } = {}) {
  const rooms = build.rooms.filter((r) => r.z === z);
  if (!rooms.length) throw new Error(`no rooms on level ${z}`);
  const byId = new Map(build.rooms.map((r) => [r.id, r]));
  const labels = labelled(build.rooms);
  const xs = rooms.map((r) => r.x), ys = rooms.map((r) => r.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // The frame: a cell of margin round the rooms, as the editor's fit-to-view,
  // grown by anything drawn beyond it (a portal tag, an edge leaving the level).
  const box = { x0: (minX - 1) * CELL, y0: (minY - 1) * CELL, x1: (maxX + 1) * CELL, y1: (maxY + 1) * CELL };
  const grow = (x, y) => {
    box.x0 = Math.min(box.x0, x - 8); box.x1 = Math.max(box.x1, x + 8);
    box.y0 = Math.min(box.y0, y - 8); box.y1 = Math.max(box.y1, y + 8);
  };
  const W = (r) => ({ x: r.x * CELL, y: r.y * CELL });
  const out = { grid: [], ghost: [], exit: [], room: [] };

  if (ghost) {
    for (const r of build.rooms.filter((o) => o.z === z + 1)) {
      const w = W(r);
      out.ghost.push(tag("rect", { x: w.x - ROOM / 2, y: w.y - ROOM / 2, width: ROOM, height: ROOM, rx: 8, fill: "none", stroke: C.dot, "stroke-dasharray": "3 4", "stroke-width": 1 }));
    }
  }

  const twinHidden = (e) => {
    const other = byId.get(e.to);
    return Boolean(other?.exits.find((x) => x.id === e.twin)?.hidden);
  };
  const drawn = new Set();
  for (const r of rooms) {
    const w = W(r);
    const glyphs = [];
    for (const e of r.exits) {
      const col = EXIT_HEX[e.type] ?? EXIT_HEX.open;
      const hidden = e.hidden || twinHidden(e);
      const other = byId.get(e.to);
      if (other && other.z === z) {
        // An exit between two rooms on this level: one line per pair.
        const key = [r.id, other.id].sort().join("|") + "|" + [e.id, e.twin].sort().join("|");
        if (drawn.has(key) || other.id === r.id) continue;
        drawn.add(key);
        const B = W(other);
        const dx = B.x - w.x, dy = B.y - w.y, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const t = (ROOM / 2 + 4) / Math.max(Math.abs(ux), Math.abs(uy));
        const ax = w.x + ux * t, ay = w.y + uy * t, bx = B.x - ux * t, by = B.y - uy * t;
        let g = tag("line", { x1: ax, y1: ay, x2: bx, y2: by, stroke: col, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-dasharray": hidden ? "5 6" : undefined });
        if (e.type === "door" || e.type === "locked") {
          const mx = (ax + bx) / 2, my = (ay + by) / 2, px = -uy, py = ux, s = 6;
          g += tag("line", { x1: mx - px * s, y1: my - py * s, x2: mx + px * s, y2: my + py * s, stroke: col, "stroke-width": 3, "stroke-linecap": "round" });
          if (e.type === "locked") {
            g += tag("line", { x1: mx - px * s + ux * 4, y1: my - py * s + uy * 4, x2: mx + px * s + ux * 4, y2: my + py * s + uy * 4, stroke: col, "stroke-width": 3, "stroke-linecap": "round" });
          }
        }
        out.exit.push(g);
        continue;
      }
      const d = e.compass ?? dirOf(e.dir);
      if (other) {
        // Same build, another level: a triangle on the room, pointing the way it goes.
        glyphs.push({ up: other.z < z, col, hidden, cross: false });
        continue;
      }
      if (!d) continue; // in, out: no place on a grid
      if (d === "up" || d === "down") {
        glyphs.push({ up: d === "up", col, hidden, cross: true });
        continue;
      }
      // A vertical diagonal (nu, swd …) out of the build: the triangle for its floor, and the stub below for its bearing.
      if (DIRS[d][2]) glyphs.push({ up: DIRS[d][2] < 0, col, hidden, cross: true });
      // Out of the build: a stub leaving the room, ending in a tag with the area's name.
      const v = DIRS[d], len = Math.hypot(v[0], v[1]) || 1;
      const ux = v[0] / len, uy = v[1] / len;
      const t = (ROOM / 2 + 4) / Math.max(Math.abs(ux), Math.abs(uy));
      const sx = w.x + ux * t, sy = w.y + uy * t, ex = sx + ux * 26, ey = sy + uy * 26;
      const broken = e.to === "#-1";
      const label = broken ? "broken" : (e.to_area_name || e.to_area || "?").slice(0, 9);
      const c = broken ? C.danger : col;
      out.exit.push(
        tag("line", { x1: sx, y1: sy, x2: ex, y2: ey, stroke: c, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-dasharray": hidden ? "5 6" : undefined }) +
          portalTag(ex, ey, ux, uy, label, c, grow),
      );
    }

    // Jump edges: a bowed arc to the success room, ↓ at the middle for the failure landing.
    for (const g of r.edges ?? []) {
      const s = byId.get(String(g.success));
      const visS = s && s.z === z && s.id !== r.id;
      let sx, sy, ex, ey, ux, uy;
      if (visS) {
        const B = W(s);
        const dx = B.x - w.x, dy = B.y - w.y, len = Math.hypot(dx, dy) || 1;
        ux = dx / len; uy = dy / len;
        const t = (ROOM / 2 + 4) / Math.max(Math.abs(ux), Math.abs(uy));
        sx = w.x + ux * t; sy = w.y + uy * t; ex = B.x - ux * t; ey = B.y - uy * t;
      } else {
        const v = DIRS[dirOf(g.dir) ?? "n"] ?? DIRS.n, len = Math.hypot(v[0], v[1]) || 1;
        ux = v[0] / len; uy = v[1] / len;
        const t = (ROOM / 2 + 4) / Math.max(Math.abs(ux), Math.abs(uy));
        sx = w.x + ux * t; sy = w.y + uy * t; ex = sx + ux * 34; ey = sy + uy * 34;
      }
      const px = -uy, py = ux, bow = 18;
      const cx = (sx + ex) / 2 + px * bow, cy = (sy + ey) / 2 + py * bow;
      let svg = tag("path", { d: `M ${n(sx)} ${n(sy)} Q ${n(cx)} ${n(cy)} ${n(ex)} ${n(ey)}`, fill: "none", stroke: EDGE_HEX, "stroke-width": 2.5, "stroke-linecap": "round" });
      let hux = ex - cx, huy = ey - cy;
      const hl = Math.hypot(hux, huy) || 1;
      svg += arrowHead(ex, ey, hux / hl, huy / hl, 10, 4.5, EDGE_HEX);
      grow(cx, cy);
      if (!visS) svg += portalTag(ex, ey, ux, uy, s ? `fl ${s.z}` : "elsewhere", EDGE_HEX, grow);
      const mx = (sx + 2 * cx + ex) / 4, my = (sy + 2 * cy + ey) / 4;
      svg += tag("circle", { cx: mx, cy: my, r: 7, fill: C.panel, stroke: EDGE_HEX, "stroke-width": 1.4 });
      svg += tag("text", { x: mx, y: my + 3.5, "text-anchor": "middle", fill: EDGE_HEX, "font-size": 10, "font-weight": 700 }, "↓");
      out.exit.push(svg);
    }

    // The room: the editor's square, its name on two lines, and its legend label.
    let g = tag("rect", { x: w.x - ROOM / 2, y: w.y - ROOM / 2, width: ROOM, height: ROOM, rx: 8, fill: r.color || ROOM_FILL, stroke: "#465266", "stroke-opacity": 0.53, "stroke-width": 1.2 });
    const [l1, l2] = splitName(r.name);
    g += tag(
      "text",
      { x: w.x, y: w.y + (l2 ? 0 : 4), "text-anchor": "middle", fill: l1 ? C.ink : C.faint, "font-size": 10, "font-weight": 600 },
      tag("tspan", { x: w.x }, esc(l1 || "·")) + (l2 ? tag("tspan", { x: w.x, dy: 12 }, esc(l2)) : ""),
    );
    g += tag("text", { x: w.x - ROOM / 2 + 4, y: w.y + ROOM / 2 - 4, fill: C.faint, "font-size": 8 }, esc(labels.get(r.id)));
    // Elevator lobbies: the stop's button label, bottom right.
    (r.lifts ?? []).forEach((l, i) => {
      const label = `⇕${l.label.slice(0, 3)}`, bw = 8 + label.length * 5.5;
      const bx = w.x + ROOM / 2 - 3 - bw, by = w.y + ROOM / 2 - 15 - i * 14;
      g += tag("rect", { x: bx, y: by, width: bw, height: 12, rx: 3, fill: "#132a2e", stroke: "#5fd3c6", "stroke-width": 1.2 });
      g += tag("text", { x: bx + bw / 2, y: by + 9, "text-anchor": "middle", fill: "#5fd3c6", "font-size": 8.5, "font-weight": 700 }, esc(label));
    });
    let gy = w.y - ROOM / 2 + 11;
    for (const gl of glyphs) {
      const gx = w.x + ROOM / 2 - 9;
      if (gl.cross) g += tag("circle", { cx: gx, cy: gy, r: 7.5, fill: "none", stroke: gl.col, "stroke-width": 1.2, "stroke-dasharray": "2.5 2.5" });
      const d = gl.up ? `M ${n(gx)} ${n(gy - 4)} L ${n(gx - 4.5)} ${n(gy + 3)} L ${n(gx + 4.5)} ${n(gy + 3)} Z` : `M ${n(gx)} ${n(gy + 3)} L ${n(gx - 4.5)} ${n(gy - 4)} L ${n(gx + 4.5)} ${n(gy - 4)} Z`;
      g += tag("path", { d, fill: gl.hidden ? "none" : gl.col, stroke: gl.col, "stroke-width": 1.4 });
      gy += gl.cross ? 17 : 12;
    }
    out.room.push(g);
  }

  const caption = `  ${build.id} · level z=${z} (${levelName(z)}) · ${rooms.length} room${rooms.length === 1 ? "" : "s"}`;
  // Wide enough for the title: 13px monospace advances about 7.9px a character.
  const spare = (String(build.name || build.id).length + caption.length) * 7.9 + 24 - (GUTTER + box.x1 - box.x0);
  if (spare > 0) { box.x0 -= spare / 2; box.x1 += spare / 2; }
  const width = Math.ceil(GUTTER + box.x1 - box.x0);
  const height = Math.ceil(HEADER + GUTTER + box.y1 - box.y0);
  const tx = GUTTER - box.x0, ty = HEADER + GUTTER - box.y0;

  // The dotted grid: one dot at every cell corner, as the editor's background.
  for (let gx = Math.floor(box.x0 / CELL) - 1; gx <= Math.ceil(box.x1 / CELL); gx++) {
    for (let gy = Math.floor(box.y0 / CELL) - 1; gy <= Math.ceil(box.y1 / CELL); gy++) {
      out.grid.push(tag("circle", { cx: gx * CELL + CELL / 2, cy: gy * CELL + CELL / 2, r: 1.3, fill: C.dot }));
    }
  }

  // Margins: x along the top, y down the left, in the cell's own numbers.
  const axes = [];
  for (let x = minX; x <= maxX; x++) axes.push(tag("text", { x: tx + x * CELL, y: HEADER + 16, "text-anchor": "middle", fill: C.faint, "font-size": 10 }, `x${x}`));
  for (let y = minY; y <= maxY; y++) axes.push(tag("text", { x: 4, y: ty + y * CELL + 4, fill: C.faint, "font-size": 10 }, `y${y}`));

  const title =
    tag("rect", { x: 0, y: 0, width, height: HEADER, fill: C.panel }) +
    tag("line", { x1: 0, y1: HEADER - 0.5, x2: width, y2: HEADER - 0.5, stroke: C.line, "stroke-width": 1 }) +
    tag(
      "text",
      { x: 12, y: 25, "font-size": 13 },
      tag("tspan", { fill: C.accent, "font-weight": 700 }, esc(build.name || build.id)) +
        tag("tspan", { fill: C.muted }, esc(caption)),
    );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">` +
    tag("rect", { x: 0, y: 0, width, height, fill: C.bg }) +
    `<g transform="translate(${tx},${ty})">${out.grid.join("")}${out.ghost.join("")}${out.exit.join("")}${out.room.join("")}</g>` +
    axes.join("") +
    title +
    `</svg>`;
  return { svg, width, height };
}

/**
 * Rasterise to PNG. Scaled up to 1.5x for crisp text, and down so the longer
 * side stays within `maxSide`: a model sees images at a bounded size anyway,
 * and a smaller picture costs fewer tokens than one the provider shrinks.
 */
export async function toPng({ svg, width, height }, { maxSide = 1600 } = {}) {
  let Resvg;
  try {
    ({ Resvg } = await import("@resvg/resvg-js"));
  } catch (e) {
    throw new Error(`the image renderer (@resvg/resvg-js) is not installed with this package: ${e.message}. Reinstalling the package runs npm install.`);
  }
  const scale = Math.min(1.5, maxSide / Math.max(width, height));
  const png = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT, monospaceFamily: FONT },
    background: C.bg,
  }).render();
  return { buf: png.asPng(), width: png.width, height: png.height, scale };
}
