import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, token } from "../src/container.js";
import { UserStore } from "../src/users.js";
import { validateManifest } from "../src/packages/manifest.js";
import { Enumerator, BUILTIN_CALL } from "../src/pipeline/enumerator.js";
import { AsyncQueue } from "../src/util.js";
import { defaultConfig } from "../src/config.js";
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

test("async queue delivers pushed items in order and ends on close", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  setTimeout(() => (q.push(3), q.close()), 5);
  const got: number[] = [];
  for await (const n of q) got.push(n);
  assert.deepEqual(got, [1, 2, 3]);
});
