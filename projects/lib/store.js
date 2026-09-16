// The files of this package, all under `projects/` in the person's home, written only by its own
// commands: `<id>.json` is a project's record, `<id>.md` its standing instructions (the PROJECT.md of the
// design, kept flat beside the record so a remove is two unlinks), and `sessions.json` maps a session id
// to the project it belongs to. Reads and writes go through the fence environment (`readFile`,
// `writeFile`, relative to the home), so a step and a command use the same door; only listing the
// directory and deleting a file need the filesystem, against `env.cwd`. A missing file is an empty
// value, never an error, because a person without projects is the normal case.
import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

export const DIR = "projects";
export const LIMITS = Object.freeze({ projects: 32, name: 80, directories: 64, disable: 256, toolName: 64, skillId: 200, instructions: 32 * 1024 });

/** A skill id as `@thetis/skills` defines it: up to three lowercase segments joined by `/`. */
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,2}$/;

export const recordPath = (id) => `${DIR}/${id}.json`;
export const instructionsPath = (id) => `${DIR}/${id}.md`;
export const assignmentsPath = () => `${DIR}/sessions.json`;

const ID = /^p_[0-9a-f]{8}$/;
export const isProjectId = (id) => typeof id === "string" && ID.test(id);
export const newId = () => `p_${randomBytes(4).toString("hex")}`;

