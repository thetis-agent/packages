// Where the notice corner sits: clear of the composer and the rail, so a card never covers the Send button
// or the rail's labels toggle. `clearance` is the pure half of the placement; the page feeds it the boxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./dom-fixture.js";

const { clearance } = await import("../assets/lib/notice.js");

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("a composer reaching under the corner lifts it above the composer; the rail on the right edge moves it left", () => {
  // 1440×900 with the rail: the composer's right end (the Send button) runs under the corner's column.
  const desk = clearance({ width: 1440, height: 900, rail: rect(1397, 0, 43, 900), composer: rect(498, 775, 672, 86), placeOpen: false, cornerWidth: 420 });
  assert.deepEqual(desk, { right: 59, bottom: 133 });
  // A narrow composer that ends left of the corner's column: the corner stays down in its corner.
  assert.deepEqual(clearance({ width: 1440, height: 900, rail: null, composer: rect(300, 775, 500, 86), placeOpen: false, cornerWidth: 420 }), { right: 16, bottom: 16 });
  // A place over the chat hides the composer: nothing to keep clear of.
  assert.deepEqual(clearance({ width: 1440, height: 900, rail: rect(1397, 0, 43, 900), composer: rect(498, 775, 672, 86), placeOpen: true, cornerWidth: 420 }), { right: 59, bottom: 16 });
  // A phone: no rail, the composer spans the width; the lift is capped at three fifths of the height.
  assert.deepEqual(clearance({ width: 390, height: 844, rail: null, composer: rect(16, 745, 358, 83), placeOpen: false, cornerWidth: 358 }), { right: 16, bottom: 107 });
  assert.equal(clearance({ width: 390, height: 844, rail: null, composer: rect(16, 100, 358, 700), placeOpen: false, cornerWidth: 358 }).bottom, Math.round(844 * 0.6));
});
