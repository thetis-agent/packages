// The lesson writer: where a lesson goes, the parents it needs, `metadata.project` on a project's scope,
// unique names, lessons.json, removal with the scope it made, and every file lint-clean by the skills
// library's own rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { lint, parseSkill, wholeFirstSentence } from "../../skills/lib/skill.js";
import { listLessons, nameFor, removeLessons, scopeOf, uniqueName, writeLesson, WRITTEN_BY } from "../lib/lessons.js";
import { guard, parseAnswer } from "../lib/prompt.js";
import { GOOD_ANSWER, get, put, tempHome } from "./helpers.js";

const parsed = parseAnswer(GOOD_ANSWER);
const { lesson } = guard(parsed, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const conversation = (project = null) => ({ id: "s_aaaa1111", title: 'Fix the "header"', project, projectName: project ? "Nova Island" : null, model: "opus" });

/** Every SKILL.md under skills/, parsed with its id, as a loader would. */
async function skillsIn(home) {
  const out = [];
  const walk = async (dir, id) => {
    let names;
    try {
      names = await readdir(resolve(home, "skills", dir));
    } catch {
      return;
    }
    if (names.includes("SKILL.md")) out.push(parseSkill(await get(home, `skills/${dir}/SKILL.md`), { id }));
    for (const n of names) if (n !== "SKILL.md") await walk(`${dir}/${n}`, `${id}/${n}`);
  };
  await walk("lessons", "lessons");
  return out;
}

/** Every lint problem, warnings included: a lesson must be clean. */
const problems = (skills) => lint(skills);

test("names come from the lesson's words, and are made unique", () => {
  assert.equal(nameFor("Before editing a generated file, find its generator and change the source instead"), "editing-generated-file-find-generator-change");
  assert.equal(nameFor("!!!"), "lesson");
  assert.equal(uniqueName("x", new Set()), "x");
  assert.equal(uniqueName("x", new Set(["x", "x-2"])), "x-3");
  assert.equal(scopeOf("p_0a1b2c3d"), "p-0a1b2c3d");
  assert.equal(scopeOf(null), "general");
});

test("a lesson from no project goes under general, with both parents, lint-clean", async () => {
  const { home, done } = await tempHome();
  try {
    const id = await writeLesson(home, { lesson, rows: parsed.rows, conversation: conversation(), now: new Date("2026-10-19T12:00:00Z") });
    assert.equal(id, "lessons/general/editing-generated-file-find-generator-change");
    const skills = await skillsIn(home);
    assert.deepEqual(skills.map((s) => s.id).sort(), ["lessons", "lessons/general", id]);
    assert.deepEqual(problems(skills), []);
    const skill = skills.find((s) => s.id === id);
    assert.equal(skill.description, "Before editing a generated file, find its generator and change the source instead. Use when a file you are about to edit is produced by a build or a generator.");
    assert.ok(wholeFirstSentence(skill.description).length <= 160);
    assert.ok(Buffer.byteLength(skill.description) <= 1024);
    assert.match(skill.body, /## Evidence\n\nFrom the conversation s_aaaa1111 "Fix the \\"header\\"", reflected on 2026-10-19 by opus\./);
    assert.match(skill.body, /- Row 2, \*\*helped\*\*: Found the generator/);
    assert.match(skill.body, /## Workspace facts \(verified 2026-10-19 in s_aaaa1111; re-verify before relying on them\)\n\n- in this workspace, dist\/ is rebuilt/);
    const index = await get(home, "reflections/lessons.json");
    assert.equal(index[id].from, "s_aaaa1111");
    assert.equal(index[id].createdAt, "2026-10-19T12:00:00.000Z");
  } finally {
    await done();
  }
});

test("a project's lesson goes under p-<hex8>, whose parent carries metadata.project", async () => {
  const { home, done } = await tempHome();
  try {
    const id = await writeLesson(home, { lesson, rows: parsed.rows, conversation: conversation("p_0a1b2c3d") });
    assert.match(id, /^lessons\/p-0a1b2c3d\//);
    const text = await get(home, "skills/lessons/p-0a1b2c3d/SKILL.md");
    assert.match(text, /^  project: p_0a1b2c3d$/m);
    assert.match(text, /Lessons from conversations in the project Nova Island\./);
    const skills = await skillsIn(home);
    assert.deepEqual(problems(skills), []);
    const parent = skills.find((s) => s.id === "lessons/p-0a1b2c3d");
    assert.equal(parent.name, "p-0a1b2c3d");
    if ("project" in parent) assert.equal(parent.project, "p_0a1b2c3d", "the skills library reads the scope as that project's");
  } finally {
    await done();
  }
});

test("a second lesson with the same words gets -2, and an edited parent is left alone", async () => {
  const { home, done } = await tempHome();
  try {
    await put(home, "skills/lessons/SKILL.md", "---\nname: lessons\ndescription: Mine. Use when ever.\n---\nMine.\n");
    const a = await writeLesson(home, { lesson, rows: parsed.rows, conversation: conversation() });
    const b = await writeLesson(home, { lesson, rows: parsed.rows, conversation: { ...conversation(), id: "s_bbbb2222" } });
    assert.equal(b, `${a}-2`);
    assert.equal(await get(home, "skills/lessons/SKILL.md"), "---\nname: lessons\ndescription: Mine. Use when ever.\n---\nMine.\n");
    const lessons = await listLessons(home);
    assert.deepEqual(lessons.map((l) => l.from).sort(), ["s_aaaa1111", "s_bbbb2222"]);
    assert.ok(lessons.every((l) => l.present && l.lesson.startsWith("Before editing")));
  } finally {
    await done();
  }
});

test("removing a scope's last lesson removes the scope it made, and only that", async () => {
  const { home, done } = await tempHome();
  try {
    const a = await writeLesson(home, { lesson, rows: parsed.rows, conversation: conversation("p_0a1b2c3d") });
    const g = await writeLesson(home, { lesson, rows: parsed.rows, conversation: conversation() });
    assert.ok((await get(home, "skills/lessons/p-0a1b2c3d/SKILL.md")).includes(WRITTEN_BY));
    assert.deepEqual(await removeLessons(home, [a]), [a]);
    assert.equal(await get(home, "skills/lessons/p-0a1b2c3d/SKILL.md"), null, "the empty project scope is gone");
    assert.ok(await get(home, "skills/lessons/general/SKILL.md"), "the other scope stays");
    assert.ok(await get(home, `skills/${g}/SKILL.md`));
    assert.deepEqual(Object.keys(await get(home, "reflections/lessons.json")), [g]);
    assert.deepEqual(await removeLessons(home, [a]), [], "a second removal finds nothing and says so");
  } finally {
    await done();
  }
});
