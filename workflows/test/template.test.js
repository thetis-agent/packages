import { test } from "node:test";
import assert from "node:assert/strict";
import { fill, fillDeep, holes, scopeOf } from "../lib/template.js";

const run = { id: "r_0a1b2c3d4e", number: 12, input: "https://notion.so/bug", vars: { plan: { text: "the plan", cost: 1.5 }, verdict: { result: "PASS" } } };

test("fill renders input, run fields and step values", () => {
  const scope = scopeOf(run);
  assert.equal(fill("Bug {{input}} (#{{run.number}}, {{ run.id }})", scope), "Bug https://notion.so/bug (#12, r_0a1b2c3d4e)");
  assert.equal(fill("{{plan.text}} / {{verdict.result}} / {{plan.cost}}", scope), "the plan / PASS / 1.5");
});

test("a hole that names nothing renders as an empty string", () => {
  assert.equal(fill("[{{nope.text}}][{{plan.missing}}][{{input.deeper}}]", scopeOf(run)), "[][][]");
});

test("text that is not a hole is left alone", () => {
  assert.equal(fill("{{ not a path }} {x} {{}}", scopeOf(run)), "{{ not a path }} {x} {{}}");
  assert.equal(fill(undefined, {}), "");
});

test("objects render as JSON", () => {
  assert.equal(fill("{{plan}}", scopeOf(run)), JSON.stringify(run.vars.plan));
});

test("holes lists each path once, in order", () => {
  assert.deepEqual(holes("{{a.b}} {{input}} {{a.b}} {{run.id}}"), ["a.b", "input", "run.id"]);
  assert.deepEqual(holes(42), []);
});

test("fillDeep fills the strings of a nested args object and keeps other values", () => {
  const out = fillDeep({ url: "{{input}}", opts: { n: 3, tags: ["{{verdict.result}}", true] } }, scopeOf(run));
  assert.deepEqual(out, { url: "https://notion.so/bug", opts: { n: 3, tags: ["PASS", true] } });
});

test("a step id cannot shadow input or run in the scope", () => {
  const scope = scopeOf({ ...run, vars: { input: { text: "x" }, run: { id: "y" } } });
  assert.equal(fill("{{input}} {{run.id}}", scope), "https://notion.so/bug r_0a1b2c3d4e");
});
