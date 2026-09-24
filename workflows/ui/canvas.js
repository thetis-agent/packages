/* The graph canvas, shared by the editor and the run view. A world layer is moved and scaled by one CSS
 * transform; the nodes are absolutely placed elements in it, the edges one SVG under them, measured from
 * the nodes' real sizes after each draw. In the editor a node drags (its new position goes to `onMove`),
 * the dot at its foot drags out a connection (`onConnect`), the background pans, the wheel zooms around
 * the pointer, and a palette entry dropped here calls `onDrop`. The run view passes `readOnly` and gets the
 * same graph with panning, zoom and selection only. The canvas never edits the definition itself. */

import { NODE_H, NODE_W, bounds, completeLayout, edgeGeometry, edges as edgesOf, fitView } from "./graph.js";
import { svgIcon } from "./icons.js";
import { TYPES } from "./steps.js";

export const DRAG_MIME = "application/x-thetis-workflow-step";
const SVG = "http://www.w3.org/2000/svg";
const MIN_K = 0.25;
const MAX_K = 1.6;
let counter = 0; // marker ids must be unique on the page

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
}

/**
 * `options`: `readOnly`, `label` (the region's accessible name), `decorate(id, step)` → `{ classes, sub,
 * chip, meta, badge }` for what a node shows beyond its icon, label and type, `edgeClass(edge)` → extra
 * classes, `onSelect(id|null)`, `onMove(id, {x, y})`, `onConnect(from, to, {clientX, clientY})`,
 * `onDrop(type, {x, y})`, `onDelete(id)`, and `tools` (extra controls for the zoom bar).
 */
