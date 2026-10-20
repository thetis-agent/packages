// loadSkills over a temporary directory with a package pack and a home, the cache, the project switch, and
// the skill_fetch tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSkills, excludedFor, selectSkills, clearCache, sourcesOf, projectOf, hiddenIn } from "../lib/load.js";
import { fetchSkill, slice, SLICE } from "../lib/fetch.js";
import { fakeEnv, makeHome, packInfo, skillText, writeSkill } from "./helpers.js";

function fixture() {
  const { home, rm } = makeHome();
  const pack = resolve(home, "pack");
  mkdirSync(resolve(pack, "skills"), { recursive: true });
  writeSkill(resolve(pack, "skills"), "packages", skillText({ name: "packages", description: "Installs packages. Use when asked to install.", meta: ["related: [projects]"] }), {
    "references/install.md": "# Install\n\nRun install_package.\n",
    "scripts/check.sh": "echo ok\n",
  });
  writeSkill(resolve(pack, "skills"), "packages/forks", skillText({ name: "forks", description: "Forks packages. Use when asked to fork." }));
  writeSkill(resolve(pack, "skills"), "concise", skillText({ name: "concise", description: "Short answers.", meta: ['universal: "true"'] }));
  writeSkill(resolve(pack, "skills"), "broken", "no frontmatter at all\n");
  // Not a skill: a directory without SKILL.md at the top level.
  mkdirSync(resolve(pack, "skills", "notes"), { recursive: true });
  writeFileSync(resolve(pack, "skills", "notes", "a.md"), "x");
  // The home overrides `concise` and adds one of its own.
  writeSkill(resolve(home, "skills"), "concise", skillText({ name: "concise", description: "Very short answers, from the home." }));
  writeSkill(resolve(home, "skills"), "mine", skillText({ name: "mine", description: "My own skill." }));
  const packages = [packInfo("@thetis/skills-test", pack), { name: "@thetis/other", root: home, thetis: { type: "tool" } }];
  return { home, rm, pack, packages, env: fakeEnv(home) };
}

test("sourcesOf lists package packs first and the home last", () => {
  const { home, rm, pack, packages, env } = fixture();
  try {
    assert.deepEqual(sourcesOf(env, packages), [
      { package: "@thetis/skills-test", dir: resolve(pack, "skills") },
      { dir: resolve(home, "skills") },
    ]);
    assert.deepEqual(sourcesOf(env, { list: () => packages }).length, 2);
  } finally {
    rm();
  }
});

test("loadSkills walks both sources, the home wins on an equal id, children and resources are listed", () => {
  const { home, rm, packages, env } = fixture();
  try {
    clearCache();
    const skills = loadSkills(env, packages);
    assert.deepEqual(
      skills.map((s) => s.id),
      ["broken", "concise", "mine", "packages", "packages/forks"],
    );
    const concise = skills.find((s) => s.id === "concise");
    assert.equal(concise.description, "Very short answers, from the home.");
    assert.equal(concise.source.package, undefined);
    assert.equal(concise.universal, false);
    const packages_ = skills.find((s) => s.id === "packages");
    assert.equal(packages_.source.package, "@thetis/skills-test");
    assert.deepEqual(packages_.children, ["packages/forks"]);
    assert.deepEqual(packages_.resources, ["references/install.md", "scripts/check.sh"]);
    assert.ok(packages_.source.path.endsWith("/packages/SKILL.md"));
    const broken = skills.find((s) => s.id === "broken");
    assert.equal(broken.problems[0].level, "error");
    assert.equal(skills.some((s) => s.id === "notes"), false);
    assert.equal(loadSkills(env, undefined).length, 2, "without packages only the home is read");
  } finally {
    rm();
  }
});

