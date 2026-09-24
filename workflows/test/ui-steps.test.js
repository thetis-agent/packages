import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetLine, compact, freshId, fromList, newStep, nodeSummary, removeStep, renameStep, savedFields, setFrom, STEP_ID } from "../ui/steps.js";
import { sample } from "./ui-fixture.js";

test("freshId picks the type name, then numbered ids that match the step id rule", () => {
  const def = sample();
  assert.equal(freshId(def, "approval"), "approval");
  assert.equal(freshId(def, "loop"), "loop_2");
  def.steps.loop_2 = { type: "loop" };
  assert.equal(freshId(def, "loop"), "loop_3");
  assert.match(freshId(def, "parse"), STEP_ID);
});

test("newStep gives each type the fields it needs", () => {
  assert.deepEqual(newStep("prompt", { defaultModel: "m" }), { type: "prompt", model: "m", conversation: "new", prompt: "" });
  assert.equal(newStep("loop").max, 1);
  assert.throws(() => newStep("nope"));
});

test("savedFields follows the README's saves-as column, parse fields included", () => {
  const def = sample();
  assert.deepEqual(savedFields(def.steps.plan), ["text", "conversation", "cost", "toolCalls", "tokens", "ms"]);
  assert.deepEqual(savedFields(def.steps.parse), ["status", "commit", "matched", "text", "source"]);
  assert.deepEqual(savedFields(def.steps.done), []);
});

test("parse.from is read as a list and written back as a string or a list", () => {
  const step = { type: "parse", from: "a" };
  assert.deepEqual(fromList(step), ["a"]);
  setFrom(step, ["a", "b", "a"]);
  assert.deepEqual(step.from, ["a", "b"]);
  setFrom(step, ["b"]);
  assert.equal(step.from, "b");
  setFrom(step, []);
  assert.equal("from" in step, false);
});

test("removeStep clears every reference to the removed step", () => {
  const def = sample();
  def.layout.plan = { x: 1, y: 2 };
  removeStep(def, "plan");
  assert.equal(def.steps.plan, undefined);
  assert.equal(def.layout.plan, undefined);
  assert.equal(def.steps.lookup.next, undefined);
  assert.equal(def.steps.impl.conversation, "new");
  assert.equal(def.steps.parse.from, "impl");
  removeStep(def, "needs");
  assert.deepEqual(def.steps.branch.cases, { FIXED: "verify" });
  assert.equal(def.steps.branch.default, undefined);
  assert.equal(def.steps.impl.onBreach, undefined);
  removeStep(def, "lookup");
  assert.equal(def.start, "");
});

test("renameStep moves the key, the references, the layout and the template holes", () => {
  const def = sample();
  def.layout.parse = { x: 5, y: 6 };
  assert.equal(renameStep(def, "parse", "result"), null);
  assert.ok(def.steps.result && !def.steps.parse);
  assert.deepEqual(def.layout.result, { x: 5, y: 6 });
  assert.equal(def.steps.impl.next, "result");
  assert.equal(def.steps.branch.on, "{{result.status}}");
  assert.equal(def.steps.verify.prompt, "Verify {{result.commit}}");
  assert.equal(renameStep(def, "plan", "first"), null);
  assert.equal(def.steps.impl.conversation, "first");
  assert.deepEqual(def.steps.result.from, ["impl", "first"]);
  assert.equal(def.steps.lookup.next, "first");
  assert.equal(renameStep(def, "lookup", "start"), null);
  assert.equal(def.start, "start");
  assert.match(renameStep(def, "impl", "Bad Id"), /lowercase/);
  assert.match(renameStep(def, "impl", "verify"), /already/);
});

test("budget lines and node summaries", () => {
  assert.equal(budgetLine({ toolCalls: 60, tokens: 250000, minutes: 45 }), "60 calls · 250k tok · 45 min");
  assert.equal(budgetLine(undefined), "");
  assert.equal(compact(1500), "1.5k");
  assert.equal(compact(1200000), "1.2M");
  const def = sample();
  assert.equal(nodeSummary(def.steps.parse, def), "status · commit");
  assert.equal(nodeSummary(def.steps.branch, def), "on parse.status");
  assert.equal(nodeSummary(def.steps.loop, def), "to impl · max 1");
});