export function createCanvas(ext, options) {
  const { el } = ext.dom;
  const uid = `c${++counter}`;
  const o = { readOnly: false, decorate: () => ({}), edgeClass: () => "", ...options };
  const view = { x: 40, y: 40, k: 1 };
  let def = { steps: {} };
  let layout = {};
  let selected = null;
  let sizes = {};
  let nodes = new Map();
  let fitted = false;

  const markers = svgEl("defs");
  for (const name of ["base", "back", "taken", "hot"]) {
    const m = svgEl("marker", { id: `wf-arrow-${name}-${uid}`, viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", class: `wf-arrowhead is-${name}` });
    m.append(svgEl("path", { d: "M0 0L8 4L0 8z" }));
    markers.append(m);
  }
  const edgeSvg = svgEl("svg", { class: "wf-edges", width: "1", height: "1", "aria-hidden": "true" });
  edgeSvg.append(markers);
  const edgeGroup = svgEl("g");
  const preview = svgEl("path", { class: "wf-edge is-preview", d: "" });
  edgeSvg.append(edgeGroup, preview);
  const labels = el("div", { class: "wf-edge-labels", "aria-hidden": "true" });
  const nodeLayer = el("div", { class: "wf-nodes" });
  const world = el("div", { class: "wf-world" }, edgeSvg, labels, nodeLayer);
  const zoomText = el("span", { class: "wf-zoom-text", "aria-live": "off" }, "100%");
  const iconBtn = (name, label, onClick) => el("button", { type: "button", class: "wf-icon-btn", "aria-label": label, title: label, onClick }, svgIcon(name, { size: 14 }));
  const zoomBar = el(
    "div",
    { class: "wf-zoom", role: "toolbar", "aria-label": "Canvas view" },
    iconBtn("minus", "Zoom out", () => zoomBy(1 / 1.2)),
    zoomText,
    iconBtn("plus", "Zoom in", () => zoomBy(1.2)),
    el("span", { class: "wf-zoom-rule" }),
    iconBtn("fit", "Fit to view", () => fit()),
    ...(o.tools ?? [])
  );
  const empty = el("div", { class: "wf-canvas-empty", hidden: true });
  const root = el("div", { class: `wf-canvas${o.readOnly ? " is-readonly" : ""}`, role: "region", "aria-label": o.label ?? "Workflow graph" }, world, empty, zoomBar);

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    root.style.backgroundPosition = `${view.x}px ${view.y}px`;
    root.style.backgroundSize = `${20 * view.k}px ${20 * view.k}px`;
    zoomText.textContent = `${Math.round(view.k * 100)}%`;
  }

  function zoomAt(k, px, py) {
    const nk = Math.max(MIN_K, Math.min(MAX_K, k));
    view.x = px - ((px - view.x) * nk) / view.k;
    view.y = py - ((py - view.y) * nk) / view.k;
    view.k = nk;
    applyView();
  }

  function zoomBy(f) {
    zoomAt(view.k * f, root.clientWidth / 2, root.clientHeight / 2);
  }

  function fit() {
    if (!root.clientWidth) return;
    const box = bounds(layout, sizes);
    Object.assign(view, fitView(box, root.clientWidth, root.clientHeight - 44));
    applyView();
  }

  /** Pans so a node sits in the middle of the view. */
  function center(id) {
    const p = layout[id];
    if (!p || !root.clientWidth) return;
    const s = sizes[id] ?? { w: NODE_W, h: NODE_H };
    view.x = root.clientWidth / 2 - (p.x + s.w / 2) * view.k;
    view.y = root.clientHeight / 2 - (p.y + s.h / 2) * view.k;
    applyView();
  }

  /** Pans to a node only when it is not already in view. */
  function reveal(id) {
    const p = layout[id];
    if (!p || !root.clientWidth) return;
    const s = sizes[id] ?? { w: NODE_W, h: NODE_H };
    const x = view.x + p.x * view.k, y = view.y + p.y * view.k;
    if (x < 0 || y < 0 || x + s.w * view.k > root.clientWidth || y + s.h * view.k > root.clientHeight - 48) center(id);
  }

  /** A client point in world coordinates. */
  function worldAt(clientX, clientY) {
    const r = root.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  }

  function box(id) {
    const p = layout[id];
    const s = sizes[id] ?? { w: NODE_W, h: NODE_H };
    return { x: p.x, y: p.y, w: s.w, h: s.h };
  }

  function drawNode(id, step) {
    const meta = TYPES[step?.type] ?? { label: step?.type ?? "unknown", tone: "dim" };
    const d = o.decorate(id, step) ?? {};
    const classes = ["wf-node", `tone-${meta.tone}`, ...(d.classes ?? [])];
    if (id === selected) classes.push("is-selected");
    if (id === def.start) classes.push("is-start");
    const label = step?.label || id;
    const node = el(
      "div",
      {
        class: classes.join(" "),
        role: "button",
        tabindex: "0",
        "data-step": id,
        "aria-pressed": id === selected ? "true" : "false",
        "aria-label": `${label}, ${meta.label}${id === def.start ? ", start step" : ""}${d.status ? `, ${d.status}` : ""}`,
      },
      id === def.start ? el("span", { class: "wf-start-tag" }, svgIcon("flag", { size: 10 }), "start") : null,
      el(
        "span",
        { class: "wf-node-head" },
        el("span", { class: "wf-node-icon" }, svgIcon(step?.type, { size: 13 })),
        el("span", { class: "wf-node-names" }, el("span", { class: "wf-node-label" }, label), d.sub || label !== id ? el("span", { class: "wf-node-sub" }, d.sub || id) : null),
        el("span", { class: "wf-node-type" }, d.badge ?? step?.type ?? "")
      ),
      d.chip ? el("span", { class: "wf-node-chip" }, d.chip) : null,
      d.meta ? el("span", { class: "wf-node-meta" }, d.meta) : null
    );
    node.style.left = `${layout[id].x}px`;
    node.style.top = `${layout[id].y}px`;
    if (!o.readOnly) {
      if (id === selected && o.onDelete) {
        node.append(el("button", { type: "button", class: "wf-node-del", "aria-label": `Delete step ${id}`, title: "Delete step (Delete)", onClick: (e) => { e.stopPropagation(); o.onDelete(id); } }, svgIcon("x", { size: 11, width: 2 })));
      }
      if (FLOWS(step)) node.append(el("span", { class: "wf-handle", "data-handle": id, title: "Drag to another step to connect", "aria-hidden": "true" }));
    }
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        o.onSelect?.(id);
      }
    });
    return node;
  }

  const FLOWS = (step) => step && step.type !== "done" && step.type !== "needs";

  function drawEdges() {
    edgeGroup.replaceChildren();
    labels.replaceChildren();
    const list = edgesOf(def);
    const forwardBySource = new Map();
    for (const e of list) if (!e.back) (forwardBySource.get(e.from) ?? forwardBySource.set(e.from, []).get(e.from)).push(e);
    let lane = 0;
    for (const e of list) {
      if (!layout[e.from] || !layout[e.to]) continue;
      const siblings = forwardBySource.get(e.from) ?? [e];
      const g = edgeGeometry(box(e.from), box(e.to), e.back ? { back: true, lane: lane++ } : { index: siblings.indexOf(e), count: siblings.length });
      const extra = o.edgeClass(e) || "";
      const hot = selected && (e.from === selected || e.to === selected);
      const kind = extra.includes("is-taken") ? "taken" : e.back ? "back" : hot ? "hot" : "base";
      edgeGroup.append(svgEl("path", { class: `wf-edge${e.back ? " is-back" : ""}${hot ? " is-hot" : ""} ${extra}`.trim(), d: g.d, "marker-end": `url(#wf-arrow-${kind}-${uid})` }));
      const text = e.field === "target" ? `loop · max ${def.steps[e.from]?.max ?? "?"}` : e.label;
      if (text) {
        const tag = el("span", { class: `wf-edge-label${e.back ? " is-back" : ""}${hot ? " is-hot" : ""} ${extra}`.trim() }, e.field === "target" ? svgIcon("loop", { size: 10 }) : null, text);
        tag.style.left = `${g.labelX}px`;
        tag.style.top = `${g.labelY}px`;
        labels.append(tag);
      }
    }
  }

  function measure() {
    sizes = {};
    for (const [id, node] of nodes) if (node.offsetWidth) sizes[id] = { w: node.offsetWidth, h: node.offsetHeight };
  }

  /** Draws `next.def` (with `next.selected`); keeps the view unless it has never been fitted. */
  function render(next) {
    def = next.def ?? def;
    selected = next.selected ?? null;
    layout = completeLayout(def);
    nodes = new Map();
    const els = [];
    for (const [id, step] of Object.entries(def.steps ?? {})) {
      const n = drawNode(id, step);
      nodes.set(id, n);
      els.push(n);
    }
    nodeLayer.replaceChildren(...els);
    empty.hidden = els.length > 0;
    empty.textContent = o.readOnly ? "This definition has no steps." : "Drag a step from the palette, or click one, to start.";
    measure();
    drawEdges();
    if (!fitted && root.clientWidth && els.length) {
      fitted = true;
      fit();
    }
    applyView();
  }

  /** The layout the canvas is drawing, including positions it made up for unplaced steps. */
  const currentLayout = () => layout;

  /* --- pointer: pan, drag, connect ----------------------------------------------------------- */

  let gesture = null; // { kind: "pan"|"node"|"connect", id, sx, sy, moved, ox, oy }

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".wf-zoom, .wf-node-del")) return;
    const handle = e.target.closest("[data-handle]");
    const node = e.target.closest(".wf-node");
    if (handle && !o.readOnly) {
      gesture = { kind: "connect", id: handle.dataset.handle, sx: e.clientX, sy: e.clientY, moved: false };
    } else if (node) {
      const id = node.dataset.step;
      gesture = { kind: "node", id, sx: e.clientX, sy: e.clientY, moved: false, ox: layout[id].x, oy: layout[id].y };
    } else {
      gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, moved: false, ox: view.x, oy: view.y };
      root.classList.add("is-panning");
    }
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  root.addEventListener("pointermove", (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    if (gesture.kind === "pan") {
      view.x = gesture.ox + dx;
      view.y = gesture.oy + dy;
      applyView();
    } else if (gesture.kind === "node" && !o.readOnly) {
      const p = { x: Math.round(gesture.ox + dx / view.k), y: Math.round(gesture.oy + dy / view.k) };
      layout[gesture.id] = p;
      const n = nodes.get(gesture.id);
      n.style.left = `${p.x}px`;
      n.style.top = `${p.y}px`;
      n.classList.add("is-dragging");
      drawEdges();
    } else if (gesture.kind === "connect") {
      const from = box(gesture.id);
      const to = worldAt(e.clientX, e.clientY);
      const g = edgeGeometry(from, { x: to.x, y: to.y, w: 0, h: 0 });
      preview.setAttribute("d", g.d);
      for (const n of nodes.values()) n.classList.remove("is-target");
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".wf-node");
      if (over && over.dataset.step !== gesture.id) over.classList.add("is-target");
    }
  });

  function endGesture(e, cancelled) {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    root.classList.remove("is-panning");
    preview.setAttribute("d", "");
    for (const n of nodes.values()) n.classList.remove("is-target", "is-dragging");
    if (cancelled) return;
    if (g.kind === "pan" && !g.moved) o.onSelect?.(null);
    else if (g.kind === "node") {
      if (g.moved && !o.readOnly) o.onMove?.(g.id, layout[g.id]);
      else {
        o.onSelect?.(g.id);
        nodes.get(g.id)?.focus({ preventScroll: true });
      }
    } else if (g.kind === "connect" && g.moved) {
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".wf-node");
      if (over && over.dataset.step !== g.id) o.onConnect?.(g.id, over.dataset.step, { clientX: e.clientX, clientY: e.clientY });
    }
  }
  root.addEventListener("pointerup", (e) => endGesture(e, false));
  root.addEventListener("pointercancel", (e) => endGesture(e, true));

  root.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = root.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(view.k * Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );

  if (!o.readOnly) {
    root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      root.classList.add("is-dropping");
    });
    root.addEventListener("dragleave", (e) => {
      if (e.target === root) root.classList.remove("is-dropping");
    });
    root.addEventListener("drop", (e) => {
      root.classList.remove("is-dropping");
      const type = e.dataTransfer?.getData(DRAG_MIME);
      if (!type) return;
      e.preventDefault();
      const p = worldAt(e.clientX, e.clientY);
      o.onDrop?.(type, { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - 24) });
    });
  }

  // The first draw may happen before the place is laid out; fit once it has a size.
  const resize = new ResizeObserver(() => {
    if (!fitted && root.clientWidth && nodes.size) {
      measure();
      drawEdges();
      fitted = true;
      fit();
    }
  });
  resize.observe(root);

  applyView();
  return {
    node: root,
    render,
    fit,
    center,
    reveal,
    zoomBy,
    worldAt,
    layout: currentLayout,
    /** Where a new step should go: the middle of what is on screen. */
    viewCenter: () => worldAt(root.getBoundingClientRect().left + root.clientWidth / 2, root.getBoundingClientRect().top + root.clientHeight / 2),
    focusNode: (id) => nodes.get(id)?.focus({ preventScroll: true }),
    destroy: () => resize.disconnect(),
  };
}
