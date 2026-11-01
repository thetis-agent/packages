// Maps and projects: the project of a conversation (the assignments map for a root, `projects/agents/<id>.json`
// for a subagent, the map wins, null when the project is gone or the id is not a safe file name), a map the
// agent makes landing in its conversation's project, one made in the tab landing in the project the page
// names, the rows saying when a map's project is gone, and assign moving a map in and out of a project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { projectOfSession } from "../lib/projects.js";
import { uiAssign, uiCreate, uiList, uiWatch } from "../lib/commands.js";
import { mapCreate } from "../lib/tools.js";
import { needMap } from "../lib/store.js";

const PROJECTS = [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }];

async function home({ session = "s_root", assignments = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "mm-projects-"));
  const put = async (p, value) => {
    const file = resolve(cwd, p);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  for (const p of PROJECTS) await put(`projects/${p.id}.json`, { id: p.id, name: p.name, directories: [] });
  if (Object.keys(assignments).length) await put("projects/sessions.json", assignments);
  return { env: { cwd, session: { id: session } }, put, done: () => rm(cwd, { recursive: true, force: true }) };
}
const idOf = (text) => /m_[0-9a-f]{8}/.exec(text)[0];

test("a subagent's project comes from its agents file; the map wins; a gone project is none", async () => {
  const { env, put, done } = await home({ assignments: { s_root: "p_00000001", s_both: "p_00000002" } });
  await put("projects/agents/s_child.json", { project: "p_00000001", parent: "s_root" });
  await put("projects/agents/s_both.json", { project: "p_00000001", parent: "s_root" });
  await put("projects/agents/s_gone.json", { project: "p_00000009", parent: "s_root" });
  assert.equal(await projectOfSession(env, "s_root"), "p_00000001");
  assert.equal(await projectOfSession(env, "s_child"), "p_00000001", "the agents file");
  assert.equal(await projectOfSession(env, "s_both"), "p_00000002", "the map first");
  assert.equal(await projectOfSession(env, "s_gone"), null, "its project is gone");
  assert.equal(await projectOfSession(env, "s_none"), null);
  assert.equal(await projectOfSession(env, "../projects/agents/s_child"), null, "not a file name");
  await done();
});

test("the agent's map is in its conversation's project; without project files it is in none", async () => {
  const { env, done } = await home({ assignments: { s_root: "p_00000002" } });
  const text = await mapCreate({ name: "Docks" }, env);
  assert.match(text, /in project "Orion" \(this conversation's\)/);
  assert.equal((await needMap(env, idOf(text))).project, "p_00000002");
  const bare = { cwd: await mkdtemp(join(tmpdir(), "mm-bare-")), session: { id: "s_root" } };
  const loose = await mapCreate({ name: "Loose" }, bare);
  assert.doesNotMatch(loose, /in project/);
  assert.equal((await needMap(bare, idOf(loose))).project, null);
  await rm(bare.cwd, { recursive: true, force: true });
  await done();
});

test("the tab makes a map in the page's project, the rows name it or say it is gone, assign moves it", async () => {
  const { env, done } = await home();
  const { map } = (await uiCreate({ name: "Nova map", project: "p_00000001" }, env)).data;
  assert.equal(map.project, "p_00000001");
  assert.equal(map.projectName, "Nova");
  assert.equal(map.projectMissing, false);
  await assert.rejects(uiCreate({ project: "p_00000009" }, env), /No project p_00000009/);
  await assert.rejects(uiCreate({ project: "nope" }, env), /project must be a project id/);
  const loose = (await uiCreate({}, env)).data.map;
  assert.equal(loose.project, null);
  let list = (await uiList({}, env)).data;
  assert.deepEqual(list.projects.map((p) => p.id).sort(), ["p_00000001", "p_00000002"]);
  await assert.rejects(uiAssign({ map: map.id, project: "p_00000009" }, env), /No project p_00000009/);
  await uiAssign({ map: loose.id, project: "p_00000002" }, env);
  list = (await uiList({}, env)).data;
  assert.equal(list.maps.find((m) => m.id === loose.id).project, "p_00000002");
  await uiAssign({ map: map.id, project: null }, env);
  assert.equal((await needMap(env, map.id)).project, null);
  // the project is deleted: its map says so, in the list and in the watch's snapshot
  await rm(resolve(env.cwd, "projects/p_00000002.json"));
  list = (await uiList({}, env)).data;
  const orphan = list.maps.find((m) => m.id === loose.id);
  assert.equal(orphan.projectMissing, true);
  assert.equal(orphan.projectName, null);
  const ac = new AbortController();
  const it = uiWatch({}, { ...env, signal: ac.signal });
  const snap = (await it.next()).value;
  assert.equal(snap.maps.find((m) => m.id === loose.id).projectMissing, true);
  assert.deepEqual(snap.projects, [{ id: "p_00000001", name: "Nova" }]);
  ac.abort();
  await it.return();
  await done();
});
