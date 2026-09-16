// The commands with a fake env: list with counts and the open conversation's project, get with the tool
// groups and the mount state, save as create and update, assign only for the page's own session, sessions,
// remove, and mounts. The UI modules are checked for syntax at the end, since no browser runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { uiAssign, uiGet, uiList, uiMounts, uiRemove, uiSave, uiSessions } from "../index.js";
import { makeEnv, PACKAGES } from "./helpers.js";

async function withMounts(value, fn) {
  const was = process.env.THETIS_MOUNTS;
  process.env.THETIS_MOUNTS = value;
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.THETIS_MOUNTS;
    else process.env.THETIS_MOUNTS = was;
  }
}

test("list on an empty home; get without an id is the template", async () => {
  const { env, done } = await makeEnv({ session: "s_1", packages: PACKAGES });
  assert.deepEqual(await uiList({}, env), { data: { projects: [], assignments: {}, current: null } });
  const { data } = await withMounts("[]", () => uiGet({}, env));
  assert.equal(data.project, null);
  assert.deepEqual(data.directories, []);
  assert.equal(data.instructions, "");
  assert.equal(data.conversations, 0);
  assert.deepEqual(data.mounts, []);
  assert.deepEqual(data.tools.map((g) => g.package), ["@thetis/tools-files", "@thetis/tool-exec"]);
  assert.deepEqual(data.tools[1].tools, [{ name: "exec", description: "Run", disabled: false }]);
  await done();
});

test("save creates and updates; get shows the record, the mount state, the disabled flags", async () => {
  const { env, done } = await makeEnv({ session: "s_1", packages: PACKAGES });
  const created = (await uiSave({ name: "Thetis", directories: ["/srv/repos/thetis", "/elsewhere"], disable: ["exec"], instructions: "Be brief." }, env)).data.project;
  assert.match(created.id, /^p_[0-9a-f]{8}$/);
  await withMounts(JSON.stringify([{ path: "/srv/repos", mode: "ro" }]), async () => {
    const { data } = await uiGet({ id: created.id }, env);
    assert.equal(data.project.name, "Thetis");
    assert.deepEqual(data.directories, [{ path: "/srv/repos/thetis", mounted: "ro" }, { path: "/elsewhere", mounted: null }]);
    assert.equal(data.instructions, "Be brief.");
    assert.deepEqual(data.mounts, [{ path: "/srv/repos", mode: "ro" }]);
    const exec = data.tools.find((g) => g.package === "@thetis/tool-exec").tools[0];
    assert.equal(exec.disabled, true);
    assert.equal(data.tools[0].tools[0].disabled, false);
  });
  const updated = (await uiSave({ id: created.id, name: "Thetis 2", directories: [], disable: [] }, env)).data.project;
  assert.equal(updated.id, created.id);
  assert.equal((await uiGet({ id: created.id }, env)).data.instructions, "Be brief.", "instructions left out are kept");
  await assert.rejects(uiSave({ id: "p_deadbeef", name: "x" }, env), /No project/);
  await assert.rejects(uiSave({ id: "nope", name: "x" }, env), /project id/);
  await assert.rejects(uiSave({ name: "x", directories: ["relative"] }, env), /not absolute/);
  await assert.rejects(uiGet({ id: "p_deadbeef" }, env), /No project/);
  await done();
});

test("assign works only for the page's own session; list counts and names the current project", async () => {
  const { env, done } = await makeEnv({ session: "s_1", packages: PACKAGES });
  const a = (await uiSave({ name: "A" }, env)).data.project;
  const b = (await uiSave({ name: "B" }, env)).data.project;
  await assert.rejects(uiAssign({ session: "s_9", project: a.id }, env), /conversation the page named/);
  await assert.rejects(uiAssign({ session: "s_1", project: "p_deadbeef" }, env), /No project/);
  await assert.rejects(uiAssign({ project: a.id }, env), /needs a session/);
  assert.deepEqual((await uiAssign({ session: "s_1", project: a.id }, env)).data, { session: "s_1", project: a.id });

  const other = { ...env, session: "s_2" };
  await uiAssign({ session: "s_2", project: a.id }, other);
  let list = (await uiList({}, env)).data;
  assert.equal(list.current, a.id);
  assert.deepEqual(list.projects.map((p) => [p.name, p.conversations, p.directories]), [["A", 2, 0], ["B", 0, 0]]);
  assert.deepEqual(list.assignments, { s_1: a.id, s_2: a.id });
  assert.deepEqual((await uiSessions({ project: a.id }, env)).data.sessions.sort(), ["s_1", "s_2"]);
  assert.deepEqual((await uiSessions({ project: b.id }, env)).data.sessions, []);
  assert.equal((await uiGet({ id: a.id }, env)).data.conversations, 2);

  await uiAssign({ session: "s_1", project: null }, env);
  list = (await uiList({}, env)).data;
  assert.equal(list.current, null);
  assert.equal(list.projects[0].conversations, 1);
  assert.equal((await uiList({}, { ...env, session: undefined })).data.current, null);
  await done();
});