async function readJson(env, path, fallback) {
  let text;
  try {
    text = await env.readFile(path);
  } catch (e) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const writeJson = (env, path, value) => env.writeFile(path, JSON.stringify(value, null, 2) + "\n");

// ---- records ----

/** The record of one project, or null. A file that does not parse, or whose id disagrees, is null too. */
export async function readProject(env, id) {
  if (!isProjectId(id)) return null;
  const record = await readJson(env, recordPath(id), null);
  return record && typeof record === "object" && record.id === id ? complete(record) : null;
}

/** Fills the fields an older or hand-edited record may lack, so callers never test for them. */
function complete(record) {
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : record.id,
    directories: Array.isArray(record.directories) ? record.directories.filter((d) => typeof d === "string") : [],
    tools: { disable: Array.isArray(record.tools?.disable) ? record.tools.disable.filter((t) => typeof t === "string") : [] },
    skills: { disable: Array.isArray(record.skills?.disable) ? record.skills.disable.filter((t) => typeof t === "string") : [] },
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

/** Every project, by creation time, then name. Files that are not `p_<8 hex>.json` are ignored. */
export async function listProjects(env) {
  let names;
  try {
    names = await readdir(resolve(env.cwd, DIR));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const ids = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isProjectId);
  const records = await Promise.all(ids.map((id) => readProject(env, id)));
  return records.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function writeProject(env, record) {
  await writeJson(env, recordPath(record.id), record);
}

export async function readInstructions(env, id) {
  try {
    return await env.readFile(instructionsPath(id));
  } catch (e) {
    if (e?.code === "ENOENT") return "";
    throw e;
  }
}

export async function writeInstructions(env, id, text) {
  await env.writeFile(instructionsPath(id), text);
}

/** Deletes the record, its instructions, and every assignment that pointed at it. */
export async function removeProject(env, id) {
  if (!isProjectId(id)) return;
  await rm(resolve(env.cwd, recordPath(id)), { force: true });
  await rm(resolve(env.cwd, instructionsPath(id)), { force: true });
  const map = await readAssignments(env);
  const kept = Object.fromEntries(Object.entries(map).filter(([, project]) => project !== id));
  if (Object.keys(kept).length !== Object.keys(map).length) await writeJson(env, assignmentsPath(), kept);
}

// ---- assignments ----

/** `{ "<session id>": "<project id>" }`; entries with a malformed project id are dropped on read. */
export async function readAssignments(env) {
  const map = await readJson(env, assignmentsPath(), {});
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([session, project]) => typeof session === "string" && isProjectId(project)));
}

/** Sets or, with `project` null, clears one session's project. */
export async function assignSession(env, session, project) {
  const map = await readAssignments(env);
  if (project) map[session] = project;
  else delete map[session];
  await writeJson(env, assignmentsPath(), map);
  return map;
}

/** The project a session belongs to, or null. */
export async function projectOfSession(env, session) {
  if (typeof session !== "string" || !session) return null;
  const map = await readAssignments(env);
  return map[session] ? await readProject(env, map[session]) : null;
}

// ---- validation ----

const fail = (message) => {
  throw new Error(message);
};

/** A directory is an absolute, normalized path with no `..`, no NUL, and no trailing slash. */
export function checkDirectory(value) {
  if (typeof value !== "string" || !value) fail("A project directory must be a path.");
  if (value.includes("\0")) fail(`${JSON.stringify(value)} contains a NUL byte.`);
  if (!isAbsolute(value)) fail(`${value} is not absolute; a project directory is an absolute path.`);
  if (value.split("/").includes("..")) fail(`${value} contains "..".`);
  const clean = normalize(value).replace(/\/+$/, "") || "/";
  if (clean !== value) fail(`${value} is not normalized; write it as ${clean}.`);
  return clean;
}

/**
 * Checks what `save` was given and returns the fields to store. Sizes are the limits above; directories,
 * tool names and skill ids are deduplicated in order. An empty name is refused because the switcher shows
 * it. `disable` holds tool names (`tools.disable`); `disableSkills` holds skill ids (`skills.disable`).
 */
export function validateProject({ name, directories, disable, disableSkills, instructions } = {}) {
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName) fail("A project needs a name.");
  if (cleanName.length > LIMITS.name) fail(`The name is over ${LIMITS.name} characters.`);
  if (directories !== undefined && !Array.isArray(directories)) fail("directories must be a list of paths.");
  const dirs = [...new Set((directories ?? []).map(checkDirectory))];
  if (dirs.length > LIMITS.directories) fail(`A project holds at most ${LIMITS.directories} directories.`);
  if (disable !== undefined && !Array.isArray(disable)) fail("disable must be a list of tool names.");
  const tools = [...new Set(disable ?? [])];
  for (const t of tools) if (typeof t !== "string" || !t || t.length > LIMITS.toolName) fail("A tool name is a string of at most 64 characters.");
  if (tools.length > LIMITS.disable) fail(`At most ${LIMITS.disable} tools can be switched off.`);
  if (disableSkills !== undefined && !Array.isArray(disableSkills)) fail("disableSkills must be a list of skill ids.");
  const skills = [...new Set(disableSkills ?? [])];
  for (const s of skills) if (typeof s !== "string" || s.length > LIMITS.skillId || !SKILL_ID.test(s)) fail("A skill id is lowercase words and dashes, up to three levels joined by /.");
  if (skills.length > LIMITS.disable) fail(`At most ${LIMITS.disable} skills can be switched off.`);
  if (instructions !== undefined && typeof instructions !== "string") fail("instructions must be text.");
  const text = instructions ?? "";
  if (text.length > LIMITS.instructions) fail(`The instructions are over ${LIMITS.instructions} characters.`);
  return { name: cleanName, directories: dirs, disable: tools, disableSkills: skills, instructions: text };
}

/**
 * Creates or updates a project from validated fields. A create is refused past the project limit. The
 * instructions file is written when the text was given, even empty, so a cleared editor clears the file.
 */
export async function saveProject(env, id, fields, { instructionsGiven = true } = {}) {
  const now = new Date().toISOString();
  let record;
  if (id) {
    const before = await readProject(env, id);
    if (!before) fail(`No project ${id}.`);
    record = { ...before, name: fields.name, directories: fields.directories, tools: { disable: fields.disable }, skills: { disable: fields.disableSkills ?? [] }, updatedAt: now };
  } else {
    const count = (await listProjects(env)).length;
    if (count >= LIMITS.projects) fail(`At most ${LIMITS.projects} projects; delete one first.`);
    record = { id: newId(), name: fields.name, directories: fields.directories, tools: { disable: fields.disable }, skills: { disable: fields.disableSkills ?? [] }, createdAt: now, updatedAt: now };
  }
  await writeProject(env, record);
  if (instructionsGiven) await writeInstructions(env, record.id, fields.instructions);
  return record;
}
