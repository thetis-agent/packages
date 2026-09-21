// parseSkill and lint: every rule of the format, and the three renderings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkill, lint, brief, card, renderBody, contentHashOf, firstSentence, LIMITS, CARD_WHEN_LIMIT } from "../lib/skill.js";
import { skillText } from "./helpers.js";

const errors = (s) => s.problems.filter((p) => p.level === "error").map((p) => p.message);
const warnings = (s) => s.problems.filter((p) => p.level === "warning").map((p) => p.message);

test("a well-formed skill parses with no problems and a hash over name, description and tags", () => {
  const s = parseSkill(skillText({ name: "packages", description: "Installs packages. Use when asked to install.", meta: ["tags: [install, forks]", 'universal: "true"', "related: [projects]", "version: 2", "title: Packages"] }), { id: "packages" });
  assert.deepEqual(s.problems, []);
  assert.equal(s.name, "packages");
  assert.deepEqual(s.tags, ["install", "forks"]);
  assert.equal(s.universal, true);
  assert.deepEqual(s.related, ["projects"]);
  assert.equal(s.version, 2);
  assert.equal(s.title, "Packages");
  assert.equal(s.body, "The body.\n");
  assert.equal(s.contentHash, contentHashOf("packages", "Installs packages. Use when asked to install.", ["install", "forks"]));
  assert.equal(s.contentHash.length, 64);
});

test("a body edit does not move the content hash; a description edit does", () => {
  const a = parseSkill(skillText({ name: "x", description: "One.", body: "a" }), { id: "x" });
  const b = parseSkill(skillText({ name: "x", description: "One.", body: "b" }), { id: "x" });
  const c = parseSkill(skillText({ name: "x", description: "Two.", body: "a" }), { id: "x" });
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(a.contentHash, c.contentHash);
});

test("no frontmatter, a missing name, a missing description are errors", () => {
  assert.match(errors(parseSkill("just text", { id: "x" }))[0], /no frontmatter/);
  assert.match(errors(parseSkill("---\ndescription: d\n---\n", { id: "x" }))[0], /name is required/);
  assert.match(errors(parseSkill("---\nname: x\n---\n", { id: "x" }))[0], /description is required/);
});

test("the name must match the rule and equal the directory name", () => {
  assert.match(errors(parseSkill(skillText({ name: "Bad_Name", description: "d" }), { id: "bad-name" }))[0], /must match/);
  assert.match(errors(parseSkill(skillText({ name: "other", description: "d" }), { id: "packages" }))[0], /must equal the directory name "packages"/);
  assert.deepEqual(errors(parseSkill(skillText({ name: "forks", description: "d" }), { id: "packages/forks" })), []);
});

test("reserved names and depth over 3 are errors", () => {
  assert.match(errors(parseSkill(skillText({ name: "references", description: "d" }), { id: "references" }))[0], /may not be named references/);
  assert.match(errors(parseSkill(skillText({ name: "d", description: "d" }), { id: "a/b/c/d" }))[0], /1 to 3 segments/);
});

test("the description and body limits", () => {
  const long = "x".repeat(LIMITS.description + 1);
  assert.match(errors(parseSkill(skillText({ name: "x", description: `"${long}"` }), { id: "x" }))[0], /over 1024 bytes/);
  const bigBody = "y".repeat(LIMITS.body + 1);
  assert.match(errors(parseSkill(skillText({ name: "x", description: "d", body: bigBody }), { id: "x" }))[0], /body is over/);
});

test("tags: not a lowercase word is dropped with a warning; over 32 are cut", () => {
  const s = parseSkill(skillText({ name: "x", description: "d", meta: ['tags: [ok, "Not Ok", also-ok]'] }), { id: "x" });
  assert.deepEqual(s.tags, ["ok", "also-ok"]);
  assert.match(warnings(s)[0], /"Not Ok" is not a lowercase word/);
  const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const m = parseSkill(skillText({ name: "x", description: "d", meta: [`tags: [${many.join(", ")}]`] }), { id: "x" });
  assert.equal(m.tags.length, 32);
  assert.match(warnings(m)[0], /more than 32 tags/);
});

