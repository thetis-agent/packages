// Checks every SKILL.md of this package: the frontmatter shape, the limits of the skill format,
// the links, and a short deny-list for the style. Plain node --test, no build, no dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(PKG, "skills");
const RESERVED = new Set(["references", "scripts", "assets"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BANNED = ["utilize", "leverage", "in order to", "—"];

/** Every SKILL.md under skills/, with its id. */
function findSkills(dir = SKILLS, prefix = []) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory() || RESERVED.has(entry)) continue;
    const id = [...prefix, entry];
    if (existsSync(join(path, "SKILL.md"))) out.push({ id: id.join("/"), dir: path, file: join(path, "SKILL.md") });
    out.push(...findSkills(path, id));
  }
  return out;
}

/** A small reader for the YAML subset the frontmatter uses: scalars, inline lists, one nested map. */
function parseFrontmatter(text) {
  const lines = text.split("\n");
  assert.equal(lines[0], "---", "frontmatter must start with ---");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "frontmatter must end with ---");
  const fm = {};
  let nested = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const m = /^(\s*)([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    assert.ok(m, `unreadable frontmatter line: ${line}`);
    const [, indent, key, raw] = m;
    const target = indent ? nested : fm;
    assert.ok(target, `indented key without a parent: ${line}`);
    if (!indent && raw === "") {
      nested = fm[key] = {};
      continue;
    }
    target[key] = scalar(raw.trim());
  }
  return { fm, body: lines.slice(end + 1).join("\n") };
}

function scalar(raw) {
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1).split(",").map((s) => scalar(s.trim())).filter((s) => s !== "");
  if (/^"(.*)"$/.test(raw)) return raw.slice(1, -1);
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

const skills = findSkills();
const ids = new Set(skills.map((s) => s.id));
const parsed = skills.map((s) => ({ ...s, ...parseFrontmatter(readFileSync(s.file, "utf8")) }));

test("the package manifest declares a skill directory and nothing else in thetis", () => {
  const m = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  assert.equal(m.name, "@thetis/skills-thetis");
  assert.equal(m.type, "module");
  assert.deepEqual(m.thetis, { type: "skill", skills: "skills" });
  assert.ok(!("main" in m), "a skill package has no main");
});

test("the expected skills exist", () => {
  const expected = ["thetis", ...["using", "packages", "pipeline", "skills", "projects", "marketplace", "web", "bench", "configuration", "developing", "fence", "troubleshooting"].map((n) => `thetis/${n}`)];
  for (const id of expected) assert.ok(ids.has(id), `missing skill ${id}`);
  assert.equal(skills.length, expected.length);
});

for (const s of parsed) {
  test(`${s.id}: frontmatter and limits`, () => {
    assert.equal(typeof s.fm.name, "string", "name is required");
    assert.equal(s.fm.name, s.id.split("/").at(-1), "name must equal the directory name");
    assert.match(s.fm.name, NAME);
    assert.equal(typeof s.fm.description, "string", "description is required");
    assert.ok(Buffer.byteLength(s.fm.description) <= 1024, `description is ${Buffer.byteLength(s.fm.description)} bytes`);
    assert.ok(/\bUse when\b/.test(s.fm.description), "description must say when to use the skill");
    assert.ok(s.id.split("/").length <= 3, "depth at most 3");
    const meta = s.fm.metadata ?? {};
    assert.equal(typeof meta.title, "string", "metadata.title is required here");
    assert.ok(Array.isArray(meta.tags) && meta.tags.length <= 32, "at most 32 tags");
    for (const t of meta.tags) assert.match(t, /^[a-z0-9.-]+$/, `tag ${t} must be one lowercase word`);
    assert.ok(Array.isArray(meta.related), "metadata.related is required here");
    for (const r of meta.related) assert.ok(ids.has(r), `related id ${r} does not exist`);
    assert.equal(meta.version, 1);
    const lines = s.body.split("\n").length;
    assert.ok(lines <= 400, `body is ${lines} lines`);
    assert.ok(Buffer.byteLength(s.body) <= 65536, "body at most 64 KiB");
    if (meta.universal === "true") assert.ok(lines <= 40, `universal body is ${lines} lines`);
    assert.ok(/\n## Sources\n/.test(s.body), "body must end with a Sources section");
    assert.ok(s.body.trimEnd().split("\n## Sources\n")[1]?.trim().startsWith("- "), "Sources must be a list");
  });
}

test("no skill in this pack is universal: the harness prompt is the only text paid for on every turn", () => {
  const universal = parsed.filter((s) => s.fm.metadata?.universal === "true").map((s) => s.id);
  assert.deepEqual(universal, []);
});

/** Every markdown file of the package: the skills, their references, and the README. */
function allMarkdown(dir = PKG) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "test") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...allMarkdown(path));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

test("every relative link resolves inside the package", () => {
  for (const file of allMarkdown()) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
      const path = resolve(dirname(file), target.split("#")[0]);
      assert.ok(existsSync(path), `${relative(PKG, file)}: link target ${target} does not exist`);
      assert.ok(!relative(PKG, path).startsWith(".."), `${relative(PKG, file)}: link ${target} leaves the package`);
    }
  }
});

test("no file uses a word from the style deny-list", () => {
  for (const file of allMarkdown()) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const word of BANNED) {
      const at = text.indexOf(word.toLowerCase());
      assert.equal(at, -1, `${relative(PKG, file)} uses "${word}" near: ${text.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, " ")}`);
    }
  }
});

test("a skill directory is never named after a reserved resource directory", () => {
  for (const s of skills) for (const part of s.id.split(sep === "/" ? "/" : "/")) assert.ok(!RESERVED.has(part));
});
