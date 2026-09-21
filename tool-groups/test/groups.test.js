// Group derivation from packages, and the tokenizer and score ported from the predecessor's groups.rs tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGroups, lexicalRank, orderIds, routable, score, tagPresent, tokens } from "../lib/groups.js";
import { pkg, table } from "./helpers.js";

test("every package with tools is one group by default: the unscoped name, the description's first sentence, no tags, routable", () => {
  const { groups, byTool } = deriveGroups([pkg("@bitmuse/moo", ["moo_eval", "moo_get"], { description: "Drive the live Torchship world over its web-host API. Needs a token." })]);
  assert.equal(groups.length, 1);
  assert.deepEqual({ ...groups[0], tools: groups[0].tools.map((t) => t.name) }, { id: "moo", brief: "Drive the live Torchship world over its web-host API.", tags: [], alwaysOn: false, configured: false, declared: false, tools: ["moo_eval", "moo_get"], packages: ["@bitmuse/moo"] });
  assert.deepEqual([...byTool], [["moo_eval", "moo"], ["moo_get", "moo"]]);
});

test("a declared toolGroup sets the id, brief, tags and alwaysOn; tags are lowercased and deduplicated", () => {
  const { groups } = deriveGroups([pkg("@thetis/exa", ["exa_search"], { toolGroup: { id: "web", brief: "Search and read the web with Exa.", tags: ["Web", "search", "web", "URL"], alwaysOn: false } })]);
  assert.deepEqual(groups.map((g) => [g.id, g.brief, g.tags, g.alwaysOn]), [["web", "Search and read the web with Exa.", ["web", "search", "url"], false]]);
  const on = deriveGroups([pkg("@thetis/exa", ["exa_search"], { toolGroup: { id: "web", alwaysOn: true } })]).groups[0];
  assert.equal(on.alwaysOn, true);
  assert.equal(on.configured, false);
});

test("a tool with a group of its own sits there; a group only tools declare takes its brief from the first such tool", () => {
  const { groups, byTool } = deriveGroups([pkg("@a/kit", ["kit_run", { name: "kit_draw", description: "Draws a chart. Slowly.", group: "charts" }, { name: "kit_plot", description: "Plots too.", group: "charts" }])]);
  assert.deepEqual(groups.map((g) => [g.id, g.brief, g.tools.map((t) => t.name), g.packages]), [
    ["kit", "The @a/kit package.", ["kit_run"], ["@a/kit"]],
    ["charts", "Draws a chart.", ["kit_draw", "kit_plot"], ["@a/kit"]],
  ]);
  assert.equal(byTool.get("kit_draw"), "charts");
});

test("two packages with the same unscoped name keep their scope; a tool name the first package took is not claimed again", () => {
  const { groups, byTool } = deriveGroups([pkg("@bitmuse/moo", ["moo_eval"]), pkg("@alice/moo", ["moo_eval", "moo_extra"])]);
  assert.deepEqual(groups.map((g) => [g.id, g.tools.map((t) => t.name)]), [["bitmuse/moo", ["moo_eval"]], ["alice/moo", ["moo_extra"]]]);
  assert.equal(byTool.get("moo_eval"), "bitmuse/moo");
});

test("always on: a group of packages everyone has, the package with tool_search, a configured id; a mixed group is routable", () => {
  const packages = [pkg("@thetis/tools-files", ["read_path"], { everyone: true }), pkg("@thetis/tool-groups", ["tool_search"]), pkg("@alice/web", ["web_search"]), pkg("@alice/mixed", [{ name: "a_core", group: "shared" }]), pkg("@thetis/core", [{ name: "b_core", group: "shared" }], { everyone: true })];
  const { groups } = deriveGroups(packages, { alwaysOn: ["web"] });
  assert.deepEqual(groups.map((g) => [g.id, g.alwaysOn, g.configured]), [
    ["tools-files", true, false],
    ["tool-groups", true, false],
    ["web", true, true],
    ["mixed", false, false],
    ["shared", false, false],
    ["core", false, false],
  ]);
  assert.deepEqual(routable(groups).map((g) => g.id), ["mixed", "shared", "core"]);
  assert.deepEqual(deriveGroups([pkg("@a/x", [])]).groups, [], "a package without tools is no group");
});

test("tokens are lowercase alphanumeric runs, and a tag matches only its exact words, adjacent when there are several", () => {
  assert.deepEqual(tokens("Refactor src/lib.rs, then RUN the tests!"), ["refactor", "src", "lib", "rs", "then", "run", "the", "tests"]);
  assert.ok(tagPresent("fan-out", tokens("please fan out the reading")));
  assert.ok(tagPresent("fan out", tokens("fan-out across four agents")));
  assert.ok(!tagPresent("fan-out", tokens("out of the fan")), "adjacency is required");
  assert.ok(!tagPresent("fan-out", tokens("switch the fan off and head out")));
  assert.ok(tagPresent("spawn", tokens("spawn a helper")));
  assert.ok(!tagPresent("spawn", tokens("spawning a helper")), "no stemming");
  assert.ok(!tagPresent("", tokens("anything")));
});

test("the score is m/(m+1) over distinct tags: 0.5 for one, sub-linear, repeats do not inflate, zero without tags", () => {
  const files = table().find((p) => p.thetis.toolGroup?.id === "files").thetis.toolGroup;
  const s = (q) => score(files, tokens(q));
  assert.equal(s("open the directory"), 0.5);
  const one = s("open the directory");
  const two = s("read the directory");
  const three = s("read and edit the directory");
  assert.ok(one < two && two < three && three < 1, `${one} < ${two} < ${three} < 1`);
  assert.equal(two, 2 / 3);
  assert.equal(three, 0.75);
  assert.equal(s("read read read read"), s("read"), "a repeated tag does not inflate the score");
  assert.equal(s("what is the weather in oslo"), 0);
  assert.equal(score({ tags: [] }, tokens("core memory remember recall")), 0, "a tagless group never routes on tags");
  for (const p of table()) for (const tag of p.thetis.toolGroup?.tags ?? []) assert.ok(tagPresent(tag, tokens(tag)), `tag ${tag} can match something`);
});

test("lexicalRank orders best first with ties by id, and orderIds is the table order whatever the input order", () => {
  const { groups } = deriveGroups(table());
  const ranked = lexicalRank(routable(groups), "run the tests and open a shell on the host over ssh");
  assert.deepEqual(ranked.slice(0, 2).map((h) => [h.id, h.score]), [["shell", 0.75], ["ssh", 2 / 3]]);
  assert.deepEqual(orderIds(groups, ["web", "files", "shell"]), orderIds(groups, ["shell", "web", "files"]));
  assert.deepEqual(orderIds(groups, ["web", "nonsense", "files"]), ["files", "web"]);
});
