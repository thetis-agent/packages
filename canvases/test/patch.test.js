// The one patch shape: frames, titles, pages and what a removed page leaves behind, the order, notes, props, launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "../lib/patch.js";
import { completeIndex } from "../lib/schema.js";

const base = () => completeIndex({ id: "c_00000001", title: "Flow", pages: [{ id: "m", name: "Mobile" }], boards: { "A.html": { x: 0, y: 0, w: 100, h: 100, page: "m", props: { accent: "#111" } }, "B.html": { x: 200, y: 0, w: 100, h: 100 }, "C.html": { x: 400, y: 0, w: 100, h: 100 } }, notes: { n1: { x: 0, y: -100, text: "row", kind: "title1", page: "m" } } });

test("frames, titles, page, expand, radius and props change per artboard; null drops a field or an override", () => {
  const { index, touched } = applyPatch(base(), { boards: { "A.html": { x: 10.4, y: -3, w: 390, h: 844, title: "Home", radius: 40, expand: "fill", props: { accent: null, dark: true, size: 3 } } } });
  assert.deepEqual(index.boards["A.html"], { x: 10, y: -3, w: 390, h: 844, page: "m", title: "Home", radius: 40, expand: "fill", props: { dark: true, size: 3 } });
  assert.deepEqual(touched, ["artboard A.html"]);
  const next = applyPatch(index, { boards: { "A.html": { title: null, radius: null, expand: null, page: null, props: { dark: null, size: null } } } }).index;
  assert.deepEqual(next.boards["A.html"], { x: 10, y: -3, w: 390, h: 844 }, "everything optional dropped, props gone when empty");
  assert.throws(() => applyPatch(base(), { boards: { "Z.html": { x: 1 } } }), /No artboard Z.html on this canvas; write it first with canvas_write_board/);
  assert.throws(() => applyPatch(base(), { boards: { "A.html": { page: "nope" } } }), /no page nope/);
  assert.throws(() => applyPatch(base(), { boards: { "A.html": { w: 4 } } }), /from 16 to 16384/);
  assert.throws(() => applyPatch(base(), { boards: { "A.html": { props: { "Bad-Key": 1 } } } }), /not a prop name/);
  assert.throws(() => applyPatch(base(), { boards: { "A.html": { expand: "grow" } } }), /expand is "fill" or null/);
});

test("order: the files named go to the front in that order; the rest keep theirs", () => {
  assert.deepEqual(applyPatch(base(), { order: ["A.html"] }).index.order, ["B.html", "C.html", "A.html"], "bring to front");
  assert.deepEqual(applyPatch(base(), { order: ["C.html", "A.html", "B.html"] }).index.order, ["C.html", "A.html", "B.html"], "a whole order");
  assert.deepEqual(applyPatch(base(), { order: ["B.html", "B.html"] }).index.order, ["A.html", "C.html", "B.html"]);
  assert.throws(() => applyPatch(base(), { order: ["Z.html"] }), /order names "Z.html", which is not an artboard here/);
});

test("pages replace whole, and an artboard or note on a page that went is on every page again", () => {
  const { index } = applyPatch(base(), { pages: [{ id: "d", name: "Desktop" }] });
  assert.deepEqual(index.pages, [{ id: "d", name: "Desktop" }]);
  assert.equal(index.boards["A.html"].page, undefined);
  assert.equal(index.notes.n1.page, undefined);
  assert.throws(() => applyPatch(base(), { pages: [{ id: "x", name: "" }] }), /needs a name/);
  assert.throws(() => applyPatch(base(), { pages: [{ id: "x", name: "a" }, { id: "x", name: "b" }] }), /listed twice/);
  assert.throws(() => applyPatch(base(), { pages: [{ id: "bad id", name: "a" }] }), /page's id is letters/);
});

test("notes: a new one needs x, y and text; an existing one changes; null deletes; the fields are checked", () => {
  const { index, touched } = applyPatch(base(), { notes: { n2: { x: 5, y: 6, text: "sticky", fill: "blue", w: 300 }, n1: { text: "Row one", bold: true } } });
  assert.deepEqual(index.notes.n2, { x: 5, y: 6, text: "sticky", fill: "blue", w: 300 });
  assert.deepEqual(index.notes.n1, { x: 0, y: -100, text: "Row one", kind: "title1", page: "m", bold: true });
  assert.deepEqual(touched, ["2 notes"]);
  const gone = applyPatch(index, { notes: { n1: null } }).index;
  assert.deepEqual(Object.keys(gone.notes), ["n2"]);
  assert.throws(() => applyPatch(base(), { notes: { n9: { text: "no place" } } }), /note n9 is new and needs x, y and text/);
  assert.throws(() => applyPatch(base(), { notes: { n1: { fill: "mauve" } } }), /fill is one of/);
  assert.throws(() => applyPatch(base(), { notes: { n1: { kind: "title9" } } }), /kind is "title1"/);
  assert.throws(() => applyPatch(base(), { notes: { "bad id": { x: 0, y: 0, text: "x" } } }), /not a note id/);
});

test("title and launch", () => {
  const { index } = applyPatch(base(), { title: "  Renamed ", launch: { view: "focused", file: "B.html" } });
  assert.equal(index.title, "Renamed");
  assert.deepEqual(index.launch, { view: "focused", file: "B.html" });
  assert.deepEqual(applyPatch(index, { launch: { view: "canvas" } }).index.launch, { view: "canvas" });
  assert.throws(() => applyPatch(base(), { title: "  " }), /title must be text, and not empty/);
  assert.throws(() => applyPatch(base(), { launch: { view: "focused", file: "Z.html" } }), /launch names "Z.html"/);
  assert.throws(() => applyPatch(base(), "nope"), /A layout patch is an object/);
});
