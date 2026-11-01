// The project of a conversation: the assignments map for a root, `projects/agents/<id>.json` for a subagent
// (the map wins), and null when the project named is gone or the id is not a safe file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectOfSession } from "../lib/projects.js";
import { makeEnv } from "./helpers.js";

const PROJECTS = [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }];

test("a subagent's project comes from its agents file; the map wins; a gone project is none", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS, assignments: { s_root: "p_00000001", s_both: "p_00000002" } });
  await env.writeFile("projects/agents/s_child.json", JSON.stringify({ project: "p_00000001", parent: "s_root" }));
  await env.writeFile("projects/agents/s_both.json", JSON.stringify({ project: "p_00000001", parent: "s_root" }));
  await env.writeFile("projects/agents/s_gone.json", JSON.stringify({ project: "p_00000009", parent: "s_root" }));
  assert.equal(await projectOfSession(env, "s_root"), "p_00000001");
  assert.equal(await projectOfSession(env, "s_child"), "p_00000001", "the agents file");
  assert.equal(await projectOfSession(env, "s_both"), "p_00000002", "the map first");
  assert.equal(await projectOfSession(env, "s_gone"), null, "its project is gone");
  assert.equal(await projectOfSession(env, "s_none"), null);
  assert.equal(await projectOfSession(env, "../projects/agents/s_child"), null, "not a file name");
  await done();
});
