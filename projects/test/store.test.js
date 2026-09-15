// The store: create, list, save, remove, assign, and the validation of what save is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignSession, checkDirectory, listProjects, projectOfSession, readAssignments, readInstructions, readProject, removeProject, saveProject, validateProject } from "../lib/store.js";
import { makeEnv } from "./helpers.js";

test("a home without projects lists none and assigns nothing", async () => {
  const { env, done } = await makeEnv();
  assert.deepEqual(await listProjects(env), []);
  assert.deepEqual(await readAssignments(env), {});
  assert.equal(await projectOfSession(env, "s_1"), null);
  assert.equal(await readProject(env, "p_00000000"), null);
  await done();
});

test("create, read, update, and the files it writes", async () => {
  const { env, home, done } = await makeEnv();
  const fields = validateProject({ name: "  Thetis  ", directories: ["/srv/repos/thetis"], disable: ["exec"], instructions: "Be brief." });
  const created = await saveProject(env, null, fields);
  assert.match(created.id, /^p_[0-9a-f]{8}$/);
  assert.equal(created.name, "Thetis");
  assert.deepEqual(created.tools, { disable: ["exec"] });
  assert.deepEqual(created.skills, { disable: [] });
  assert.equal(await env.readFile(`projects/${created.id}.md`), "Be brief.");
  assert.ok(JSON.parse(await env.readFile(`projects/${created.id}.json`)).createdAt);

  const again = await readProject(env, created.id);
  assert.deepEqual(again, created);
  assert.equal(await readInstructions(env, created.id), "Be brief.");

  const updated = await saveProject(env, created.id, validateProject({ name: "Thetis 2", directories: [], disable: [], instructions: "" }));
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.name, "Thetis 2");
  assert.equal(await readInstructions(env, created.id), "");

  // instructions left out keep the file
  await env.writeFile(`projects/${created.id}.md`, "kept");
  await saveProject(env, created.id, validateProject({ name: "Thetis 3" }), { instructionsGiven: false });
  assert.equal(await readInstructions(env, created.id), "kept");
  assert.equal((await listProjects(env)).length, 1);
  assert.equal(home.length > 0, true);
  await done();
});

test("assign, list by creation, remove takes the assignments with it", async () => {
  const { env, done } = await makeEnv();
  const a = await saveProject(env, null, validateProject({ name: "A" }));
  const b = await saveProject(env, null, validateProject({ name: "B" }));
  await assignSession(env, "s_1", a.id);
  await assignSession(env, "s_2", a.id);
  await assignSession(env, "s_3", b.id);
  assert.equal((await projectOfSession(env, "s_1")).id, a.id);
  await assignSession(env, "s_2", null);
  assert.deepEqual(await readAssignments(env), { s_1: a.id, s_3: b.id });
  assert.deepEqual((await listProjects(env)).map((p) => p.name).sort(), ["A", "B"]);

  await removeProject(env, a.id);
  assert.equal(await readProject(env, a.id), null);
  assert.equal(await readInstructions(env, a.id), "");
  assert.deepEqual(await readAssignments(env), { s_3: b.id });
  assert.equal(await projectOfSession(env, "s_1"), null);
  await done();
});

test("an update of a missing project and a create past the limit are refused", async () => {
  const { env, done } = await makeEnv();
  await assert.rejects(saveProject(env, "p_deadbeef", validateProject({ name: "x" })), /No project p_deadbeef/);
  for (let i = 0; i < 32; i++) await saveProject(env, null, validateProject({ name: `p${i}` }));
  await assert.rejects(saveProject(env, null, validateProject({ name: "one more" })), /At most 32 projects/);
  await done();
});

test("validation: names, directories, tool names, instructions", () => {
  assert.throws(() => validateProject({ name: "" }), /needs a name/);
  assert.throws(() => validateProject({ name: "x".repeat(81) }), /over 80/);
  assert.throws(() => validateProject({ name: "x", directories: "nope" }), /list of paths/);
  assert.throws(() => validateProject({ name: "x", directories: ["relative/path"] }), /not absolute/);
  assert.throws(() => validateProject({ name: "x", directories: ["/srv/../etc"] }), /contains "\.\."/);
  assert.throws(() => validateProject({ name: "x", directories: ["/srv//repos"] }), /not normalized; write it as \/srv\/repos/);
  assert.throws(() => validateProject({ name: "x", directories: ["/srv/repos/"] }), /not normalized/);
  assert.throws(() => validateProject({ name: "x", directories: ["/a\0b"] }), /NUL/);
  assert.throws(() => validateProject({ name: "x", directories: Array.from({ length: 65 }, (_, i) => `/d${i}`) }), /at most 64 directories/);
  assert.throws(() => validateProject({ name: "x", disable: [3] }), /tool name/);
  assert.throws(() => validateProject({ name: "x", instructions: 5 }), /must be text/);
  assert.throws(() => validateProject({ name: "x", instructions: "y".repeat(32 * 1024 + 1) }), /over 32768/);
  assert.equal(checkDirectory("/"), "/");
  const ok = validateProject({ name: "x", directories: ["/a", "/a", "/b"], disable: ["exec", "exec"], instructions: undefined });
  assert.deepEqual(ok, { name: "x", directories: ["/a", "/b"], disable: ["exec"], instructions: "" });
});
