/* The graph a definition draws as: its edges, which of them loop back, a layered top-down layout, and
 * the curve geometry. DOM-free, so it runs under node:test. The engine ignores `layout`; only the editor
 * reads and writes it. */

import { FLOW_FIELDS } from "./steps.js";

export const NODE_W = 220;
export const NODE_H = 64; // the height assumed for a node that has not been measured yet
export const COL_GAP = 270;
export const ROW_GAP = 140;

/**
 * Every control-flow edge of a definition, in step order: `{ key, from, to, field, label, back }`.
 * `field` is the step field that holds it (`next`, `onBreach`, `cases.FIXED`…); `label` is what the canvas
 * prints on it (none for `next`); `back` marks an edge that returns to a step already on the path from
 * `start`, and a loop's `target` always. Edges naming no step are left out: the validator reports them.
 * `parse.from` and `prompt.conversation` are data references, not control flow, and draw no edge.
 */
export function edges(def) {
  const steps = def?.steps ?? {};
  const out = [];
  for (const [from, step] of Object.entries(steps)) {
    const push = (field, to, label) => {
      if (typeof to === "string" && to && steps[to]) out.push({ key: `${from}:${field}`, from, to, field, label, back: false });
    };
    for (const { field } of FLOW_FIELDS[step?.type] ?? []) {
      if (field === "default") continue; // after the cases, so a branch reads left to right
      push(field, step[field], field === "next" ? "" : field);
    }
    if (step?.type === "branch") {
      for (const [value, to] of Object.entries(step.cases ?? {})) push(`cases.${value}`, to, value);
      push("default", step.default, "default");
    }
  }
  const back = backEdges(def, out);
  for (const e of out) e.back = back.has(e.key) || e.field === "target";
  return out;
}

/** The keys of the edges a depth-first walk from `start` (then from every step it missed) finds pointing back up its own path. */
function backEdges(def, list) {
  const steps = Object.keys(def?.steps ?? {});
  const bySource = new Map(steps.map((id) => [id, []]));
  for (const e of list) bySource.get(e.from)?.push(e);
  const state = new Map(); // 1 on the stack, 2 finished
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of bySource.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 1) back.add(e.key);
      else if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  const roots = def?.start && def.steps?.[def.start] ? [def.start, ...steps] : steps;
  for (const id of roots) if (!state.has(id)) visit(id);
  return back;
}

/**
 * A layered top-down layout of every step: `{ [id]: { x, y } }`. A step's layer is the longest forward
 * path to it from a root (`start` first, then any step nothing reaches); each layer is ordered by the mean
 * position of its parents so edges cross less, and centred on the widest layer.
 */
export function autoLayout(def) {
  const ids = Object.keys(def?.steps ?? {});
  if (!ids.length) return {};
  const forward = edges(def).filter((e) => !e.back && e.from !== e.to);
  const parents = new Map(ids.map((id) => [id, []]));
  const children = new Map(ids.map((id) => [id, []]));
  for (const e of forward) {
    parents.get(e.to).push(e.from);
    children.get(e.from).push(e.to);
  }
  // Longest path over the forward edges (a DAG once back edges are out), in a topological order.
  const layer = new Map();
  const indeg = new Map(ids.map((id) => [id, parents.get(id).length]));
  const order = [];
  const queue = ids.filter((id) => indeg.get(id) === 0);
  if (def.start && queue.includes(def.start)) queue.splice(queue.indexOf(def.start), 1), queue.unshift(def.start);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const c of children.get(id)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id); // a cycle the walk could not break: keep it drawable
  for (const id of order) {
    const ps = parents.get(id).filter((p) => layer.has(p));
    layer.set(id, ps.length ? Math.max(...ps.map((p) => layer.get(p))) + 1 : 0);
  }
  const rows = [];
  for (const id of order) (rows[layer.get(id)] ??= []).push(id);
  const slot = new Map();
  rows.forEach((row, r) => {
    if (r > 0) {
      const mean = (id) => {
        const ps = parents.get(id).filter((p) => slot.has(p));
        return ps.length ? ps.reduce((s, p) => s + slot.get(p), 0) / ps.length : Infinity;
      };
      const keyed = row.map((id, i) => [id, mean(id), i]);
      keyed.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
      rows[r] = row = keyed.map((k) => k[0]);
    }
    row.forEach((id, i) => slot.set(id, i - (row.length - 1) / 2));
  });
  const widest = Math.max(...rows.map((row) => row?.length ?? 0));
  const centre = ((widest - 1) / 2) * COL_GAP;
  const out = {};
  for (const id of ids) out[id] = { x: Math.round(centre + slot.get(id) * COL_GAP), y: layer.get(id) * ROW_GAP };
  return out;
}

