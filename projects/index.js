// Entry point: the two steps the manifest declares, and the commands the package's own page sends
// through `POST /api/ext/@thetis/projects/<verb>`. A command receives `(args, env)` where `env` is the
// fence environment plus `user`, `role` and the `session` the page named, already checked to be the
// person's own. Commands answer `{ data }`; a refusal is a thrown Error, which the gateway answers as
// `400 { error }` with the sentence. The mounts a command reports are this fence's own, from
// THETIS_MOUNTS: a person cannot call the operator's `mounts.list`, and does not need to.
import { currentMounts, mountModeOf } from "./lib/mounts.js";
import { assignSession, isProjectId, listProjects, projectOfSession, readAssignments, readInstructions, readProject, removeProject, saveProject, validateProject } from "./lib/store.js";

export { projectPrompt, projectTools } from "./lib/steps.js";

const fail = (message) => {
  throw new Error(message);
};

const summary = (project, assignments) => ({
  id: project.id,
  name: project.name,
  directories: project.directories.length,
  conversations: Object.values(assignments).filter((p) => p === project.id).length,
});

/** list: every project with counts, the whole assignments map, and the project of the open conversation. */
export async function uiList(_args, env) {
  const [projects, assignments] = await Promise.all([listProjects(env), readAssignments(env)]);
  const current = env.session ? (assignments[env.session] ?? null) : null;
  return { data: { projects: projects.map((p) => summary(p, assignments)), assignments, current: current && projects.some((p) => p.id === current) ? current : null } };
}

/** The tools of every installed package, grouped, each with whether this project switched it off. */
async function toolGroups(env, disabled) {
  const off = new Set(disabled);
  const groups = [];
  for (const pkg of await env.kernel.packages.list()) {
    const tools = (pkg.thetis?.tools ?? []).filter((t) => typeof t?.name === "string");
    if (!tools.length) continue;
    groups.push({ package: pkg.name, version: pkg.version, tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", disabled: off.has(t.name) })) });
  }
  return groups;
}

/**
 * Every skill the person's packages and home hold, read the way the loaders read them, each with whether
 * this project switched it off (directly, or through a switched-off parent). `@thetis/skills` is imported
 * when asked, not at the top, so a person without the library still has their projects: the list is then
 * empty and the page says so.
 */
async function skillList(env, disabled) {
  let lib;
  try {
    lib = await import("@thetis/skills");
  } catch {
    return [];
  }
  const off = new Set(disabled);
  const isOff = (id) => [...off].some((x) => id === x || id.startsWith(`${x}/`));
  return lib.loadSkills(env, await env.kernel.packages.list()).map((s) => ({ id: s.id, brief: lib.brief(s), short: lib.firstSentence(s.description), package: s.source?.package ?? null, universal: Boolean(s.universal), disabled: isOff(s.id) }));
}

/**
 * get: one project with its instructions, the mounts, the tool groups and the skills; without an id, the
 * empty template a new project's page starts from (the tools, skills and mounts are the same either way).
 */
export async function uiGet(args, env) {
  const id = args.id ?? null;
  if (id !== null && !isProjectId(id)) fail("get needs a project id like p_1a2b3c4d.");
  const project = id ? await readProject(env, id) : null;
  if (id && !project) fail(`No project ${id}.`);
  const mounts = currentMounts();
  const [instructions, assignments, tools, skills] = await Promise.all([project ? readInstructions(env, id) : "", readAssignments(env), toolGroups(env, project?.tools.disable ?? []), skillList(env, project?.skills.disable ?? [])]);
  const directories = (project?.directories ?? []).map((path) => ({ path, mounted: mountModeOf(path, mounts) }));
  const conversations = project ? Object.values(assignments).filter((p) => p === id).length : 0;
  return { data: { project, directories, instructions, conversations, mounts, tools, skills } };
}

/** save: create (no id) or update. `instructions` left out keeps the file as it is. */
export async function uiSave(args, env) {
  const id = args.id ?? null;
  if (id !== null && !isProjectId(id)) fail("save needs a project id like p_1a2b3c4d, or none to create.");
  const fields = validateProject(args);
  const project = await saveProject(env, id, fields, { instructionsGiven: args.instructions !== undefined });
  return { data: { project } };
}

/** remove: the record, its instructions, and its assignments are gone. */
export async function uiRemove(args, env) {
  if (!isProjectId(args.id)) fail("remove needs a project id.");
  if (!(await readProject(env, args.id))) fail(`No project ${args.id}.`);
  await removeProject(env, args.id);
  return { data: { removed: args.id } };
}

/** assign: puts the open conversation in a project, or takes it out with `project: null`. */
export async function uiAssign(args, env) {
  if (typeof args.session !== "string" || !args.session) fail("assign needs a session.");
  if (!env.session || args.session !== env.session) fail("assign works on the conversation the page named.");
  const project = args.project ?? null;
  if (project !== null) {
    if (!isProjectId(project)) fail("assign needs a project id, or null.");
    if (!(await readProject(env, project))) fail(`No project ${project}.`);
  }
  await assignSession(env, args.session, project);
  return { data: { session: args.session, project } };
}

/** sessions: the ids of the conversations in one project. */
export async function uiSessions(args, env) {
  if (!isProjectId(args.project)) fail("sessions needs a project id.");
  const assignments = await readAssignments(env);
  return { data: { sessions: Object.entries(assignments).filter(([, p]) => p === args.project).map(([s]) => s) } };
}

/** mounts: what this fence has bound, as the file tools see it. */
export async function uiMounts() {
  return { data: { mounts: currentMounts() } };
}

/** The project of a session, for other packages that import this one. */
export { projectOfSession };