test("universal reads true and false; anything else warns", () => {
  assert.equal(parseSkill(skillText({ name: "x", description: "d", meta: ["universal: true"] }), { id: "x" }).universal, true);
  assert.equal(parseSkill(skillText({ name: "x", description: "d", meta: ["universal: false"] }), { id: "x" }).universal, false);
  const s = parseSkill(skillText({ name: "x", description: "d", meta: ["universal: yes"] }), { id: "x" });
  assert.equal(s.universal, false);
  assert.match(warnings(s)[0], /universal must be/);
});

test("related must be ids; version must be an integer; unknown keys warn and are ignored", () => {
  const s = parseSkill(skillText({ name: "x", description: "d", meta: ["related: [ok/child, Bad Id]", "version: 1.5", "colour: blue"] }).replace("---\nname", "---\nlicense: MIT\nname"), { id: "x" });
  assert.deepEqual(s.related, ["ok/child"]);
  assert.equal(s.version, undefined);
  const w = warnings(s);
  assert.ok(w.some((m) => /unknown frontmatter key "license"/.test(m)));
  assert.ok(w.some((m) => /unknown metadata key "colour"/.test(m)));
  assert.ok(w.some((m) => /related id "Bad Id"/.test(m)));
  assert.ok(w.some((m) => /version must be an integer/.test(m)));
  assert.deepEqual(errors(s), []);
});

test("a relative link that leaves the skills directory is a warning; one inside the pack is not", () => {
  const s = parseSkill(skillText({ name: "b", description: "d", body: "[x](../a/SKILL.md) [y](references/r.md) [z](../../../outside.md) [u](https://x.y/) [f](#frag)" }), { id: "p/b" });
  assert.equal(warnings(s).length, 1);
  assert.match(warnings(s)[0], /"\.\.\/\.\.\/\.\.\/outside\.md" leaves/);
});

test("lint over a set: the universal cap, unknown related ids, a missing parent", () => {
  const mk = (id, extra = []) => parseSkill(skillText({ name: id.split("/").pop(), description: "d", meta: extra }), { id });
  const skills = [];
  for (let i = 0; i < 9; i++) skills.push(mk(`u${i}`, ['universal: "true"']));
  skills.push(mk("lone/child"));
  skills.push(mk("r", ["related: [nothing]"]));
  const out = lint(skills);
  assert.ok(out.some((p) => p.id === "u8" && /more than 8 universal/.test(p.message)));
  assert.ok(!out.some((p) => p.id === "u7" && /universal/.test(p.message)));
  assert.ok(out.some((p) => p.id === "lone/child" && /parent skill "lone"/.test(p.message)));
  assert.ok(out.some((p) => p.id === "r" && /related id "nothing"/.test(p.message)));
});

test("brief, card and renderBody", () => {
  const s = parseSkill(skillText({ name: "packages", description: "Installs and forks packages. Use when asked to install, fork or promote a package.", meta: ["related: [projects]"] }), { id: "packages" });
  s.children = ["packages/forks"];
  s.resources = ["references/install.md"];
  s.source = { dir: "/home/skills/packages" };
  assert.equal(brief(s), "`packages` — Installs and forks packages.");
  assert.equal(card(s), "`packages` — Installs and forks packages.\nUse when: Use when asked to install, fork or promote a package.\nNested: `packages/forks`", "related ids are not on the card");
  const long = card(parseSkill(`---\nname: long\ndescription: Does a thing. ${"Use when ".repeat(60).trim()}.\n---\nbody\n`, { id: "long" }));
  const when = long.split("\n")[1];
  assert.ok(when.startsWith("Use when: ") && when.endsWith("…") && when.length <= "Use when: ".length + CARD_WHEN_LIMIT, when.length);
  assert.equal(renderBody(s), "The body.\n\nSkill directory: /home/skills/packages\nFiles beside SKILL.md (skill_fetch with file): references/install.md");
  s.title = "Packages";
  assert.equal(brief(s), "`packages` (Packages) — Installs and forks packages.");
});

test("the brief is cut at 160 characters and at the first sentence end", () => {
  assert.equal(firstSentence("One two. Three four."), "One two.");
  assert.equal(firstSentence("No end here"), "No end here");
  assert.equal(firstSentence("v1.2 is fine. Next."), "v1.2 is fine.");
  const long = firstSentence(`${"word ".repeat(50)}end.`);
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
});
