// Mounts: a host path the fence announces in THETIS_MOUNTS is a root, rw or ro as granted.
// The variable is read once when lib/paths.js loads, so it is set before the import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const rwMount = await mkdtemp(resolve(tmpdir(), "tf-mount-rw-"));
const roMount = await mkdtemp(resolve(tmpdir(), "tf-mount-ro-"));
process.env.THETIS_MOUNTS = JSON.stringify([{ path: rwMount, mode: "rw" }, { path: roMount, mode: "ro" }]);
const { resolveContained, mountsFromEnv, writeRefusal } = await import("../lib/paths.js");
const { readPath, writePath } = await import("../index.js");

async function makeHome() {
  const home = await mkdtemp(resolve(tmpdir(), "tf-home-"));
  return { home, env: { cwd: home, shared: null } };
}

test("mountsFromEnv tolerates an absent or malformed variable and drops bad entries", () => {
  assert.deepEqual(mountsFromEnv(undefined), []);
  assert.deepEqual(mountsFromEnv("not json"), []);
  assert.deepEqual(mountsFromEnv('{"path":"/x"}'), []);
  assert.deepEqual(mountsFromEnv('[{"path":"relative","mode":"rw"},{"path":"/ok","mode":"xx"},{"path":"/ok","mode":"ro","extra":1}]'), [{ path: "/ok", mode: "ro" }]);
});

test("an absolute path under a rw mount resolves, is writable, and comes back absolute", async () => {
  const { home, env } = await makeHome();
  const r = await resolveContained(env, resolve(rwMount, "new.txt"), { write: true });
  assert.equal(r.root, "mount");
  assert.equal(r.writable, true);
  assert.equal(r.display, resolve(rwMount, "new.txt"));
  await rm(home, { recursive: true, force: true });
});

test("a ro mount can be read but not written, and the refusal names the mount", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(roMount, "a.txt"), "hello");
  const r = await resolveContained(env, resolve(roMount, "a.txt"));
  assert.equal(r.root, "mount");
  assert.equal(r.writable, false);
  await assert.rejects(resolveContained(env, resolve(roMount, "a.txt"), { write: true }), new RegExp(`read-only \\(mount ${roMount}\\); writes need a path under home or ${rwMount}\\.`));
  await rm(home, { recursive: true, force: true });
});

test("the refusal lists the mounts among the reachable spaces", async () => {
  const { home, env } = await makeHome();
  await assert.rejects(resolveContained(env, "/etc/passwd"), new RegExp(`outside the spaces you can reach \\(home rw, shared ro, ${rwMount} rw, ${roMount} ro\\)\\.`));
  await rm(home, { recursive: true, force: true });
});

test(".git under a rw mount stays protected from writes", async () => {
  const { home, env } = await makeHome();
  await mkdir(resolve(rwMount, ".git"), { recursive: true });
  await assert.rejects(resolveContained(env, resolve(rwMount, ".git", "config"), { write: true }), /protected from write and delete/);
  await rm(home, { recursive: true, force: true });
});

test("the tools read and write through a mount end to end", async () => {
  const { home, env } = await makeHome();
  const file = resolve(rwMount, "notes.md");
  assert.match(await writePath({ path: file, contents: "one\ntwo\n" }, env), /wrote/i);
  assert.match(await readPath({ path: file }, env), /1\s+one/);
  assert.match(await writePath({ path: resolve(roMount, "x.md"), contents: "no" }, env), /^error: .*read-only \(mount /);
  await rm(home, { recursive: true, force: true });
});

test("a write refused by the filesystem on a path the mount list calls rw names the contradiction", async () => {
  // The fence and the mount list are supposed to agree. When a read-only bind lands inside a granted rw
  // mount they do not, every surface still reads rw, and all the agent gets is EROFS. Say what it means.
  const { env } = await makeHome();
  const resolved = await resolveContained(env, resolve(rwMount, "deep/file.txt"), { write: true });
  assert.equal(resolved.writable, true);
  const said = writeRefusal(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }), resolved);
  assert.match(said.message, /read-only filesystem/);
  assert.ok(said.message.includes(`${rwMount} is mounted rw`), said.message);
  assert.match(said.message, /fault in the workspace, not in the path/);
  assert.match(said.message, /do not work around it/);
});

test("an ordinary failure, and a write to a path the list already calls read-only, pass through unchanged", async () => {
  const { env } = await makeHome();
  const writable = await resolveContained(env, resolve(rwMount, "a.txt"), { write: true });
  assert.equal(writeRefusal(Object.assign(new Error("nope"), { code: "ENOSPC" }), writable), null, "only EROFS is the contradiction");
  // A ro mount never reaches a write at all: resolveContained refuses it first, so there is nothing to explain.
  const readOnly = await resolveContained(env, resolve(roMount, "a.txt"), {});
  assert.equal(readOnly.writable, false);
  assert.equal(writeRefusal(Object.assign(new Error("EROFS"), { code: "EROFS" }), readOnly), null);
});

test("a write refused inside the person's own space says so without naming a mount", async () => {
  const { env } = await makeHome();
  const resolved = await resolveContained(env, "notes.txt", { write: true });
  const said = writeRefusal(Object.assign(new Error("EROFS"), { code: "EROFS" }), resolved);
  assert.match(said.message, /in your own space, which is read-write/);
});

after(async () => {
  await rm(rwMount, { recursive: true, force: true });
  await rm(roMount, { recursive: true, force: true });
});
