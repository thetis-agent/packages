/* The maths of the board, free of the DOM so the tools use it too: where a new artboard goes, what box
 * everything on a page fills, how to fit that box in a viewport, how to zoom around a point, and how a
 * handle drag changes a frame. Coordinates are the canvas's own (CSS px at zoom 1); a view is
 * `{ x, y, k }`: the world's translation on screen and its scale. */

export const MIN_K = 0.05;
export const MAX_K = 4;
export const GAP = 80;
export const ROW_GAP = 120;
const NOTE_W = 240;
const NOTE_H = 160;
const TITLE_W = 600;
const TITLE_H = 90;

/** Whether an item with `page` shows on the page `pageId`: everything on "All" (null), else the page's own and the unpaged. */
export const onPage = (item, pageId) => pageId === null || pageId === undefined || item.page === undefined || item.page === pageId;

/** The box of one note as the board draws it, from its fields. */
export function noteBox(n) {
  if (n.kind === "title1") return { x: n.x, y: n.y, w: n.maxW ?? TITLE_W, h: n.maxH ?? TITLE_H };
  const w = n.w ?? NOTE_W;
  return { x: n.x, y: n.y, w, h: n.maxH ?? Math.round((w * 4) / 3) > NOTE_H ? Math.round((w * 4) / 3) : NOTE_H };
}

/** The box around every artboard and note on the page, or null when there is nothing on it. `sizes` may give a frame's rendered height. */
export function boundsOf(index, pageId = null, sizes = {}) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const take = (b) => {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  };
  for (const [file, b] of Object.entries(index.boards)) if (onPage(b, pageId)) take({ ...b, h: Math.max(b.h, sizes[file] ?? 0) });
  for (const n of Object.values(index.notes)) if (onPage(n, pageId)) take(noteBox(n));
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The view that shows `box` whole in a viewport of `vw`×`vh`, padded, centred; zoom 1 at most unless asked. */
export function fitView(box, vw, vh, { pad = 48, min = MIN_K, max = 1 } = {}) {
  if (!box || vw <= 0 || vh <= 0) return { x: 0, y: 0, k: 1 };
  const k = Math.min(max, Math.max(min, Math.min((vw - pad * 2) / Math.max(1, box.w), (vh - pad * 2) / Math.max(1, box.h))));
  return { x: Math.round((vw - box.w * k) / 2 - box.x * k), y: Math.round((vh - box.h * k) / 2 - box.y * k), k };
}

/** The view at scale `k` with the screen point `(px, py)` over the same canvas point as before. */
export function zoomAt(view, k, px, py, min = MIN_K, max = MAX_K) {
  const next = Math.min(max, Math.max(min, k));
  const ratio = next / view.k;
  return { x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio, k: next };
}

/** Canvas coordinates of a screen point under `view`. */
export const toCanvas = (view, px, py) => ({ x: (px - view.x) / view.k, y: (py - view.y) / view.k });

/** Where a new artboard of `w`×`h` goes on the page: at the origin when the page is empty, else right of the rightmost artboard, level with it. */
export function autoPlace(index, pageId, w, h, gap = GAP) {
  let rightmost = null;
  for (const b of Object.values(index.boards)) if (onPage(b, pageId) && (!rightmost || b.x + b.w > rightmost.x + rightmost.w)) rightmost = b;
  if (!rightmost) {
    const notes = Object.values(index.notes).filter((n) => onPage(n, pageId));
    if (!notes.length) return { x: 0, y: 0 };
    const box = boundsOf({ boards: {}, notes: Object.fromEntries(notes.map((n, i) => [String(i), n])) }, pageId);
    return { x: box.x, y: box.y + box.h + gap };
  }
  return { x: rightmost.x + rightmost.w + gap, y: rightmost.y };
}

export const snap = (v, grid = 8) => Math.round(v / grid) * grid;

/** A frame `box` after dragging its `dir` handle (n, s, e, w, ne, nw, se, sw) by `dx`, `dy`, no side under `min`. */
export function resizeBox(box, dir, dx, dy, min = 64) {
  let { x, y, w, h } = box;
  if (dir.includes("e")) w = Math.max(min, w + dx);
  if (dir.includes("s")) h = Math.max(min, h + dy);
  if (dir.includes("w")) {
    const nw = Math.max(min, w - dx);
    x += w - nw;
    w = nw;
  }
  if (dir.includes("n")) {
    const nh = Math.max(min, h - dy);
    y += h - nh;
    h = nh;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