test("the cache is keyed by mtime and size: a rewrite with a new mtime is re-read", () => {
  const { home, rm, packages, env } = fixture();
  try {
    clearCache();
    const a = loadSkills(env, packages).find((s) => s.id === "mine");
    const file = resolve(home, "skills", "mine", "SKILL.md");
    writeFileSync(file, skillText({ name: "mine", description: "Changed description." }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const b = loadSkills(env, packages).find((s) => s.id === "mine");
    assert.equal(a.description, "My own skill.");
    assert.equal(b.description, "Changed description.");
  } finally {
    rm();
  }
});

test("excludedFor reads the session's project and its skills.disable", async () => {
  const { home, rm, env } = fixture();
  try {
    assert.deepEqual(await excludedFor(env, "s-1"), new Set());
    mkdirSync(resolve(home, "projects"), { recursive: true });
    writeFileSync(resolve(home, "projects", "sessions.json"), JSON.stringify({ "s-1": "p_0123abcd", "s-2": "p_deadbeef", "s-3": "bad" }));
    writeFileSync(resolve(home, "projects", "p_0123abcd.json"), JSON.stringify({ id: "p_0123abcd", name: "P", skills: { disable: ["packages", 7, "mine"] } }));
    writeFileSync(resolve(home, "projects", "p_deadbeef.json"), JSON.stringify({ id: "p_other", name: "Wrong id" }));
    assert.deepEqual(await excludedFor(env, { id: "s-1" }), new Set(["packages", "mine"]));
    assert.deepEqual(await excludedFor(env, "s-2"), new Set(), "a record whose id disagrees is ignored");
    assert.deepEqual(await excludedFor(env, "s-3"), new Set());
    assert.deepEqual(await excludedFor(env, undefined), new Set());
  } finally {
    rm();
  }
});

test("selectSkills leaves out errored and switched-off skills, caps universals, and notes each", async () => {
  const { home, rm, packages, env } = fixture();
  try {
    clearCache();
    mkdirSync(resolve(home, "projects"), { recursive: true });
    writeFileSync(resolve(home, "projects", "sessions.json"), JSON.stringify({ "s-1": "p_0123abcd" }));
    writeFileSync(resolve(home, "projects", "p_0123abcd.json"), JSON.stringify({ id: "p_0123abcd", skills: { disable: ["packages"] } }));
    const out = await selectSkills(env, packages, { id: "s-1" });
    assert.deepEqual(out.skills.map((s) => s.id), ["concise", "mine"]);
    assert.deepEqual(out.excluded, ["packages", "packages/forks"], "a switched-off parent takes its children");
    assert.deepEqual(out.universal, []);
    assert.equal(out.all.length, 5);
    assert.match(out.notes[0], /skill broken left out: no frontmatter/);
    assert.match(out.notes[1], /switched off by the project: packages, packages\/forks/);
  } finally {
    rm();
  }
});

test("fetchSkill returns the body, a file beside it, refuses the unknown with the closest ids, and slices", async () => {
  const { rm, packages, env } = fixture();
  try {
    clearCache();
    const toolEnv = { ...env, session: { id: "s-9" }, kernel: { packages: { list: async () => packages } } };
    const body = await fetchSkill({ id: "packages" }, toolEnv);
    assert.match(body, /^The body\./);
    assert.match(body, /Skill directory: .*\/skills\/packages\nFiles beside SKILL.md \(skill_fetch with file\): references\/install.md, scripts\/check.sh$/);
    assert.equal(await fetchSkill({ id: "packages", file: "references/install.md" }, toolEnv), "# Install\n\nRun install_package.\n");
    await assert.rejects(fetchSkill({ id: "packages", file: "../../etc/passwd" }, toolEnv), /has no file/);
    await assert.rejects(fetchSkill({ id: "package" }, toolEnv), /no skill with the id package; closest: packages/);
    await assert.rejects(fetchSkill({}, toolEnv), /id is required/);
    await assert.rejects(fetchSkill({ id: "broken" }, toolEnv), /no skill with the id broken/);
  } finally {
    rm();
  }
});

/** The fixture plus lessons the way @thetis/reflections writes them: a general scope and two project scopes. */
function lessonsFixture() {
  const f = fixture();
  const skills = resolve(f.home, "skills");
  writeSkill(skills, "lessons", skillText({ name: "lessons", description: "Lessons from your archived conversations." }));
  writeSkill(skills, "lessons/general", skillText({ name: "general", description: "Lessons for any conversation." }));
  writeSkill(skills, "lessons/general/retry", skillText({ name: "retry", description: "Retry a flaky test once. Use when a test fails without a change." }));
  writeSkill(skills, "lessons/p-0123abcd", skillText({ name: "p-0123abcd", description: "Lessons from project A.", meta: ["project: p_0123abcd"] }));
  writeSkill(skills, "lessons/p-0123abcd/deploy", skillText({ name: "deploy", description: "Deploy A with make. Use when A ships." }));
  writeSkill(skills, "lessons/p-deadbeef", skillText({ name: "p-deadbeef", description: "Lessons from project B.", meta: ["project: p_deadbeef"] }));
  writeSkill(skills, "lessons/p-deadbeef/build", skillText({ name: "build", description: "Build B with cargo. Use when B builds." }));
  // An error inside another project's scope stays as quiet as the rest of that scope.
  writeSkill(skills, "lessons/p-deadbeef/broken", "no frontmatter\n");
  mkdirSync(resolve(f.home, "projects"), { recursive: true });
  writeFileSync(resolve(f.home, "projects", "sessions.json"), JSON.stringify({ "s-a": "p_0123abcd", "s-b": "p_deadbeef", "s-c": "p_00000000" }));
  return f;
}

test("projectOf reads the session's project, or null", async () => {
  const { rm, env } = lessonsFixture();
  try {
    assert.equal(await projectOf(env, "s-a"), "p_0123abcd");
    assert.equal(await projectOf(env, { id: "s-b" }), "p_deadbeef");
    assert.equal(await projectOf(env, "s-none"), null);
    assert.equal(await projectOf(env, undefined), null);
  } finally {
    rm();
  }
});

test("a project-scoped skill and its children are hidden outside that project, with one quiet note", async () => {
  const { rm, packages, env } = lessonsFixture();
  try {
    clearCache();
    const a = await selectSkills(env, packages, { id: "s-a" });
    const ids = a.skills.map((s) => s.id);
    assert.ok(ids.includes("lessons/p-0123abcd") && ids.includes("lessons/p-0123abcd/deploy"), "the session's own project is seen");
    assert.ok(ids.includes("lessons/general/retry"), "an unscoped lesson is seen everywhere");
    assert.equal(ids.some((id) => id.startsWith("lessons/p-deadbeef")), false);
    assert.deepEqual(a.hidden, ["lessons/p-deadbeef", "lessons/p-deadbeef/broken", "lessons/p-deadbeef/build"]);
    assert.equal(a.project, "p_0123abcd");
    assert.deepEqual(a.excluded, []);
    assert.deepEqual(a.skills.find((s) => s.id === "lessons").children, ["lessons/general", "lessons/p-0123abcd"], "a parent's card names no hidden id");
    assert.equal(a.notes.filter((n) => /deadbeef|switched off/.test(n)).length, 0, "the hidden skills are not named, not even for an error");
    assert.ok(a.notes.includes("3 skills belong to other projects"));

    const none = await selectSkills(env, packages, { id: "s-none" });
    assert.equal(none.skills.some((s) => /^lessons\/p-/.test(s.id)), false, "with no project every project-scoped skill is hidden");
    assert.equal(none.hidden.length, 5);
    assert.ok(none.notes.includes("5 skills belong to other projects"));
    assert.ok(none.all.some((s) => s.id === "lessons/p-0123abcd"), "all keeps everything, for a page that shows the person their own");

    const other = await selectSkills(env, packages, { id: "s-c" });
    assert.equal(other.hidden.length, 5, "a project with no lessons sees none of the others'");
  } finally {
    rm();
  }
});

test("hiddenIn: a skill nested under a scope is hidden with it whatever it says itself", () => {
  const all = [
    { id: "a", project: "p_11111111" },
    { id: "a/b", project: "p_22222222" },
    { id: "a/b/c", project: "" },
    { id: "d", project: "" },
  ];
  assert.deepEqual(hiddenIn(all, "p_11111111"), ["a/b", "a/b/c"]);
  assert.deepEqual(hiddenIn(all, "p_22222222"), ["a", "a/b", "a/b/c"], "a scoped parent takes its children");
  assert.deepEqual(hiddenIn(all, null), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(hiddenIn([{ id: "d", project: "" }], null), []);
});

test("skill_fetch answers a hidden id as unknown and never offers one as the closest", async () => {
  const { rm, packages, env } = lessonsFixture();
  try {
    clearCache();
    const toolEnv = (id) => ({ ...env, session: { id }, kernel: { packages: { list: async () => packages } } });
    assert.match(await fetchSkill({ id: "lessons/p-deadbeef/build" }, toolEnv("s-b")), /^The body\./);
    await assert.rejects(fetchSkill({ id: "lessons/p-deadbeef/build" }, toolEnv("s-a")), (e) => /no skill with the id lessons\/p-deadbeef\/build/.test(e.message) && !/closest: [^;]*deadbeef/.test(e.message));
    await assert.rejects(fetchSkill({ id: "lessons/p-deadbeef" }, toolEnv("s-none")), /no skill with the id/);
    await assert.rejects(fetchSkill({ id: "lessons/p-0123abcd/deploy" }, toolEnv("s-none")), (e) => !/p-0123abcd/.test(e.message.split("closest")[1] ?? ""));
  } finally {
    rm();
  }
});

test("slice cuts at 24000 characters and says how to read on", () => {
  const text = "x".repeat(SLICE * 2 + 10);
  const first = slice(text, 0);
  assert.equal(first.truncated, true);
  assert.ok(first.text.endsWith(`\n[characters 1-${SLICE} of ${SLICE * 2 + 10}; read on with offset ${SLICE}]`));
  const last = slice(text, SLICE * 2);
  assert.equal(last.truncated, false);
  assert.ok(last.text.endsWith(`\n[characters ${SLICE * 2 + 1}-${SLICE * 2 + 10} of ${SLICE * 2 + 10}]`));
  assert.equal(slice("short", 0).text, "short");
  assert.equal(slice("short", -5).offset, 0);
});
