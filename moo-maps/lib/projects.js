// What this package knows about projects: the record files `@thetis/projects` keeps under `projects/` in
// the person's home, read directly (as `@thetis/canvases` and `@thetis/workflows` read them) so a map can
// name a project and a person without the projects package still has their maps — no directory, every map
// is in no project.
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ID = /^p_[0-9a-f]{8}$/;
const SESSION = /^[\w-]+$/; // a conversation id, safe as a file name
export const isProjectId = (id) => typeof id === "string" && ID.test(id);

async function readJson(env, path) {
  let text;
  try {
    text = await readFile(resolve(env.cwd, path), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `{ id, name }` of one project, or null when there is no such record. */
export async function readProject(env, id) {
  if (!isProjectId(id)) return null;
  const record = await readJson(env, `projects/${id}.json`);
  if (!record || typeof record !== "object" || record.id !== id) return null;
  return { id, name: typeof record.name === "string" && record.name ? record.name : id };
}

export const projectExists = async (env, id) => Boolean(await readProject(env, id));

/** The project of a conversation, when its record still exists; else null. The assignments map holds root
 *  conversations; a subagent's project is in `projects/agents/<id>.json`, written when it first runs. */
export async function projectOfSession(env, session) {
  if (typeof session !== "string" || !session) return null;
  const map = await readJson(env, "projects/sessions.json");
  let id = map && typeof map === "object" && !Array.isArray(map) ? map[session] : null;
  if (id == null && SESSION.test(session)) id = (await readJson(env, `projects/agents/${session}.json`))?.project ?? null;
  return (await readProject(env, id)) ? id : null;
}

/** The names of every project there is, plus any of `ids` still on record: id → name. */
export async function projectNames(env, ids = []) {
  let names = [];
  try {
    names = await readdir(resolve(env.cwd, "projects"));
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
  }
  const all = new Set([...names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isProjectId), ...ids.filter(isProjectId)]);
  const out = new Map();
  for (const id of all) {
    const record = await readProject(env, id);
    if (record) out.set(id, record.name);
  }
  return out;
}
