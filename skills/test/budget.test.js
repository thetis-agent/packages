// The always-on budget: the arithmetic matches the render, universal bodies go before briefs and from the
// last id back, the headers go with their last entry, and the note names every drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alwaysOnBudgetOf, budgetNote, DEFAULT_ALWAYS_ON, fitAlwaysOn, universalSection } from "../lib/budget.js";
import { brief } from "../lib/skill.js";

const skill = (id, body = `Body of ${id}.`) => ({ id, name: id, title: "", description: `Does ${id}. Use when ${id} comes up.`, body });
const HEADER = "# Skills\nOne line each.";
const HEADING = "# Skills always in force";
const catalogue = ["alpha", "beta", "gamma", "delta"].map((id) => skill(id));
const universal = [skill("alpha", "A".repeat(200)), skill("beta", "B".repeat(200))];

/** What a loader would put in the prompt for the kept lists, rendered the long way. */
const rendered = (fit) => [fit.catalogue.length ? `${HEADER}\n\n${fit.catalogue.map(brief).join("\n")}` : "", fit.universal.length ? universalSection(HEADING, fit.universal) : ""].filter(Boolean).join("\n\n");

test("alwaysOnBudgetOf takes a positive whole number, else the default", () => {
  assert.equal(DEFAULT_ALWAYS_ON, 64000);
  assert.equal(alwaysOnBudgetOf({ alwaysOnBudget: 1200.7 }), 1200);
  for (const bad of [undefined, {}, { alwaysOnBudget: 0 }, { alwaysOnBudget: -5 }, { alwaysOnBudget: "lots" }]) assert.equal(alwaysOnBudgetOf(bad), DEFAULT_ALWAYS_ON);
});

test("under budget nothing is dropped, and used is the length of the blocks joined", () => {
  const fit = fitAlwaysOn({ header: HEADER, heading: HEADING, catalogue, universal, budget: DEFAULT_ALWAYS_ON });
  assert.deepEqual(fit.dropped, []);
  assert.equal(fit.blocks.join("\n\n"), rendered(fit));
  assert.equal(fit.used, rendered(fit).length);
  assert.equal(fit.total, fit.used);
  assert.equal(budgetNote(fit), null);
});

test("over budget the universal bodies go first, from the last id back, then briefs from the end", () => {
  const full = fitAlwaysOn({ header: HEADER, heading: HEADING, catalogue, universal, budget: DEFAULT_ALWAYS_ON }).used;
  const oneBody = fitAlwaysOn({ header: HEADER, heading: HEADING, catalogue, universal, budget: full - 1 });
  assert.deepEqual(oneBody.dropped, [{ id: "beta", part: "body" }]);
  assert.deepEqual(oneBody.universal.map((s) => s.id), ["alpha"]);
  assert.equal(oneBody.catalogue.length, 4, "the brief of a skill whose body went stays");
  assert.ok(oneBody.used <= full - 1);
  assert.equal(oneBody.used, rendered(oneBody).length);

  const briefsOnly = fitAlwaysOn({ header: HEADER, heading: HEADING, catalogue, universal, budget: rendered({ catalogue, universal: [] }).length });
  assert.deepEqual(briefsOnly.dropped, [{ id: "beta", part: "body" }, { id: "alpha", part: "body" }]);
  assert.equal(briefsOnly.blocks.length, 1, "the heading goes with the last body");

  const tight = fitAlwaysOn({ header: HEADER, heading: HEADING, catalogue, universal, budget: rendered({ catalogue: catalogue.slice(0, 2), universal: [] }).length });
  assert.deepEqual(tight.dropped.map((d) => `${d.id}:${d.part}`), ["beta:body", "alpha:body", "delta:brief", "gamma:brief"]);
  assert.deepEqual(tight.catalogue.map((s) => s.id), ["alpha", "beta"]);
  assert.equal(tight.used, rendered(tight).length);
  assert.equal(budgetNote(tight), `over the always-on budget (${tight.total} of ${tight.budget} characters): left out the universal body of beta, alpha (now loaded on request); the brief of delta, gamma`);

  const nothing = fitAlwaysOn({ header: HEADER, heading: HEADING, catalogue, universal, budget: 10 });
  assert.deepEqual(nothing.blocks, []);
  assert.equal(nothing.used, 0);
  assert.equal(nothing.dropped.length, 6);
});

test("budgetNote names whole skills for a loader with no other level, in its own unit", () => {
  assert.equal(budgetNote({ total: 900, budget: 500, dropped: [{ id: "x", part: "skill" }, { id: "y", part: "skill" }] }, "bytes"), "over the always-on budget (900 of 500 bytes): left out x, y");
});
