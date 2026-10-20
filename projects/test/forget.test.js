// The forget hook: the forgotten conversations leave the assignments map, the projects and every other
// conversation's assignment stay, and a second forget finds nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { forgetSession } from "../index.js";
import { assignSession, readAssignments, readProject, saveProject, validateProject } from "../lib/store.js";
import { makeEnv } from "./helpers.js";

test("preview answers nothing and changes nothing", async () => {
  const { env, done } = await makeEnv();
  const p = await saveProject(env, null, validateProject({ name: "Thetis" }));
  await assignSession(env, "s_a", p.id);
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s_a", sessions: ["s_a"] }, env), {});
  assert.deepEqual(await readAssignments(env), { s_a: p.id });
  await done();
});

test("forget drops every id of the subtree from the map, names the project, and keeps the rest", async () => {
  const { env, home, done } = await makeEnv();
  const p = await saveProject(env, null, validateProject({ name: "Thetis" }));
  const q = await saveProject(env, null, validateProject({ name: "Nova" }));
  await assignSession(env, "s_a", p.id);
  await assignSession(env, "s_child", p.id);
  await assignSession(env, "s_other", q.id);
  await assignSession(env, "s_keep", p.id);
  const out = await forgetSession({ phase: "forget", session: "s_a", sessions: ["s_a", "s_child", "s_other", "s_none"] }, env);
  assert.deepEqual(out, { removed: ["2 conversations taken out of the project Thetis.", "1 conversation taken out of the project Nova."] });
  assert.deepEqual(await readAssignments(env), { s_keep: p.id });
  assert.ok(await readProject(env, p.id), "the project itself stays");
  assert.deepEqual((await readdir(resolve(home, "projects"))).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left behind");
  await done();
});

test("forget is idempotent: a second run, and a home without projects, report nothing", async () => {
  const { env, done } = await makeEnv();
  const p = await saveProject(env, null, validateProject({ name: "Thetis" }));
  await assignSession(env, "s_a", p.id);
  const args = { phase: "forget", session: "s_a", sessions: ["s_a"] };
  assert.equal((await forgetSession(args, env)).removed.length, 1);
  assert.deepEqual(await forgetSession(args, env), { removed: [] });
  await done();
  const bare = await makeEnv();
  assert.deepEqual(await forgetSession(args, bare.env), { removed: [] });
  await bare.done();
});
