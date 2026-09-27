// The model picker's rows: this chat's model first, then what a new chat really starts with, then the
// recent ones, then the catalogue folded, and a filter that finds a model once wherever it sits.
import { test } from "node:test";
import assert from "node:assert/strict";

import { contextSize, filterSections, modelSections, perMillion, rememberChoice } from "../assets/lib/model-choices.js";

const CATALOGUE = [
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", provider: "@thetis/provider-openrouter", contextLength: 1_000_000, pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1", provider: "@thetis/provider-openrouter", contextLength: 200_000 },
  { id: "openai/gpt-x", provider: "@thetis/provider-openrouter", pricing: { prompt: 0, completion: 0 } },
  { id: "mistral/small", provider: "@thetis/provider-openrouter" },
  { id: "*" },
];
const choices = (yours) => ({ model: "anthropic/claude-sonnet-5", models: CATALOGUE, yours });
const ids = (section) => section.options.map((o) => o.id);

test("your default is what a new chat starts with: the model chosen last, not the configured one", () => {
  // The production mismatch: "Default" said sonnet-5 while a new chat started on fable, the last choice.
  const { sections } = modelSections(choices({ model: "anthropic/claude-fable-5.1", recent: ["anthropic/claude-fable-5.1", "openai/gpt-x", "mistral/small"] }), { model: "openai/gpt-x" });
  assert.deepEqual(sections.map((s) => s.id), ["this", "default", "recent", "all"]);
  assert.equal(sections[0].title, "This chat");
  assert.deepEqual(ids(sections[0]), ["openai/gpt-x"]);
  assert.equal(sections[0].options[0].selected, true);
  assert.deepEqual(ids(sections[1]), ["anthropic/claude-fable-5.1", ""], "your choice, then the configured default under its own name");
  assert.match(sections[1].options[0].note, /the model you chose last/);
  assert.match(sections[1].options[1].label, /^Thetis default · Claude Sonnet 5$/);
  assert.deepEqual(ids(sections[2]), ["mistral/small"], "recent leaves out what is already shown above");
  assert.equal(sections[3].title, "All models (4)", "the catalogue, without the wildcard");
  assert.equal(sections[3].collapsible, true);
  assert.ok(sections.slice(1).every((s) => s.options.every((o) => o.selected === false)), "only This chat is marked as the choice");
});

test("with nothing chosen, your default is the configured model and there is no second default row", () => {
  const { sections, selected } = modelSections(choices({ model: null, recent: [] }), {});
  assert.deepEqual(sections.map((s) => s.id), ["this", "default", "all"]);
  assert.equal(selected, "anthropic/claude-sonnet-5", "a chat with no model runs on the configured default");
  assert.match(sections[0].options[0].note, /the configured default/);
  assert.deepEqual(ids(sections[1]), ["anthropic/claude-sonnet-5"]);
  assert.match(sections[1].options[0].note, /set by the configuration/);
});

test("a + draft shows what the new chat will start with, and its own pick once made", () => {
  const base = choices({ model: "anthropic/claude-fable-5.1", recent: [] });
  let out = modelSections(base, { draft: true });
  assert.equal(out.sections[0].title, "New chat");
  assert.equal(out.effective, "anthropic/claude-fable-5.1");
  out = modelSections(base, { draft: true, model: "mistral/small" });
  assert.equal(out.effective, "mistral/small");
  assert.match(out.sections[0].options[0].note, /picked for this new chat/);
  out = modelSections(base, { draft: true, model: "" });
  assert.equal(out.effective, "anthropic/claude-sonnet-5", "the empty pick is the configured default");
});

test("recent keeps five, newest first, and a model no provider lists still reads", () => {
  const recent = ["gone/model", "m1", "m2", "m3", "m4", "m5", "m6"];
  const { sections } = modelSections(choices({ model: "anthropic/claude-sonnet-5", recent }), { model: "anthropic/claude-sonnet-5" });
  const rec = sections.find((s) => s.id === "recent");
  assert.deepEqual(ids(rec), ["gone/model", "m1", "m2", "m3", "m4"]);
  assert.match(rec.options[0].note, /not listed by any provider/);
});

test("price and context columns only where the catalogue gives them", () => {
  const all = modelSections(choices(undefined), {}).sections.find((s) => s.id === "all").options;
  const cols = Object.fromEntries(all.map((o) => [o.id, o.cols.map((c) => c.text)]));
  assert.deepEqual(cols["anthropic/claude-sonnet-5"], ["$3 / $15", "1M"]);
  assert.deepEqual(cols["anthropic/claude-fable-5.1"], ["200k"]);
  assert.deepEqual(cols["openai/gpt-x"], ["free"]);
  assert.deepEqual(cols["mistral/small"], []);
  assert.equal(perMillion("0.0000005"), "$0.5");
  assert.equal(perMillion(0.00000000001), "<$0.01");
  assert.equal(perMillion("x"), null);
  assert.equal(contextSize(131072), "131k");
  assert.equal(contextSize(1_500_000), "1.5M");
  assert.equal(contextSize(undefined), null);
});

test("a filter looks through every section and lists each model once", () => {
  const { sections } = modelSections(choices({ model: "anthropic/claude-fable-5.1", recent: ["mistral/small"] }), { model: "anthropic/claude-fable-5.1" });
  const [matches] = filterSections(sections, "claude");
  assert.equal(matches.title, "Matches");
  assert.deepEqual(ids(matches), ["anthropic/claude-fable-5.1", "", "anthropic/claude-sonnet-5"]);
  assert.equal(matches.options[0].selected, true, "the first appearance is the chat's own row");
  assert.equal(filterSections(sections, "  ").length, sections.length, "no query, no change");
});

test("a choice becomes your default and the newest recent one; the empty choice forgets it and keeps recent", () => {
  let c = choices({ model: null, recent: ["a", "b", "c", "d", "e"] });
  c = rememberChoice(c, "c");
  assert.deepEqual(c.yours, { model: "c", recent: ["c", "a", "b", "d", "e"] });
  c = rememberChoice(c, "f");
  assert.deepEqual(c.yours.recent, ["f", "c", "a", "b", "d"]);
  c = rememberChoice(c, "");
  assert.deepEqual(c.yours, { model: null, recent: ["f", "c", "a", "b", "d"] });
  assert.equal(rememberChoice(null, "x"), null);
});
