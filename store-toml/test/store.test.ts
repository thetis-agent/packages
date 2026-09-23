import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeConformance } from "@thetis/runtime/lib/store-conformance";
import { createStore } from "../src/index.js";

const log = (): void => {};

/** A fresh root for every case, under the system temp directory. */
async function fresh(): Promise<{ root: string; driver: Awaited<ReturnType<typeof createStore>> }> {
  const root = mkdtempSync(join(tmpdir(), "store-toml-"));
  return { root, driver: await createStore({ root, log }) };
}

storeConformance("toml", async () => createStore({ root: mkdtempSync(join(tmpdir(), "store-toml-")), log }));

test("toml: the file layout is <root>/<namespace>/<key>.toml", async () => {
  const { root, driver } = await fresh();
  await driver.open("users").set("alice", { role: "admin" });
  await driver.open("registry/packages").set("@thetis/exa", { version: "0.1.0" });
  assert.equal(readFileSync(join(root, "users", "alice.toml"), "utf8"), 'role = "admin"\n');
  assert.equal(readFileSync(join(root, "registry", "packages", "@thetis", "exa.toml"), "utf8"), 'version = "0.1.0"\n');
  assert.deepEqual(readdirSync(join(root, "registry", "packages", "@thetis")), ["exa.toml"]);
});

test("toml: a private namespace is 0700 directories and 0600 files, and stays so once opened private", async () => {
  const { root, driver } = await fresh();
  // A non-private open first, so the shared ancestor exists with the default mode.
  await driver.open("secrets/shared").set("k", { n: 1 });
  assert.notEqual(statSync(join(root, "secrets")).mode & 0o777, 0o700);
  const secret = driver.open("secrets/users/alice", { private: true });
  await secret.set("tokens/abc", { user: "alice" });
  for (const dir of ["secrets", "secrets/users", "secrets/users/alice", "secrets/users/alice/tokens"]) {
    assert.equal(statSync(join(root, dir)).mode & 0o777, 0o700, dir);
  }
  assert.equal(statSync(join(root, "secrets/users/alice/tokens/abc.toml")).mode & 0o777, 0o600);
  // A rewrite keeps the mode: the temporary file is created with it and renamed over the old one.
  await secret.set("tokens/abc", { user: "alice", n: 2 });
  assert.equal(statSync(join(root, "secrets/users/alice/tokens/abc.toml")).mode & 0o777, 0o600);
  // A non-private namespace stays readable.
  assert.equal(statSync(join(root, "secrets/shared/k.toml")).mode & 0o777, 0o644);
});

for (const cleared of ["secrets/users/alice", "secrets/users"]) {
  test(`regression: a private namespace can be reused after clearing ${cleared}`, async () => {
    const { root, driver } = await fresh();
    try {
      const secret = driver.open("secrets/users/alice", { private: true });
      await secret.set("@alice/provider", { apiKey: "before" });
      await driver.open(cleared).clear();
      await secret.set("@alice/provider", { apiKey: "after" });
      assert.deepEqual(await secret.get("@alice/provider"), { apiKey: "after" });
      for (const path of ["secrets", "secrets/users", "secrets/users/alice", "secrets/users/alice/@alice"]) {
        assert.equal(statSync(join(root, path)).mode & 0o777, 0o700, path);
      }
      assert.equal(statSync(join(root, "secrets/users/alice/@alice/provider.toml")).mode & 0o777, 0o600);
    } finally {
      await driver.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("toml: a leftover temporary file is ignored by list and get", async () => {
  const { root, driver } = await fresh();
  const s = driver.open("ns");
  await s.set("a", { n: 1 });
  writeFileSync(join(root, "ns", `a.toml.${process.pid}.99.tmp`), "n = 2\n");
  writeFileSync(join(root, "ns", "b.toml.12345.1.tmp"), "n = 3\n");
  writeFileSync(join(root, "ns", "notes.txt"), "not a document");
  assert.deepEqual(await s.list(), ["a"]);
  assert.deepEqual(await s.get("a"), { n: 1 });
  assert.equal(await s.get("b"), undefined);
});

test("toml: a set leaves no temporary file behind", async () => {
  const { root, driver } = await fresh();
  const s = driver.open("ns");
  await Promise.all([s.set("k", { n: 1 }), s.set("k", { n: 2 }), s.set("k", { n: 3 })]);
  assert.deepEqual(readdirSync(join(root, "ns")), ["k.toml"]);
});

test("toml: a corrupt file fails with its path and the line", async () => {
  const { root, driver } = await fresh();
  const s = driver.open("ns");
  await s.set("k", { n: 1 });
  writeFileSync(join(root, "ns", "k.toml"), "n = 1\nn = 2\n");
  await assert.rejects(
    () => s.get("k"),
    (err: unknown) => {
      assert.match((err as Error).message, /ns\/k\.toml: duplicate key `n` at line 2/);
      assert.equal((err as { code?: string }).code, "storage");
      return true;
    },
  );
});

test("toml: what is written is the canonical form, so an unchanged document is an unchanged file", async () => {
  const { root, driver } = await fresh();
  const s = driver.open("ns");
  const doc = { b: [{ y: 2, x: 1 }], a: "text\nwith lines" };
  await s.set("k", doc);
  const first = readFileSync(join(root, "ns", "k.toml"), "utf8");
  await s.set("k", (await s.get("k")) as object);
  assert.equal(readFileSync(join(root, "ns", "k.toml"), "utf8"), first);
});
