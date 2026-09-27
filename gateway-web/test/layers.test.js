// What Escape closes: the layer opened last. On a phone the drawer opened over a place goes before the
// place; a place opened over the dock goes before the dock; a floating menu or popover takes Escape for
// itself and the stack is left alone.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createLayers, listenForEscape } from "../assets/lib/layers.js";

function fakeDoc() {
  let listener = null;
  let own = null; // what querySelector finds: a menu, a picker, a popover
  return {
    addEventListener: (type, fn) => { if (type === "keydown") listener = fn; },
    querySelector: () => own,
    setOwn: (node) => { own = node; },
    press(key = "Escape", extra = {}) {
      const event = { key, defaultPrevented: false, isComposing: false, ...extra, preventDefault() { this.defaultPrevented = true; } };
      listener(event);
      return event;
    },
  };
}

test("escape closes the top layer first, one per press", () => {
  const layers = createLayers();
  const closed = [];
  layers.open("dock", () => closed.push("dock"));
  layers.open("place", () => closed.push("place"));
  layers.open("drawer", () => closed.push("drawer"));
  assert.equal(layers.top(), "drawer");
  assert.equal(layers.escape(), true);
  assert.deepEqual(closed, ["drawer"], "the drawer over the place goes first");
  layers.escape();
  assert.deepEqual(closed, ["drawer", "place"]);
  layers.escape();
  assert.deepEqual(closed, ["drawer", "place", "dock"]);
  assert.equal(layers.escape(), false, "nothing left: nothing happens");
});

test("a layer closed another way leaves the stack, and opening one again brings it to the top", () => {
  const layers = createLayers();
  const closed = [];
  layers.open("dock", () => closed.push("dock"));
  layers.open("place", () => closed.push("place"));
  layers.remove("place");      // its ✕
  layers.remove("never-open"); // ignored
  assert.deepEqual(layers.list(), ["dock"]);
  layers.open("drawer", () => closed.push("drawer"));
  layers.open("dock", () => closed.push("dock again"));
  assert.deepEqual(layers.list(), ["drawer", "dock"]);
  layers.escape();
  assert.deepEqual(closed, ["dock again"]);
});

test("the listener leaves Escape to an open menu or popover, and to a key already handled", () => {
  const layers = createLayers();
  const doc = fakeDoc();
  const closed = [];
  listenForEscape(doc, layers);
  layers.open("place", () => closed.push("place"));
  doc.setOwn({ className: "menu" });
  doc.press();
  assert.deepEqual(closed, [], "the menu closes itself; the place stays");
  doc.setOwn(null);
  doc.press("Escape", { defaultPrevented: true });
  assert.deepEqual(closed, [], "a rename box that took the key keeps it");
  doc.press("Enter");
  assert.deepEqual(closed, []);
  const event = doc.press();
  assert.deepEqual(closed, ["place"]);
  assert.equal(event.defaultPrevented, true);
});
