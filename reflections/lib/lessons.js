// The lesson writer: a lesson the guard let through becomes a skill under `skills/lessons/` in the home,
// where every skills loader already looks. The tree is three levels, the most the format allows:
//
//   skills/lessons/SKILL.md                 the parent of every lesson
//   skills/lessons/general/SKILL.md         lessons from conversations in no project
//   skills/lessons/p-<hex8>/SKILL.md        lessons from one project, `metadata.project: p_<hex8>`
//   skills/lessons/<scope>/<name>/SKILL.md  one lesson
//
// A project's scope directory is `p-` and not `p_` because a skill name is `[a-z0-9-]`; the project id
// itself goes in `metadata.project`, which the skills loaders read to hide a project's lessons (and the
// lessons under them) from every other project. `reflections/lessons.json` says which conversation each
// lesson came from, so a forget can take its lessons with it and the Lessons tab can link back.
import { list, readText, remove, writeText } from "./files.js";
import { readLessonsIndex, writeLessonsIndex } from "./records.js";

export const ROOT = "skills/lessons";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_CHARS = 48;
/** The line a parent this package wrote carries, so a forget removes only a scope directory it made itself. */
export const WRITTEN_BY = "<!-- written by @thetis/reflections; removed with its last lesson -->";
const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "it", "its", "is", "be", "as", "that", "this", "than", "then", "from", "into", "before", "after", "when", "if", "any", "each", "every", "your", "you"]);

export const scopeOf = (project) => (project && /^p_[0-9a-f]{8}$/.test(project) ? `p-${project.slice(2)}` : "general");
export const lessonPath = (id) => `skills/${id}/SKILL.md`;

/** A JSON-quoted string: the skills frontmatter reads it back exactly, whatever it holds. */
const q = (s) => JSON.stringify(String(s ?? ""));

/** A skill name from the lesson: its first content words, `[a-z0-9-]`, at most 48 characters. */
export function nameFor(lesson) {
  const words = String(lesson ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w && !STOP.has(w));
  let name = "";
  for (const w of words) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > NAME_CHARS) break;
    name = next;
    if (name.split("-").length >= 6) break;
  }
  return NAME_RE.test(name) ? name : "lesson";
}

/** `base`, or `base-2`, `base-3`, … whichever names no directory yet. */
export function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const suffix = `-${k}`;
    const name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

function rootSkill() {
  return `---
name: lessons
description: "Lessons from your archived conversations: each one a procedure for one situation, with the evidence it came from. Use when a situation in front of you matches one of the lessons below; read it before acting on it."
metadata:
  title: Lessons
  tags: [lessons, reflections]
---
# Lessons

Each lesson under this skill was written by Reflections after a conversation was archived: one procedure, the situation it applies to, and the evidence from that conversation. A lesson is a hypothesis that held once. Follow it when its situation is in front of you, and say so when the situation turns out to differ.

Workspace facts in a lesson were true on the day they were seen. Re-verify one before relying on it.

${WRITTEN_BY}
`;
}

function generalSkill() {
  return `---
name: general
description: "Lessons from conversations that belong to no project. Use when a situation in front of you matches one of the lessons below."
metadata:
  title: General lessons
  tags: [lessons]
---
# General lessons

Lessons from conversations that were in no project when they were archived.

${WRITTEN_BY}
`;
}

function projectSkill(project, name) {
  return `---
name: ${scopeOf(project)}
description: ${q(`Lessons from conversations in the project ${name}. Use when you work in that project and a situation matches one of the lessons below.`)}
metadata:
  title: ${q(`Lessons: ${name}`)}
  tags: [lessons]
  project: ${project}
---
# Lessons from ${name}

Lessons from conversations in the project ${name} (${project}). Only conversations in that project see them.

${WRITTEN_BY}
`;
}

