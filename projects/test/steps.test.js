// The two steps with a fake ctx: the prompt section is appended only for an assigned session, with the
// mount state of each directory; the tools are filtered only when the project switched some off; and an
// unassigned session gets nothing back from either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectPrompt, projectSection, projectTools } from "../lib/steps.js";
import { assignSession, saveProject, validateProject } from "../lib/store.js";
import { mountsFromEnv, mountModeOf } from "../lib/mounts.js";
import { makeEnv } from "./helpers.js";

const TOOLS = [{ name: "exec" }, { name: "read_path" }, { name: "write_path" }];
const ctxFor = (env, session) => ({ session: { id: session, user: "alice" }, call: { model: "m", system: "BASE", tools: TOOLS, messages: [] }, harness: {}, env });

test("an unassigned session changes nothing", async () => {
  const { env, done } = await makeEnv();
  assert.equal(await projectPrompt(ctxFor(env, "s_1")), undefined);
  assert.equal(await projectTools(ctxFor(env, "s_1")), undefined);
  await done();
});

test("prompt: the section is appended after the system prompt, with directories and instructions", async () => {
  const { env, done } = await makeEnv();
  const p = await saveProject(env, null, validateProject({ name: "Thetis", directories: ["/srv/repos/thetis", "/srv/docs", "/home/alice/x"], instructions: "Be brief.\n" }));
  await assignSession(env, "s_1", p.id);
  const was = process.env.THETIS_MOUNTS;
  process.env.THETIS_MOUNTS = JSON.stringify([{ path: "/srv/repos", mode: "rw" }, { path: "/srv/docs", mode: "ro" }]);
  try {
    const out = await projectPrompt(ctxFor(env, "s_1"));
    const system = out.call.system;
    assert.ok(system.startsWith("BASE\n\n## Project: Thetis\n"));
    assert.match(system, /^- \/srv\/repos\/thetis \(mounted rw\)$/m);
    assert.match(system, /^- \/srv\/docs \(mounted ro\)$/m);
    assert.match(system, /^- \/home\/alice\/x \(not mounted — ask an admin: thetis mounts add alice \/home\/alice\/x\)$/m);
    assert.match(system, /### Instructions\nBe brief\.$/);
    assert.deepEqual(out.call.tools, TOOLS);
    assert.equal(await projectTools(ctxFor(env, "s_1")), undefined, "nothing switched off: the call phase returns nothing");
  } finally {
    if (was === undefined) delete process.env.THETIS_MOUNTS;
    else process.env.THETIS_MOUNTS = was;
  }
  await done();
});

test("prompt: a project with no directories and no instructions says so and adds no instructions heading", () => {
  const text = projectSection({ name: "Bare", directories: [] }, "  \n", [], "alice");
  assert.equal(text, "## Project: Bare\nThis project has no project directories.");
  const empty = projectSection({ name: "Bare", directories: [] }, "", [], "alice");
  assert.equal(empty, text);
});

test("call: the switched-off tools leave call.tools; the rest of the call is kept", async () => {
  const { env, done } = await makeEnv();
  const p = await saveProject(env, null, validateProject({ name: "Quiet", disable: ["exec", "write_path", "missing"] }));
  await assignSession(env, "s_2", p.id);
  const out = await projectTools(ctxFor(env, "s_2"));
  assert.deepEqual(out.call.tools.map((t) => t.name), ["read_path"]);
  assert.equal(out.call.system, "BASE");
  assert.equal(out.harness, undefined);
  await done();
});

test("a stale assignment to a deleted project is as good as none", async () => {
  const { env, done } = await makeEnv();
  await assignSession(env, "s_3", "p_deadbeef");
  assert.equal(await projectPrompt(ctxFor(env, "s_3")), undefined);
  assert.equal(await projectTools(ctxFor(env, "s_3")), undefined);
  await done();
});

test("mounts: the variable is parsed the way tools-files parses it, and a directory under a mount inherits its mode", () => {
  assert.deepEqual(mountsFromEnv(undefined), []);
  assert.deepEqual(mountsFromEnv("not json"), []);
  assert.deepEqual(mountsFromEnv('{"a":1}'), []);
  const mounts = mountsFromEnv('[{"path":"/srv/x","mode":"rw"},{"path":"rel","mode":"rw"},{"path":"/srv/y","mode":"zz"},{"path":"/srv/z","mode":"ro"}]');
  assert.deepEqual(mounts, [{ path: "/srv/x", mode: "rw" }, { path: "/srv/z", mode: "ro" }]);
  assert.equal(mountModeOf("/srv/x", mounts), "rw");
  assert.equal(mountModeOf("/srv/x/deep/er", mounts), "rw");
  assert.equal(mountModeOf("/srv/xy", mounts), null);
  assert.equal(mountModeOf("/srv/z/a", mounts), "ro");
  assert.equal(mountModeOf("/", mounts), null);
});
