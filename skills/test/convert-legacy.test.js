// The legacy converter over a fixture tree: both link forms, a dropped link, a cut description, a retired
// skill, tags and related ids, resources copied as they are, and the result parsing clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { convertLegacy, describe, normalizeTag, rewriteLinks } from "../scripts/convert-legacy.mjs";
import { loadSkills, clearCache } from "../lib/load.js";
import { lint, LIMITS } from "../lib/skill.js";
import { fakeEnv, makeHome, packInfo } from "./helpers.js";

const longBrief = `${"A sentence that goes on and on to fill the line. ".repeat(24)}The last sentence that does not fit.`;

function legacy(dir, name, text, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), text);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(resolve(dir, f, ".."), { recursive: true });
    writeFileSync(resolve(dir, f), content);
  }
}

function fixture() {
  const { home, rm } = makeHome("convert-");
  const src = resolve(home, "legacy");
  legacy(
    resolve(src, "alpha"),
    "alpha",
    [
      "---",
      'name = "Alpha skill"',
      'brief = "Does the first thing: colons, \\"quotes\\" and all."',
      'when_to_use = "Use when alpha is asked for. Not for beta."',
      'tags = ["Alpha", "first thing", "some_tag", "@odd", "first thing"]',
      'related = ["beta", "gone"]',
      'children = ["child"]',
      "version = 2",
      "---",
      "# Alpha",
      "",
      "See [beta](skill:beta), [the beta skill](skill:beta), [child](skill:alpha/child) and [nothing](skill:gone).",
      "",
    ].join("\n"),
    { "references/notes.md": "Notes with a [beta](skill:beta) link.\n" },
  );
  legacy(
    resolve(src, "alpha", "child"),
    "child",
    ["---", 'name = "Child"', 'brief = "A retired child."', 'when_to_use = "Use never."', 'status = "retired"', 'superseded_by = "beta"', "universal = true", "version = 1", "---", "", "# Child", ""].join("\n"),
  );
  legacy(resolve(src, "beta"), "beta", ["---", 'name = "Beta"', `brief = "${longBrief}"`, 'when_to_use = "Use for beta."', "universal = false", "version = 3", "---", "# Beta\n"].join("\n"));
  return { home, rm, src, out: resolve(home, "out") };
}

test("describe joins brief and when_to_use and cuts at a sentence end", () => {
  assert.deepEqual(describe(" One.  ", "Two. "), { text: "One. Two.", cut: false });
  const { text, cut } = describe(longBrief, "Use for beta.");
  assert.equal(cut, true);
  assert.ok(Buffer.byteLength(text) <= LIMITS.description);
  assert.match(text, /line\.$/);
  assert.ok(!text.includes("does not fit"));
});

test("normalizeTag and rewriteLinks", () => {
  assert.equal(normalizeTag("First Thing"), "first-thing");
  assert.equal(normalizeTag("some_tag"), "some-tag");
  assert.equal(normalizeTag("@limits"), "limits");
  const warnings = [];
  const r = rewriteLinks("[b](skill:a/b) [a/b](skill:a/b) [see b](skill:a/b) [x](skill:x)", new Set(["a/b"]), (m) => warnings.push(m));
  assert.equal(r.text, "`a/b` `a/b` see b (`a/b`) x");
  assert.equal(r.rewritten, 3);
  assert.equal(warnings.length, 1);
});

test("convertLegacy converts a tree, warns on what it changed, and the result parses clean", () => {
  const { rm, src, out } = fixture();
  try {
    const summary = convertLegacy({ inputs: [resolve(src, "alpha"), resolve(src, "beta")], out });
    assert.equal(summary.skills, 3);
    assert.equal(summary.resources, 1);
    assert.equal(summary.links, 3);
    const w = summary.warnings.join("\n");
    assert.match(w, /alpha: link to "gone" names no skill/);
    assert.match(w, /alpha: related id "gone"/);
    assert.match(w, /alpha: resource references\/notes\.md holds 1 skill: link/);
    assert.match(w, /beta: description cut to \d+ bytes/);
    assert.match(w, /alpha\/child: status retired, superseded by beta/);

    const alpha = readFileSync(resolve(out, "alpha", "SKILL.md"), "utf8");
    assert.ok(alpha.startsWith('---\nname: alpha\ndescription: "Does the first thing: colons, \\"quotes\\" and all. Use when alpha is asked for. Not for beta."\nmetadata:\n  title: Alpha skill\n  tags: [alpha, first-thing, some-tag, odd]\n  related: [beta]\n  version: 2\n---\n# Alpha\n'), alpha);
    assert.ok(alpha.includes("See `beta`, the beta skill (`beta`), `alpha/child` and nothing."));
    assert.ok(!alpha.includes("children"));
    assert.equal(readFileSync(resolve(out, "alpha", "references", "notes.md"), "utf8"), "Notes with a [beta](skill:beta) link.\n");

    const child = readFileSync(resolve(out, "alpha", "child", "SKILL.md"), "utf8");
    assert.ok(child.includes('  universal: "true"\n'));
    assert.ok(child.includes("---\n**Status: retired.** Superseded by `beta`.\n\n# Child\n"), child);

    clearCache();
    const skills = loadSkills(fakeEnv(out), [packInfo("@test/converted", out, ".")]);
    assert.deepEqual(skills.map((s) => s.id), ["alpha", "alpha/child", "beta"]);
    // The fixture's beta carries a 979-character description on purpose (the cut rule): the only finding is the terse guideline, a warning.
    assert.deepEqual(lint(skills).map((p) => [p.id, p.level, p.message.replace(/\d+/, "N")]), [["beta", "warning", "description is N characters, over the 400 guideline"]]);
    assert.equal(skills[0].title, "Alpha skill");
    assert.deepEqual(skills[0].related, ["beta"]);
    assert.equal(skills[1].universal, true);
    assert.equal(skills[2].version, 3);
    assert.ok(Buffer.byteLength(skills[2].description) <= LIMITS.description);

    assert.throws(() => convertLegacy({ inputs: [resolve(src, "alpha")], out }), /exists; pass --force/);
    assert.equal(convertLegacy({ inputs: [resolve(src, "alpha")], out, force: true }).skills, 2);
    assert.ok(existsSync(resolve(out, "beta", "SKILL.md")), "an input not given again is left alone");
  } finally {
    rm();
  }
});

test("a directory that is not a skill name is refused", () => {
  const { home, rm } = makeHome("convert-bad-");
  try {
    legacy(resolve(home, "Bad_Name"), "x", '---\nname = "x"\nbrief = "b"\nwhen_to_use = "w"\n---\nbody\n');
    assert.throws(() => convertLegacy({ inputs: [resolve(home, "Bad_Name")], out: resolve(home, "out") }), /is not a skill name/);
    legacy(resolve(home, "references"), "x", '---\nname = "x"\nbrief = "b"\nwhen_to_use = "w"\n---\nbody\n');
    assert.throws(() => convertLegacy({ inputs: [resolve(home, "references")], out: resolve(home, "out") }), /may not be named references/);
  } finally {
    rm();
  }
});
