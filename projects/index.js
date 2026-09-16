// Entry point: the two steps the manifest declares, and the commands the package's own page sends
// through `POST /api/ext/@thetis/projects/<verb>`. A command receives `(args, env)` where `env` is the
// fence environment plus `user`, `role` and the `session` the page named, already checked to be the
// person's own. Commands answer `{ data }`; a refusal is a thrown Error, which the gateway answers as
// `400 { error }` with the sentence. The mounts a command reports are this fence's own, from
// THETIS_MOUNTS: a person cannot call the operator's `mounts.list`, and does not need to.
//
// Three commands are an admin's, because binding a host directory is the operator's authority and the
// kernel refuses `operator.*` to anyone else: `browse` lists host directories so a path can be picked
// instead of typed, `mount` binds or unbinds one, and `get` adds the mount list an admin may read. They
// act on the person's own fence alone: the user id comes from `env.user`, never from the page.
import { currentMounts, mountModeOf, stateOf } from "./lib/mounts.js";
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
 * The mounts written down for this person, which only an admin may read. The list says what the operator
 * asked for; `currentMounts` says what the fence took. The two differ when a host path is gone, and that
 * difference is the one a person cannot otherwise see, so the page is told about it.
 */
async function boundMounts(env) {
  if (env.role !== "admin") return null;
  try {
    const all = await env.kernel.operator.call("mounts.list", { user: env.user });
    const list = all?.[env.user];
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

/**
 * get: one project with its instructions, the mounts, the tool groups and the skills; without an id, the
 * empty template a new project's page starts from (the tools, skills and mounts are the same either way).
 * Every directory carries its state, so the page never has to guess whether the agent can reach it.
 */
export async function uiGet(args, env) {
  const id = args.id ?? null;
  if (id !== null && !isProjectId(id)) fail("get needs a project id like p_1a2b3c4d.");
  const project = id ? await readProject(env, id) : null;
  if (id && !project) fail(`No project ${id}.`);
  const mounts = currentMounts();
  const [instructions, assignments, tools, skills, bound] = await Promise.all([project ? readInstructions(env, id) : "", readAssignments(env), toolGroups(env, project?.tools.disable ?? []), skillList(env, project?.skills.disable ?? []), boundMounts(env)]);
  const directories = (project?.directories ?? []).map((path) => ({ path, mounted: mountModeOf(path, mounts), ...stateOf(path, mounts, bound, env.cwd) }));
  const conversations = project ? Object.values(assignments).filter((p) => p === id).length : 0;
  const states = Object.fromEntries(directories.map((d) => [d.path, { state: d.state, mode: d.mode, kind: d.kind, ...(d.mount ? { mount: d.mount } : {}), ...(d.home ? { home: true } : {}) }]));
  return { data: { project, directories, states, instructions, conversations, mounts, bound, tools, skills, user: env.user, admin: env.role === "admin" } };
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

/**
 * mounts: what this fence has bound, as the file tools see it, and the state of any `paths` the caller
 * asks about. The page asks after every edit, so a directory it has not saved yet still says whether the
 * agent could reach it; it is also the page's heartbeat, because binding a mount closes the fence and this
 * command answers again as soon as the new one is open.
 */
export async function uiMounts(args, env) {
  const mounts = currentMounts();
  const paths = (Array.isArray(args?.paths) ? args.paths : []).filter((p) => typeof p === "string" && p.startsWith("/")).slice(0, 64);
  const bound = paths.length ? await boundMounts(env) : null;
  return { data: { mounts, bound, states: Object.fromEntries(paths.map((p) => [p, stateOf(p, mounts, bound, env.cwd)])) } };
}

/** An absolute, normalized path, the way the kernel wants one: the page's own check is not trusted. */
function pathArg(value) {
  if (typeof value !== "string" || !value.startsWith("/")) fail("a directory is an absolute path, starting with /.");
  const path = value.replace(/\/+$/, "") || "/";
  if (path === "/" || path.split("/").includes("..") || path.includes("//")) fail(`${value} is not a directory a mount can name.`);
  return path;
}

/**
 * browse (admin): the directories under one host path, for the picker. A person's fence shows only what is
 * bound into it, so this reads through the operator, which the kernel allows an admin alone.
 */
export async function uiBrowse(args, env) {
  const path = args.path === undefined || args.path === "" ? "/" : args.path === "/" ? "/" : pathArg(args.path);
  return { data: await env.kernel.operator.call("mounts.browse", { path }) };
}

/**
 * mount (admin): binds one host directory into this person's own fence, or unbinds it with `mode: null`.
 * The whole list is sent, the way the command line sends it. The kernel closes the fence so it reopens
 * with the new binds, which also restarts the gateway serving this page: the answer may never arrive, and
 * the page treats a lost request as "ask again in a moment". The list that comes back says, per mount,
 * whether the host has a directory there, so a path that cannot work is named at once.
 */
export async function uiMount(args, env) {
  const path = pathArg(args.path);
  const mode = args.mode ?? null;
  if (mode !== null && mode !== "rw" && mode !== "ro") fail("a mount is read-write (rw) or read-only (ro).");
  const before = (await env.kernel.operator.call("mounts.list", { user: env.user }))?.[env.user] ?? [];
  const plain = before.map((m) => ({ path: m.path, mode: m.mode }));
  if (mode === null && !plain.some((m) => m.path === path)) {
    const covering = plain.find((m) => path.startsWith(`${m.path}/`));
    fail(covering ? `${path} is reached through the mount ${covering.path}. Unbind that one in the control panel.` : `${path} is not bound.`);
  }
  const mounts = [...plain.filter((m) => m.path !== path), ...(mode ? [{ path, mode }] : [])];
  const after = await env.kernel.operator.call("mounts.set", { user: env.user, mounts });
  const list = Array.isArray(after) ? after : [];
  return { data: { mounts: list, mount: list.find((m) => m.path === path) ?? null } };
}

/** The project of a session, for other packages that import this one. */
export { projectOfSession };
