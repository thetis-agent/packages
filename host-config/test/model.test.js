import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSet } from "../index.js";

function fakeEnv(file) {
  const home = mkdtempSync(join(tmpdir(), "thetis-host-config-"));
  if (file !== undefined) writeFileSync(join(home, "thetis.config.json"), typeof file === "string" ? file : JSON.stringify(file, null, 2));
  const journal = [];
  return { env: { home, journal: (row) => void journal.push(row), log: () => {} }, home, journal };
}
const read = (home) => JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8"));
const code = (want) => (e) => e.code === want;

test("sets the file's model and keeps every other key", async () => {
  const { env, home, journal } = fakeEnv({ model: "old/one", door: { port: 8777 }, fence: { network: "egress" } });
  assert.deepEqual(await modelSet({ model: " anthropic/claude-opus-5-5 ", actor: "root" }, env), { model: "anthropic/claude-opus-5-5", was: "old/one" });
  assert.deepEqual(read(home), { model: "anthropic/claude-opus-5-5", door: { port: 8777 }, fence: { network: "egress" } });
  assert.deepEqual(journal, [{ kind: "config.model", target: "_system", data: { from: "old/one", to: "anthropic/claude-opus-5-5" }, actor: "root" }]);
});

test("an empty model removes the key, so the built-in default applies", async () => {
  const { env, home } = fakeEnv({ model: "old/one", door: { port: 1 } });
  assert.deepEqual(await modelSet({ model: "" }, env), { model: null, was: "old/one" });
  assert.deepEqual(read(home), { door: { port: 1 } });
});

test("a missing file is created; the mode of an existing one is kept", async () => {
  const { env, home } = fakeEnv();
  await modelSet({ model: "a/b" }, env);
  assert.deepEqual(read(home), { model: "a/b" });
  chmodSync(join(home, "thetis.config.json"), 0o600);
  await modelSet({ model: "c/d" }, env);
  assert.equal(statSync(join(home, "thetis.config.json")).mode & 0o777, 0o600);
});

test("a symlinked file is written through to its target", async () => {
  const { env, home } = fakeEnv();
  const elsewhere = mkdtempSync(join(tmpdir(), "thetis-host-config-real-"));
  writeFileSync(join(elsewhere, "real.json"), JSON.stringify({ door: {} }));
  symlinkSync(join(elsewhere, "real.json"), join(home, "thetis.config.json"));
  await modelSet({ model: "x/y" }, env);
  assert.deepEqual(JSON.parse(readFileSync(join(elsewhere, "real.json"), "utf8")), { door: {}, model: "x/y" });
});

test("refuses a self call, a bad id, and a file that is not JSON, and leaves the file alone", async () => {
  const { env, home } = fakeEnv({ model: "keep/me" });
  await assert.rejects(modelSet({ model: "a/b", self: true, user: "alice" }, env), code("unauthorized"));
  await assert.rejects(modelSet({ model: "has space" }, env), code("invalid"));
  await assert.rejects(modelSet({ model: "x".repeat(201) }, env), code("invalid"));
  await assert.rejects(modelSet({}, env), code("invalid"));
  assert.deepEqual(read(home), { model: "keep/me" });
  const broken = fakeEnv("{ nope");
  await assert.rejects(modelSet({ model: "a/b" }, broken.env), /not valid JSON/);
  assert.equal(readFileSync(join(broken.home, "thetis.config.json"), "utf8"), "{ nope");
});
