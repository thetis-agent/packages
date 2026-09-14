import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, token } from "../src/container.js";
import { UserStore } from "../src/users.js";
import { AuthService } from "../src/auth.js";
import { validateManifest } from "../src/packages/manifest.js";
import { Enumerator, BUILTIN_CALL } from "../src/pipeline/enumerator.js";
import { AsyncQueue } from "../src/util.js";
import { defaultConfig, saveConfig, loadConfig } from "../src/config.js";
import { isGitSource, splitSource } from "../src/packages/manager.js";
import { redact } from "../src/control.js";
import type { PackageInfo } from "../src/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "thetis-unit-"));

test("container resolves lazily, caches singletons, and allows rebinding", () => {
  const A = token<{ n: number }>("A");
  const B = token<{ a: { n: number } }>("B");
  let built = 0;
  const c = new Container().bind(A, () => ({ n: ++built })).bind(B, (c) => ({ a: c.get(A) }));
  assert.equal(built, 0);
  assert.equal(c.get(B).a, c.get(A));
  assert.equal(built, 1);
  c.bind(A, () => ({ n: 42 }));
  assert.equal(c.get(A).n, 42);
  assert.throws(() => c.get(token("missing")), /No binding/);
});

test("user store: create, moderate, authorize", () => {
  const home = tmp();
  try {
    const users = new UserStore(home);
    assert.ok(users.get("_system"));
    users.create("alice");
    assert.throws(() => users.create("Alice"), /invalid user id/);
    assert.throws(() => users.create("alice"), /already exists/);
    users.setStatus("alice", "suspended");
    assert.throws(() => users.authorize("alice"), /suspended/);
    users.setStatus("alice", "active");
    assert.equal(users.setRole("alice", "admin").role, "admin");
    assert.throws(() => users.remove("_system"), /system user/);
    assert.equal(new UserStore(home).get("alice")?.role, "admin", "persists across instances");
    users.remove("alice");
    assert.equal(users.get("alice"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("manifest validation rejects unscoped names and missing thetis field", () => {
  assert.throws(() => validateManifest({ name: "foo", version: "1", thetis: { type: "tool" } }), /scoped/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1" } as never), /thetis/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x" } as never] } }), /phase/);
  assert.ok(validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x", phase: "prompt", export: "x" }] } }));
});

const pkgs: PackageInfo[] = [
  { name: "@a/mem", version: "1", type: "memory", root: "/x", thetis: { type: "memory", steps: [{ id: "load", phase: "prompt", export: "load" }, { id: "save", phase: "after", export: "save" }] } },
  { name: "@a/hist", version: "1", type: "loader", root: "/y", thetis: { type: "loader", steps: [{ id: "trim", phase: "history", export: "trim" }] } },
];

test("default enumerator orders steps by phase and places the built-in call last in its phase", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  const plan = e.defaultPlan(pkgs).map((s) => `${s.phase}:${s.export}`);
  assert.deepEqual(plan, ["history:trim", "prompt:load", "call:provider-call", "after:save"]);
});

test("enumerator output is validated against declared package steps", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  assert.throws(() => e.validate([{ package: "@a/mem", export: "nope" }], pkgs), /undeclared/);
  assert.throws(() => e.validate({} as never, pkgs), /array/);
  const ok = e.validate([{ package: "@a/hist", export: "trim" }, BUILTIN_CALL], pkgs);
  assert.equal(ok.length, 2);
  assert.equal(ok[1].package, "@thetis/kernel");
});

test("auth: passwords, tokens, expiry, and revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-auth-"));
  try {
    const users = new UserStore(dir);
    users.create("alice");
    const auth = new AuthService(dir, users, 200);
    await assert.rejects(auth.setPassword("nobody", "x"), /unknown user/);
    await assert.rejects(auth.setPassword("_system", "x"), /cannot sign in/);
    await assert.rejects(auth.setPassword("alice", ""), /empty/);
    assert.equal(await auth.login("alice", "secret"), undefined, "no password yet");
    await auth.setPassword("alice", "secret");
    assert.equal(await auth.login("alice", "wrong"), undefined);
    assert.equal(await auth.login("nobody", "secret"), undefined);
    const login = await auth.login("alice", "secret");
    assert.ok(login && /^[a-f0-9]{64}$/.test(login.token));
    assert.equal(auth.authenticate(login!.token)?.id, "alice");
    assert.equal(new AuthService(dir, users).authenticate(login!.token)?.id, "alice", "tokens persist");
    users.setStatus("alice", "suspended");
    assert.equal(auth.authenticate(login!.token), undefined, "a suspended user's token is refused");
    assert.equal(await auth.login("alice", "secret"), undefined);
    users.setStatus("alice", "active");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(auth.authenticate(login!.token), undefined, "expired");
    const again = (await auth.login("alice", "secret"))!;
    await auth.setPassword("alice", "other");
    assert.equal(auth.authenticate(again.token), undefined, "a new password revokes tokens");
    const last = (await auth.login("alice", "other"))!;
    auth.logout(last.token);
    assert.equal(auth.authenticate(last.token), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async queue delivers pushed items in order and ends on close", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  setTimeout(() => (q.push(3), q.close()), 5);
  const got: number[] = [];
  for await (const n of q) got.push(n);
  assert.deepEqual(got, [1, 2, 3]);
});

test("package sources: git urls with an optional #directory, file urls, and local paths", () => {
  assert.deepEqual(splitSource("https://x/y.git#pkgs/a"), { url: "https://x/y.git", sub: "pkgs/a" });
  assert.deepEqual(splitSource("https://x/y.git#"), { url: "https://x/y.git" });
  assert.deepEqual(splitSource("packages/hello"), { url: "packages/hello" });
  for (const src of ["https://x/y.git", "https://x/y#dir", "git@github.com:a/b.git", "file:///tank/packages#prompt-cache", "/abs/repo.git"]) assert.ok(isGitSource(src), src);
  for (const src of ["packages/hello", "@thetis/tool-exec", "./x"]) assert.ok(!isGitSource(src), src);
});

test("config: the promoted packages directory is derived and secrets are redacted for display", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    assert.equal(cfg.promotedPackagesDir, join(home, "packages"));
    assert.ok(cfg.fence.readOnly.includes(join(home, "packages")));
    cfg.packages["@thetis/provider-openrouter"] = { apiKey: "sk-live", baseUrl: "https://x", headers: { Authorization: "Bearer t" } };
    saveConfig(cfg);
    const raw = JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8"));
    assert.equal(raw.promotedPackagesDir, undefined);
    assert.equal(loadConfig(home, "/other").promotedPackagesDir, join(home, "packages"));
    const shown = redact(cfg);
    assert.equal(shown.packages["@thetis/provider-openrouter"].apiKey, "•••");
    assert.equal(shown.packages["@thetis/provider-openrouter"].baseUrl, "https://x");
    assert.equal(shown.model, cfg.model);
    assert.deepEqual(shown.phases, cfg.phases);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