test("remove deletes the record, the instructions and the assignments", async () => {
  const { env, done } = await makeEnv({ session: "s_1", packages: PACKAGES });
  const a = (await uiSave({ name: "A", instructions: "x" }, env)).data.project;
  await uiAssign({ session: "s_1", project: a.id }, env);
  assert.deepEqual((await uiRemove({ id: a.id }, env)).data, { removed: a.id });
  await assert.rejects(uiRemove({ id: a.id }, env), /No project/);
  await assert.rejects(uiRemove({}, env), /needs a project id/);
  assert.deepEqual((await uiList({}, env)).data, { projects: [], assignments: {}, current: null });
  await assert.rejects(env.readFile(`projects/${a.id}.md`), { code: "ENOENT" });
  await done();
});

test("mounts reports the fence's variable", async () => {
  const { env, done } = await makeEnv({});
  assert.deepEqual(await withMounts('[{"path":"/srv/x","mode":"rw"}]', () => uiMounts({}, env)), { data: { mounts: [{ path: "/srv/x", mode: "rw" }] } });
  assert.deepEqual(await withMounts("garbage", () => uiMounts({}, env)), { data: { mounts: [] } });
  await done();
});

test("the browser modules parse", () => {
  const ui = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
  const files = readdirSync(ui).filter((f) => f.endsWith(".js"));
  assert.ok(files.includes("index.js"));
  for (const f of files) execFileSync(process.execPath, ["--check", resolve(ui, f)]);
});

test("get lists the skills the loaders see, with the project's switches applied, and save writes skills.disable", async () => {
  const { env, home, done } = await makeEnv({ session: "s_1", packages: PACKAGES });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const pack = resolve(home, "pack/skills");
  const skill = (dir, name, description) => {
    mkdirSync(resolve(pack, dir), { recursive: true });
    writeFileSync(resolve(pack, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
  };
  skill("thetis", "thetis", "What Thetis is. Use first.");
  skill("thetis/using", "using", "Sessions and tools. Use when asked how.");
  skill("concise", "concise", "Few words. Use for brevity.");
  mkdirSync(resolve(home, "skills/mine"), { recursive: true });
  writeFileSync(resolve(home, "skills/mine/SKILL.md"), "---\nname: mine\ndescription: My own skill.\n---\nBody.\n");
  env.kernel.packages.list = async () => [...PACKAGES, { name: "@test/pack", version: "0.0.1", type: "skill", root: resolve(home, "pack"), thetis: { type: "skill", skills: "skills" } }];

  const template = (await withMounts("[]", () => uiGet({}, env))).data.skills;
  assert.deepEqual(
    template.map((s) => [s.id, s.package, s.disabled]),
    [["concise", "@test/pack", false], ["mine", null, false], ["thetis", "@test/pack", false], ["thetis/using", "@test/pack", false]]
  );
  assert.equal(template[0].brief, "`concise` — Few words.");
  assert.equal(template[0].short, "Few words.");
  assert.equal(template[0].universal, false);

  const created = (await uiSave({ name: "P", disableSkills: ["thetis"] }, env)).data.project;
  assert.deepEqual(created.skills, { disable: ["thetis"] });
  const { data } = await withMounts("[]", () => uiGet({ id: created.id }, env));
  assert.deepEqual(
    data.skills.map((s) => [s.id, s.disabled]),
    [["concise", false], ["mine", false], ["thetis", true], ["thetis/using", true]],
    "a switched-off parent takes its nested skill with it"
  );
  assert.deepEqual(data.tools[0].tools.map((t) => t.disabled), [false, false], "tools.disable is untouched");
  await assert.rejects(uiSave({ id: created.id, name: "P", disableSkills: ["Not An Id"] }, env), /skill id/);
  await done();
});
