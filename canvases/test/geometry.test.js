// The board's maths, pure: fitting, zooming about a point, bounds per page, auto-placement, resizing by handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPlace, boundsOf, fitView, onPage, resizeBox, snap, toCanvas, zoomAt } from "../ui/geometry.js";

const index = {
  boards: { "A.html": { x: 0, y: 0, w: 100, h: 200 }, "B.html": { x: 300, y: 50, w: 100, h: 100, page: "m" }, "C.html": { x: -50, y: 400, w: 100, h: 100, page: "d" } },
  notes: { n1: { x: 600, y: 0, text: "t", kind: "title1" }, n2: { x: 0, y: -300, text: "s", w: 100, page: "m" } },
};

test("onPage and boundsOf: everything on All; a page's own and the unpaged on a page; nothing is null", () => {
  assert.ok(onPage({ page: "m" }, null) && onPage({}, "m") && onPage({ page: "m" }, "m") && !onPage({ page: "d" }, "m"));
  assert.deepEqual(boundsOf(index), { x: -50, y: -300, w: 1250, h: 800 });
  assert.deepEqual(boundsOf(index, "m"), { x: 0, y: -300, w: 1200, h: 500 });
  assert.deepEqual(boundsOf(index, "d"), { x: -50, y: 0, w: 1250, h: 500 });
  assert.equal(boundsOf({ boards: {}, notes: {} }), null);
  assert.deepEqual(boundsOf({ boards: { "A.html": { x: 0, y: 0, w: 100, h: 100 } }, notes: {} }, null, { "A.html": 500 }), { x: 0, y: 0, w: 100, h: 500 }, "a frame that grew to its document counts as tall as it is");
});

test("fitView centres the box at the largest scale that fits, never above 1 unless allowed; zoomAt keeps the cursor's point still", () => {
  const view = fitView({ x: 0, y: 0, w: 1000, h: 500 }, 1000, 500, { pad: 0 });
  assert.deepEqual(view, { x: 0, y: 0, k: 1 });
  const small = fitView({ x: 100, y: 100, w: 200, h: 100 }, 1000, 500, { pad: 0 });
  assert.equal(small.k, 1, "a small box is not blown up");
  assert.deepEqual(small, { x: 300, y: 100, k: 1 });
  const big = fitView({ x: 0, y: 0, w: 4000, h: 1000 }, 1000, 500, { pad: 0 });
  assert.equal(big.k, 0.25);
  assert.deepEqual(fitView(null, 100, 100), { x: 0, y: 0, k: 1 });
  const before = { x: 20, y: 30, k: 1 };
  const at = toCanvas(before, 120, 130);
  const after = zoomAt(before, 2, 120, 130);
  assert.equal(after.k, 2);
  assert.deepEqual(toCanvas(after, 120, 130), at);
  assert.equal(zoomAt(before, 99, 0, 0).k, 4, "clamped to the maximum");
  assert.equal(zoomAt(before, 0.001, 0, 0).k, 0.05, "and the minimum");
});

test("autoPlace: the origin on an empty page, else right of the rightmost artboard on that page, level with it; under the notes when there are only notes", () => {
  assert.deepEqual(autoPlace({ boards: {}, notes: {} }, null, 100, 100), { x: 0, y: 0 });
  assert.deepEqual(autoPlace(index, null, 100, 100), { x: 480, y: 50 });
  assert.deepEqual(autoPlace(index, "m", 100, 100), { x: 480, y: 50 });
  assert.deepEqual(autoPlace(index, "d", 100, 100), { x: 180, y: 0 }, "on page d: A (unpaged) and C; A is rightmost");
  assert.deepEqual(autoPlace({ boards: {}, notes: { n: { x: 10, y: 20, text: "t", kind: "title1" } } }, null, 100, 100), { x: 10, y: 20 + 90 + 80 });
  assert.equal(snap(13), 16);
  assert.equal(snap(11, 10), 10);
});

test("resizeBox by every handle, never under the minimum", () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(resizeBox(box, "se", 10, 20), { x: 100, y: 100, w: 210, h: 120 });
  assert.deepEqual(resizeBox(box, "nw", 10, 20), { x: 110, y: 120, w: 190, h: 80 });
  assert.deepEqual(resizeBox(box, "e", -500, 0), { x: 100, y: 100, w: 64, h: 100 });
  assert.deepEqual(resizeBox(box, "n", 0, 500), { x: 100, y: 136, w: 200, h: 64 }, "the top edge stops where the minimum height is");
  assert.deepEqual(resizeBox(box, "w", -10, 0), { x: 90, y: 100, w: 210, h: 100 });
  assert.deepEqual(resizeBox(box, "s", 0, 5), { x: 100, y: 100, w: 200, h: 105 });
});
