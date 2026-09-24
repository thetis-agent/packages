import assert from "node:assert/strict";
import { test } from "node:test";
import { autoLayout, bounds, completeLayout, edgeGeometry, edges, fitView } from "../ui/graph.js";
import { sample } from "./ui-fixture.js";

test("edges come from every outgoing field and each case, labelled, without data references", () => {
  const list = edges(sample());
  const keys = list.map((e) => `${e.from}:${e.field}>${e.to}`);
  assert.ok(keys.includes("lookup:next>plan"));
  assert.ok(keys.includes("impl:onBreach>needs"));
  assert.ok(keys.includes("branch:cases.FIXED>verify"));
  assert.ok(keys.includes("branch:default>needs"));
  assert.ok(keys.includes("loop:target>impl"));
  assert.ok(keys.includes("loop:exhausted>needs"));
  assert.ok(!list.some((e) => e.field === "from" || e.field === "conversation"));
  assert.equal(list.find((e) => e.field === "next").label, "");
  assert.equal(list.find((e) => e.field === "cases.FIXED").label, "FIXED");
  // A branch's cases come before its default, so the default is drawn last.
  const branch = list.filter((e) => e.from === "branch").map((e) => e.field);
  assert.deepEqual(branch, ["cases.FIXED", "cases.BLOCKED", "default"]);
});

test("edges to missing steps are left out, and loop-backs are marked back", () => {
  const def = sample();
  def.steps.verify.next = "gone";
  def.steps.done.next = "lookup"; // an end step's stray field is not an edge
  const list = edges(def);
  assert.ok(!list.some((e) => e.to === "gone"));
  assert.equal(list.find((e) => e.field === "target").back, true);
  assert.equal(list.find((e) => e.key === "lookup:next").back, false);
  const cyc = { start: "a", steps: { a: { type: "prompt", next: "b" }, b: { type: "approval", next: "a" } } };
  assert.deepEqual(edges(cyc).map((e) => e.back), [false, true]);
});

test("autoLayout layers top-down from start and puts every step somewhere distinct", () => {
  const def = sample();
  const lay = autoLayout(def);
  assert.equal(Object.keys(lay).length, Object.keys(def.steps).length);
  assert.equal(lay.lookup.y, 0);
  assert.ok(lay.plan.y > lay.lookup.y);
  assert.ok(lay.impl.y > lay.plan.y);
  assert.ok(lay.loop.y > lay.impl.y, "a loop-back does not pull its source above its target");
  const spots = new Set(Object.values(lay).map((p) => `${p.x},${p.y}`));
  assert.equal(spots.size, Object.keys(lay).length);
  assert.deepEqual(autoLayout({ steps: {} }), {});
});

test("completeLayout keeps placed steps and places the rest without overlap", () => {
  const def = sample();
  def.layout = { lookup: { x: 0, y: 0 }, plan: { x: 0, y: 140 } };
  const lay = completeLayout(def);
  assert.deepEqual(lay.lookup, { x: 0, y: 0 });
  assert.deepEqual(lay.plan, { x: 0, y: 140 });
  for (const id of Object.keys(def.steps)) assert.ok(lay[id], id);
  const ids = Object.keys(lay);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = lay[ids[i]], b = lay[ids[j]];
      assert.ok(Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 64, `${ids[i]} and ${ids[j]} overlap`);
    }
  def.layout = { lookup: { x: "no", y: 1 } };
  assert.ok(Number.isFinite(completeLayout(def).lookup.x));
});

test("edge geometry: forward edges leave the bottom and enter the top; back edges swing left", () => {
  const a = { x: 0, y: 0, w: 200, h: 60 }, b = { x: 0, y: 200, w: 200, h: 60 };
  const f = edgeGeometry(a, b);
  assert.match(f.d, /^M100 60 C/);
  assert.match(f.d, /100 200$/);
  const two = edgeGeometry(a, b, { index: 1, count: 2 });
  assert.match(two.d, /^M133\.3 60/);
  const back = edgeGeometry(b, a, { back: true });
  assert.match(back.d, /^M0 230 C-70 230 -70 30 0 30$/);
  assert.equal(back.labelX, -52.5);
});

test("bounds and fitView frame the graph", () => {
  const box = bounds({ a: { x: 0, y: 0 }, b: { x: 300, y: 200 } }, { a: { w: 220, h: 60 }, b: { w: 220, h: 80 } });
  assert.deepEqual(box, { x: -100, y: -20, w: 660, h: 320 });
  const v = fitView(box, 1000, 600);
  assert.ok(v.k <= 1 && v.k > 0);
  const small = fitView(box, 330, 200);
  assert.ok(small.k < 0.5);
});
