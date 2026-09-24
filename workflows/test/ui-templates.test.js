import assert from "node:assert/strict";
import { test } from "node:test";
import { holes, insertHole, templateVariables, testParse } from "../ui/templates.js";
import { sample } from "./ui-fixture.js";

test("the variable list is the run's own, then what every other step saves", () => {
  const paths = templateVariables(sample(), "verify").map((v) => v.path);
  assert.deepEqual(paths.slice(0, 3), ["input", "run.id", "run.number"]);
  for (const p of ["plan.text", "plan.conversation", "lookup.text", "lookup.error", "parse.status", "parse.commit", "parse.matched", "parse.text", "parse.source", "branch.value", "loop.count"]) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => p.startsWith("verify.")), "a step's own values are not offered to itself");
  assert.ok(!paths.some((p) => p.startsWith("done.") || p.startsWith("needs.")));
});

test("insertHole puts {{path}} at the selection and says where the caret goes", () => {
  assert.deepEqual(insertHole("ab", 1, 1, "input"), { text: "a{{input}}b", caret: 10 });
  assert.deepEqual(insertHole("abcd", 1, 3, "x.y"), { text: "a{{x.y}}d", caret: 8 });
  assert.equal(insertHole("ab", undefined, undefined, "input").text, "ab{{input}}");
});

test("holes lists a template's paths, trimmed and without repeats", () => {
  assert.deepEqual(holes("{{ input }} and {{plan.text}} {{input}}"), ["input", "plan.text"]);
  assert.deepEqual(holes("no holes { here }"), []);
});

test("testParse applies the engine's rules: flag m, first group else the whole match", () => {
  const out = testParse({ status: "^RESULT: (\\w+)", whole: "commit=\\S+", miss: "VERDICT", bad: "(" }, "x\nRESULT: FIXED commit=438892f");
  assert.deepEqual(out[0], { name: "status", ok: true, value: "FIXED" });
  assert.deepEqual(out[1], { name: "whole", ok: true, value: "commit=438892f" });
  assert.deepEqual(out[2], { name: "miss", ok: false });
  assert.equal(out[3].ok, false);
  assert.ok(out[3].error);
});
