// The two steps with a fake ctx: the prompt section is appended only for an assigned session, with the
// mount state of each directory; the tools are filtered only when the project switched some off; and an
// unassigned session gets nothing back from either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectPrompt, projectSection, projectTools } from "../lib/steps.js";
import { assignSession, saveProject, validateProject } from "../lib/store.js";
import { describeDirectory, mountsFromEnv, mountModeOf, stateOf } from "../lib/mounts.js";
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
    // A mounted path the fence cannot stat says so; an unmounted one says the agent cannot use it at all.
    assert.match(system, /^- \/srv\/repos\/thetis \(mounted rw, but nothing is at this path: make the directory before you work in it\)$/m);
    assert.match(system, /^- \/srv\/docs \(mounted ro, but nothing is at this path/m);
    assert.match(system, /^- \/home\/alice\/x \(NOT USABLE: no mount covers it, .*thetis mounts add alice \/home\/alice\/x.*\)$/m);
    assert.match(system, /^A directory marked NOT USABLE is outside this workspace/m);
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

test("state: a mount is not enough, and a mount the fence did not take is its own case", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const mounts = [{ path: here, mode: "rw" }, { path: "/srv/gone", mode: "ro" }];
  assert.deepEqual(stateOf(here, mounts), { state: "ready", mode: "rw", kind: "dir" });
  assert.deepEqual(stateOf(resolve(here, "steps.test.js"), mounts), { state: "not-a-directory", mode: "rw", kind: "file" });
  assert.deepEqual(stateOf(resolve(here, "nothing-here"), mounts), { state: "empty-path", mode: "rw", kind: "none" });
  assert.deepEqual(stateOf("/srv/gone/x", mounts), { state: "empty-path", mode: "ro", kind: "none" });
  assert.deepEqual(stateOf("/elsewhere", mounts), { state: "unmounted", mode: null, kind: "none" });
  // With the operator's list, a bind the fence dropped is told apart from a path nobody ever bound.
  const bound = [{ path: "/srv/typo", mode: "rw", present: false, kind: "none" }];
  assert.deepEqual(stateOf("/srv/typo/inner", mounts, bound), { state: "skipped", mode: "rw", kind: "none", mount: "/srv/typo" });
  assert.deepEqual(stateOf("/elsewhere", mounts, bound), { state: "unmounted", mode: null, kind: "none" });
  assert.match(describeDirectory("/srv/typo", [], "alice", bound), /NOT USABLE: \/srv\/typo is written down as a mount/);
  assert.match(describeDirectory(here, mounts, "alice"), /\(mounted rw\)$/);
});

test("state: a directory inside the person's own space needs no mount, and the prompt does not ask for one", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const home = resolve(here, "..");
  assert.deepEqual(stateOf(here, [], null, home), { state: "ready", mode: "rw", kind: "dir", home: true });
  assert.deepEqual(stateOf(resolve(home, "nothing"), [], null, home), { state: "empty-path", mode: "rw", kind: "none", home: true });
  assert.deepEqual(stateOf("/elsewhere", [], null, home), { state: "unmounted", mode: null, kind: "none" });
  assert.match(describeDirectory(here, [], "alice", null, home), /\(in your space\)$/);
  // A project whose directories are all inside the space carries no warning line for the model.
  const section = projectSection({ name: "Home", directories: [here] }, "", [], "alice", home);
  assert.doesNotMatch(section, /NOT USABLE/);
});