/** The SKILL.md of one lesson. */
export function lessonSkill({ name, lesson, conversation, rows, date }) {
  const description = `${lesson.lesson}. Use when ${lesson.cue}.`;
  const cited = lesson.rows.map((r) => rows[r - 1]).filter(Boolean);
  const rowLines = cited.map((r) => `- Row ${r.n}, **${r.verdict}**: ${r.approach.replace(/[.\s]*$/, ".")} Observed: ${r.observed}`);
  const facts = lesson.facts.length
    ? `\n## Workspace facts (verified ${date} in ${conversation.id}; re-verify before relying on them)\n\n${lesson.facts.map((f) => `- ${f}`).join("\n")}\n`
    : "";
  return `---
name: ${name}
description: ${q(description)}
metadata:
  tags: [lesson]
  version: 1
---
# ${lesson.lesson}

Use when ${lesson.cue}.

## Evidence

From the conversation ${conversation.id} ${q(conversation.title || "Untitled")}, reflected on ${date}${conversation.model ? ` by ${conversation.model}` : ""}. Event numbers refer to that conversation's exported trajectory.

${rowLines.join("\n")}

Cited: ${lesson.evidence}

## Confidence

${lesson.confidence}
${facts}`;
}

/** Writes a parent SKILL.md unless one is there: a person may have edited it, and it is theirs then. */
async function ensure(home, rel, text) {
  if ((await readText(home, rel)) !== null) return false;
  await writeText(home, rel, text);
  return true;
}

/**
 * Writes one lesson and whatever parents it needs, and records where it came from. Answers the skill id,
 * `lessons/<scope>/<name>`.
 *
 * @param conversation `{ id, title, project, projectName, model }`.
 */
export async function writeLesson(home, { lesson, rows, conversation, now = new Date() }) {
  const scope = scopeOf(conversation.project);
  await ensure(home, `${ROOT}/SKILL.md`, rootSkill());
  if (scope === "general") await ensure(home, `${ROOT}/general/SKILL.md`, generalSkill());
  else await ensure(home, `${ROOT}/${scope}/SKILL.md`, projectSkill(conversation.project, conversation.projectName || conversation.project));
  const taken = new Set(await list(home, `${ROOT}/${scope}`));
  const name = uniqueName(nameFor(lesson.lesson), taken);
  const id = `lessons/${scope}/${name}`;
  const date = now.toISOString().slice(0, 10);
  await writeText(home, lessonPath(id), lessonSkill({ name, lesson, conversation, rows, date }));
  const index = await readLessonsIndex(home);
  index[id] = { from: conversation.id, createdAt: now.toISOString(), lesson: lesson.lesson };
  await writeLessonsIndex(home, index);
  return id;
}

/**
 * Removes lessons by skill id: each directory, its entry in lessons.json, and a scope directory left with
 * no lesson in it when this package wrote its SKILL.md. Answers the ids that were there to remove.
 */
export async function removeLessons(home, ids) {
  const index = await readLessonsIndex(home);
  const removed = [];
  const scopes = new Set();
  for (const id of ids) {
    if (!/^lessons\/[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) continue;
    const there = (await readText(home, lessonPath(id))) !== null;
    if (there) await remove(home, `skills/${id}`);
    if (there || index[id]) removed.push(id);
    delete index[id];
    scopes.add(id.split("/")[1]);
  }
  await writeLessonsIndex(home, index);
  for (const scope of scopes) {
    const dir = `${ROOT}/${scope}`;
    const left = (await list(home, dir)).filter((n) => n !== "SKILL.md");
    const own = (await readText(home, `${dir}/SKILL.md`))?.includes(WRITTEN_BY);
    if (!left.length && own) await remove(home, dir);
  }
  return removed;
}

/** Every lesson in lessons.json with what the Lessons tab shows: scope, the sentence, its source, and whether it is still on disk. */
export async function listLessons(home) {
  const index = await readLessonsIndex(home);
  const out = [];
  for (const [id, entry] of Object.entries(index)) {
    const text = await readText(home, lessonPath(id));
    const description = text ? (/^description:\s*(.*)$/m.exec(text)?.[1] ?? "") : "";
    let sentence = entry?.lesson ?? "";
    try {
      if (description.startsWith('"')) sentence = JSON.parse(description).replace(/\. Use when .*$/s, "");
    } catch {
      /* the person edited it into something else; the recorded sentence stands */
    }
    out.push({ id, scope: id.split("/")[1], from: entry?.from ?? null, createdAt: entry?.createdAt ?? null, lesson: sentence, present: text !== null, path: lessonPath(id) });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
