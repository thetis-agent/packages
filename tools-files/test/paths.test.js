// Containment tests: escape attempts, symlinks, and new-file resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveContained } from "../lib/paths.js";

async function makeHome() {
  const home = await mkdtemp(resolve(tmpdir(), "tf-home-"));
  const outside = await mkdtemp(resolve(tmpdir(), "tf-outside-"));
  return { home, outside, env: { cwd: home, shared: null } };
}

test("a .. escape is refused", async () => {
  const { home, env } = await makeHome();
  await assert.rejects(resolveContained(env, "../etc/passwd"), /outside the spaces you can reach/);
  await rm(home, { recursive: true, force: true });
});

test("a symlink pointing outside home is refused", async () => {
  const { home, outside, env } = await makeHome();
  await writeFile(resolve(outside, "secret.txt"), "shh");
  await symlink(resolve(outside, "secret.txt"), resolve(home, "link.txt"));
  await assert.rejects(resolveContained(env, "link.txt"), /outside the spaces you can reach/);
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("a new file under an existing directory resolves and is writable", async () => {
  const { home, env } = await makeHome();
  await mkdir(resolve(home, "sub"));
  const r = await resolveContained(env, "sub/new-file.txt", { write: true });
  assert.equal(r.root, "home");
  assert.equal(r.writable, true);
  assert.equal(r.display, "sub/new-file.txt");
  await rm(home, { recursive: true, force: true });
});

test("a dangling symlink is refused", async () => {
  const { home, env } = await makeHome();
  await symlink(resolve(home, "does-not-exist"), resolve(home, "dangling.txt"));
  await assert.rejects(resolveContained(env, "dangling.txt"), /dangling symlink/);
  await rm(home, { recursive: true, force: true });
});

test("empty path is refused", async () => {
  const { home, env } = await makeHome();
  await assert.rejects(resolveContained(env, ""), /required and must not be empty/);
  await rm(home, { recursive: true, force: true });
});

test(".git component is protected from write", async () => {
  const { home, env } = await makeHome();
  await mkdir(resolve(home, ".git"));
  await assert.rejects(resolveContained(env, ".git/config", { write: true }), /protected from write and delete/);
  await rm(home, { recursive: true, force: true });
});