/**
 * The layout the editor draws: every position the definition already holds, and an automatic one for each
 * step without one, nudged right until it overlaps nothing already placed. Returns a new object.
 */
export function completeLayout(def) {
  const have = def?.layout ?? {};
  const ids = Object.keys(def?.steps ?? {});
  const out = {};
  for (const id of ids) if (validPoint(have[id])) out[id] = { x: have[id].x, y: have[id].y };
  const missing = ids.filter((id) => !out[id]);
  if (!missing.length) return out;
  const auto = autoLayout(def);
  if (missing.length === ids.length) return auto;
  const clashes = (p) => Object.values(out).some((q) => Math.abs(q.x - p.x) < NODE_W + 20 && Math.abs(q.y - p.y) < NODE_H + 30);
  for (const id of missing) {
    const p = { ...auto[id] };
    while (clashes(p)) p.x += COL_GAP;
    out[id] = p;
  }
  return out;
}

const validPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** A point on a cubic Bezier at t. */
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * The SVG path of an edge between two boxes `{ x, y, w, h }` and where its label sits. A forward edge
 * leaves the bottom of its source (spread across it when the source has several: `index` of `count`) and
 * enters the top of its target; a back edge leaves the source's left side and swings out to the left of
 * both before entering the target's left side, so a loop reads as a return rather than another step down.
 */
export function edgeGeometry(a, b, { back = false, index = 0, count = 1, lane = 0 } = {}) {
  let p;
  if (back) {
    const sx = a.x, sy = a.y + a.h / 2;
    const ex = b.x, ey = b.y + b.h / 2;
    const out = Math.min(sx, ex) - 70 - lane * 26;
    p = [sx, sy, out, sy, out, ey, ex, ey];
  } else {
    const sx = a.x + (a.w * (index + 1)) / (count + 1), sy = a.y + a.h;
    const ex = b.x + b.w / 2, ey = b.y;
    const k = Math.max(36, Math.abs(ey - sy) / 2);
    p = [sx, sy, sx, sy + k, ex, ey - k, ex, ey];
  }
  const r = (v) => Math.round(v * 10) / 10;
  const d = `M${r(p[0])} ${r(p[1])} C${r(p[2])} ${r(p[3])} ${r(p[4])} ${r(p[5])} ${r(p[6])} ${r(p[7])}`;
  const t = back ? 0.5 : 0.42;
  return { d, labelX: r(cubic(p[0], p[2], p[4], p[6], t)), labelY: r(cubic(p[1], p[3], p[5], p[7], t)) };
}

/** The box around every node (and the room a back edge swings out into), for fit-to-view. */
export function bounds(layout, sizes = {}) {
  const ids = Object.keys(layout);
  if (!ids.length) return { x: 0, y: 0, w: NODE_W, h: NODE_H };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const { x, y } = layout[id];
    const w = sizes[id]?.w ?? NODE_W, h = sizes[id]?.h ?? NODE_H;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return { x: minX - 100, y: minY - 20, w: maxX - minX + 140, h: maxY - minY + 40 };
}

/** The scale and offset that fit `box` into a viewport of `vw` × `vh`, never zoomed past 1. */
export function fitView(box, vw, vh, { pad = 32, max = 1, min = 0.2 } = {}) {
  const k = Math.max(min, Math.min(max, (vw - pad * 2) / box.w, (vh - pad * 2) / box.h));
  return { k, x: Math.round((vw - box.w * k) / 2 - box.x * k), y: Math.round((vh - box.h * k) / 2 - box.y * k) };
}
