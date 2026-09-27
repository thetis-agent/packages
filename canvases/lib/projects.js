// What this package knows about projects: the record files `@thetis/projects` keeps under `projects/` in
// the person's home, read directly (as `@thetis/workflows` reads them) so a canvas can name a project and
// a person without the projects package still has their canvases — no directory, every canvas is global.
const ID = /^p_[0-9a-f]{8}$/;
export const isProjectId = (id) => typeof id === "string" && ID.test(id);

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

/** `{ id, name }` of one project, or null when there is no such record. */
export async function readProject(env, id) {
  if (!isProjectId(id)) return null;
  const record = await readJson(env, `projects/${id}.json`);
  if (!record || typeof record !== "object" || record.id !== id) return null;
  return { id, name: typeof record.name === "string" && record.name ? record.name : id };
}

export const projectExists = async (env, id) => Boolean(await readProject(env, id));

/** The project of a conversation, from the assignments map, when its record still exists; else null. */
export async function projectOfSession(env, session) {
  if (typeof session !== "string" || !session) return null;
  const map = await readJson(env, "projects/sessions.json");
  const id = map && typeof map === "object" && !Array.isArray(map) ? map[session] : null;
  return (await readProject(env, id)) ? id : null;
}

/** The names of the projects a list of canvases mentions, plus every project there is, for the page's menus. */
export async function projectNames(env, ids = []) {
  const { readdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  let names = [];
  try {
    names = await readdir(resolve(env.cwd, "projects"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const all = new Set([...names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isProjectId), ...ids.filter(isProjectId)]);
  const out = new Map();
  for (const id of all) {
    const record = await readProject(env, id);
    if (record) out.set(id, record.name);
  }
  return out;
}
