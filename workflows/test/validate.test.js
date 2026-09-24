import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, edges } from "../lib/validate.js";
import { blank, normalise } from "../lib/definition.js";

const good = () => ({
  id: "wf_1a2b3c4d",
  name: "Fix",
  version: 1,
  start: "plan",
  steps: {
    plan: { type: "prompt", model: "fable", conversation: "new", title: "Fix {{input}}", prompt: "Plan {{input}}", budget: { toolCalls: 30 }, next: "impl" },
    impl: { type: "prompt", model: "opus", conversation: "plan", prompt: "Implement", budget: { minutes: 20 }, next: "check" },
    check: { type: "parse", from: "impl", fields: { result: "^RESULT: (\\w+)" }, next: "route" },
    route: { type: "branch", on: "{{check.result}}", cases: { PASS: "finish", FAIL: "again" } },
    again: { type: "loop", target: "impl", max: 2, exhausted: "stuck" },
    finish: { type: "done", summary: "{{check.result}} after {{again.count}}" },
    stuck: { type: "needs", reason: "Still failing: {{impl.text}}" },
  },
});

const messages = (v, level) => v.issues.filter((i) => !level || i.level === level).map((i) => i.message);

test("a sound definition is ok with no issues", () => {
  const v = validate(good(), { models: ["fable", "opus"] });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.deepEqual(v.issues, []);
});

test("a new blank workflow is valid", () => {
  assert.equal(validate(blank("wf_00000000", "x")).ok, true);
});

test("start missing, or naming no step, is an error", () => {
  const d = good();
  d.start = "";
  assert.match(messages(validate(d), "error").join("\n"), /no start step/);
  d.start = "ghost";
  assert.match(messages(validate(d), "error").join("\n"), /start step "ghost" does not exist/);
});

test("next and targets that name no step are errors, tied to their step", () => {
  const d = good();
  d.steps.plan.next = "nowhere";
  d.steps.again.target = "gone";
  const v = validate(d);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.step === "plan" && /next to "nowhere"/.test(i.message)));
  assert.ok(v.issues.some((i) => i.step === "again" && /target to "gone"/.test(i.message)));
});

test("unknown type, prompt without model or prompt, bad conversation", () => {
  const d = good();
  d.steps.weird = { type: "teleport" };
  d.steps.plan.model = "";
  delete d.steps.impl.prompt;
  d.steps.impl.conversation = "check";
  const errs = messages(validate(d), "error").join("\n");
  assert.match(errs, /unknown type "teleport"/);
  assert.match(errs, /"plan" has no model/);
  assert.match(errs, /"impl" has no prompt/);
  assert.match(errs, /conversation of "check", which is not a prompt step/);
});

test("parse: from not a prompt or tool step, a regex that does not compile, a list of sources", () => {
  const d = good();
  d.steps.check.from = "route";
  d.steps.check.fields.bad = "([unclosed";
  let errs = messages(validate(d), "error").join("\n");
  assert.match(errs, /parses "route", which is not a prompt or tool step/);
  assert.match(errs, /pattern for "bad" that does not compile/);
  d.steps.check = { type: "parse", from: ["impl", "plan"], fields: { result: "RESULT: (\\w+)" }, next: "route" };
  assert.equal(validate(d).ok, true);
  d.steps.check.from = ["impl", "again"];
  errs = messages(validate(d), "error").join("\n");
  assert.match(errs, /parses "again"/);
});

test("a parse field may not be named like what the step saves itself", () => {
  const d = good();
  d.steps.check.fields.text = "(.*)";
  assert.match(messages(validate(d), "error").join("\n"), /field named "text"/);
});

test("loop without max >= 1, and steps with no way out", () => {
  const d = good();
  d.steps.again.max = 0;
  delete d.steps.impl.next;
  d.steps.route = { type: "branch", on: "{{check.result}}" };
  const errs = messages(validate(d), "error").join("\n");
  assert.match(errs, /"again" needs a max of at least 1/);
  assert.match(errs, /"impl" has no next step/);
  assert.match(errs, /"route" has no cases and no default/);
});

test("warnings: no budget, unreachable step, a hole nothing saves, an unlisted model", () => {
  const d = good();
  delete d.steps.plan.budget;
  d.steps.orphan = { type: "done", summary: "{{plan.nothing}} {{ghost.text}}" };
  d.steps.impl.model = "gpt-9";
  const v = validate(d, { models: ["fable", "opus"] });
  assert.equal(v.ok, true);
  const warns = messages(v, "warn").join("\n");
  assert.match(warns, /"plan" has no budget/);
  assert.match(warns, /"orphan" cannot be reached/);
  assert.match(warns, /step "plan" never saves "nothing"/);
  assert.match(warns, /there is no step "ghost"/);
  assert.match(warns, /"gpt-9", which this workspace's providers do not list/);
});

test("without a model list there is no model warning", () => {
  const d = good();
  d.steps.impl.model = "gpt-9";
  assert.equal(messages(validate(d), "warn").length, 0);
});

test("edges lists every outgoing field", () => {
  assert.deepEqual(edges(good().steps.route), [["cases.PASS", "finish"], ["cases.FAIL", "again"]]);
  assert.deepEqual(edges(good().steps.again), [["target", "impl"], ["exhausted", "stuck"]]);
});

test("normalise keeps steps as given and forces the id and version it is told", () => {
  const n = normalise({ ...good(), id: "wf_ffffffff", version: 9, layout: { plan: { x: "3", y: 4 }, bad: 1 } }, { id: "wf_1a2b3c4d", version: 2 });
  assert.equal(n.id, "wf_1a2b3c4d");
  assert.equal(n.version, 2);
  assert.deepEqual(n.layout, { plan: { x: 3, y: 4 } });
  assert.deepEqual(n.steps.plan, good().steps.plan);
  assert.equal(n.input.kind, "lines");
});
