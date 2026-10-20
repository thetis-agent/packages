// Where skills come from: every installed package that declares `thetis.skills`, then the person's own
// `skills/` under the home, later sources winning on an equal id. The walk uses node:fs against paths the
// fence can read (the packages directory and the home); parsing is cached per process by the mtime and size
// of each SKILL.md, because a turn re-reads the set and a body is only parsed when it changed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { lint, LIMITS, parseSkill, RESERVED } from "./skill.js";

const SKIP = new Set([...RESERVED, "node_modules", ".git"]);
const cache = new Map();

/** `packages` may be a PackageQuery (`ctx.packages`), an array of PackageInfo (`env.kernel.packages.list()`), or nothing. */
function packageList(packages) {
  if (!packages) return [];
  if (Array.isArray(packages)) return packages;
  if (typeof packages.list === "function") return packages.list();
  return [];
}

/** The directories to walk, in order: package packs first, the home last. */
export function sourcesOf(env, packages) {
  const roots = [];
  for (const pkg of packageList(packages)) {
    const dir = pkg?.thetis?.skills;
    if (typeof dir !== "string" || !dir || typeof pkg.root !== "string") continue;
    roots.push({ package: pkg.name, dir: resolve(pkg.root, dir) });
  }
  roots.push({ dir: resolve(env.cwd, "skills") });
  return roots;
}

function parseCached(path, id) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.id === id) return hit.skill;
  const skill = parseSkill(readFileSync(path, "utf8"), { id });
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, id, skill });
  return skill;
}

/** Forgets every parsed file. Tests use it; a turn never needs to. */
export function clearCache() {
  cache.clear();
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Walks one pack. Every directory with a SKILL.md is a skill; a subdirectory with one is a child. */
function walk(root, source, into) {
  const visit = (dir, prefix, depth) => {
    for (const entry of listDir(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const at = resolve(dir, entry.name);
      const file = resolve(at, "SKILL.md");
      if (!existsSync(file)) continue;
      const id = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (depth > LIMITS.depth) {
        into.set(id, { id, name: entry.name, description: "", tags: [], universal: false, related: [], body: "", contentHash: "", problems: [{ id, level: "error", message: `nested deeper than ${LIMITS.depth} levels` }], source: { ...source, path: file, dir: at }, children: [], resources: [] });
        continue;
      }
      const parsed = parseCached(file, id);
      if (!parsed) continue;
      const children = [];
      const resources = [];
      for (const sub of listDir(at)) {
        if (sub.name === "SKILL.md" || sub.name.startsWith(".")) continue;
        if (sub.isFile()) resources.push(sub.name);
        else if (sub.isDirectory()) {
          if (existsSync(resolve(at, sub.name, "SKILL.md")) && !SKIP.has(sub.name)) children.push(`${id}/${sub.name}`);
          else for (const f of listDir(resolve(at, sub.name))) if (f.isFile() && !f.name.startsWith(".")) resources.push(`${sub.name}/${f.name}`);
        }
      }
      // A fresh object per load: the cached record must not carry a stale source or children list.
      into.set(id, { ...parsed, problems: [...parsed.problems], source: { ...source, path: file, dir: at }, children, resources });
      visit(at, id, depth + 1);
    }
  };
  visit(root, "", 1);
}

/**
 * Every skill from every source, deduplicated, sorted by id. Each record is the parsed skill plus
 * `source: { package?, path, dir }`, `children` (ids) and `resources` (paths relative to the skill directory).
 */
export function loadSkills(env, packages) {
  const into = new Map();
  for (const src of sourcesOf(env, packages)) {
    const source = src.package ? { package: src.package } : {};
    walk(src.dir, source, into);
  }
  return [...into.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---- projects ----

const PROJECT_ID = /^p_[0-9a-f]{8}$/;

async function readJson(env, path) {
  let text;
  try {
    text = await env.readFile(path);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The session's project id from `projects/sessions.json` under the home, the file `@thetis/projects` writes, or null. */
export async function projectOf(env, session) {
  const id = typeof session === "string" ? session : session?.id;
  if (!id) return null;
  const map = await readJson(env, "projects/sessions.json");
  const project = map && typeof map === "object" && !Array.isArray(map) ? map[id] : undefined;
  return PROJECT_ID.test(String(project ?? "")) ? project : null;
}

/**
 * The ids a project switched off for this session, from `projects/sessions.json` and `projects/<id>.json`
 * under the home, the files `@thetis/projects` writes. An empty set when the session has no project.
 */
export async function excludedFor(env, session) {
  const project = await projectOf(env, session);
  if (!project) return new Set();
  const record = await readJson(env, `projects/${project}.json`);
  if (!record || record.id !== project) return new Set();
  const list = Array.isArray(record.skills?.disable) ? record.skills.disable : [];
  return new Set(list.filter((s) => typeof s === "string" && s));
}

export const underAny = (id, set) => {
  for (const x of set) if (id === x || id.startsWith(`${x}/`)) return true;
  return false;
};

/**
 * The ids `project` does not see: every skill whose `metadata.project` names another project, with the skills
 * nested under it. With no project, every project-scoped skill. These are not switched off, they belong
 * elsewhere, so a loader neither shows nor names them.
 */
export function hiddenIn(all, project) {
  const roots = new Set(all.filter((s) => s.project && s.project !== project).map((s) => s.id));
  return roots.size ? all.filter((s) => underAny(s.id, roots)).map((s) => s.id) : [];
}

/** The quiet note for the hidden set, or null when there is none. */
export function hiddenNote(count) {
  if (!count) return null;
  return count === 1 ? "1 skill belongs to another project" : `${count} skills belong to other projects`;
}

/**
 * What a loader works from: the skills without an error, minus what belongs to another project and what the
 * project switched off (a parent takes its children with it in both cases), the universal set capped at
 * `LIMITS.universal` by id, and the notes. A skill left out for an error or a switch gets a note of its own; the
 * skills of other projects get one count between them and are otherwise not named, not even as a nested id on
 * a parent's card, so the model has no id to fetch.
 */
export async function selectSkills(env, packages, session) {
  const all = loadSkills(env, packages);
  const problems = lint(all);
  const project = await projectOf(env, session);
  const hidden = hiddenIn(all, project);
  const away = new Set(hidden);
  const errored = new Map();
  for (const p of problems) if (p.level === "error" && !errored.has(p.id) && !away.has(p.id)) errored.set(p.id, p.message);
  const off = await excludedFor(env, session);
  const excluded = all.filter((s) => !away.has(s.id) && underAny(s.id, off)).map((s) => s.id);
  const skills = all
    .filter((s) => !errored.has(s.id) && !away.has(s.id) && !underAny(s.id, off))
    .map((s) => (away.size && s.children?.some((c) => away.has(c)) ? { ...s, children: s.children.filter((c) => !away.has(c)) } : s));
  const universal = skills.filter((s) => s.universal).slice(0, LIMITS.universal);
  const notes = [...errored].map(([id, message]) => `skill ${id} left out: ${message}`);
  if (excluded.length) notes.push(`switched off by the project: ${excluded.join(", ")}`);
  const quiet = hiddenNote(hidden.length);
  if (quiet) notes.push(quiet);
  return { all, skills, universal, excluded, hidden, project, problems, notes };
}
