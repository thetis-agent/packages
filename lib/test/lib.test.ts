import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "../src/async.js";
import { Container, token } from "../src/container.js";
import { JsonDirStore } from "../src/json-store.js";
import { isGitSource, isInside, splitSource } from "../src/pkg-fs.js";
import { PendingCalls, callHandler } from "../src/rpc-frames.js";

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

test("async queue delivers pushed items in order and ends on close", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  setTimeout(() => {
    q.push(3);
    q.close();
  }, 5);
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
  assert.ok(isInside("/a/b", "/a/b/c"));
  assert.ok(!isInside("/a/b", "/a/b"));
  assert.ok(!isInside("/a/b", "/a/bc"));
  assert.ok(!isInside("/a/b", "/a"));
});

test("json directory store: ids are checked before they become paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-store-"));
  try {
    const store = new JsonDirStore<{ id: string; n: number }>(/^s_[a-f0-9]+$/);
    store.save(dir, { id: "s_01", n: 1 });
    store.save(dir, { id: "s_02", n: 2 });
    assert.equal(store.load(dir, "s_01")?.n, 1);
    assert.equal(store.load(dir, "s_03"), undefined);
    assert.throws(() => store.load(dir, "../etc/passwd"), /invalid id/);
    assert.deepEqual(store.list(dir).map((r) => r.id).sort(), ["s_01", "s_02"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rpc frames: events stream before the result, errors carry a code, and cleanup runs once", async () => {
  const pending = new PendingCalls("t");
  const events: unknown[] = [];
  let cleaned = 0;
  const call = { onEvent: (e: unknown) => events.push(e), cleanup: () => cleaned++ };
  const a = pending.open(call);
  const b = pending.open();
  assert.equal(a.id, "t1");
  assert.ok(pending.receive({ id: "t1", event: "e1" }));
  assert.ok(pending.receive({ id: "t1", result: 42 }));
  assert.equal(await a.result, 42);
  assert.deepEqual(events, ["e1"]);
  assert.equal(cleaned, 1);
  assert.ok(!pending.receive({ id: "t1", result: 0 }), "a settled call is gone");
  pending.receive({ id: "t2", error: "boom", code: "not-found" });
  await assert.rejects(b.result, (err: { message: string; code: string }) => err.message === "boom" && err.code === "not-found");
  const c = pending.open();
  pending.failAll(new Error("closed"));
  await assert.rejects(c.result, /closed/);
  assert.equal(pending.size, 0);
  const ok = await callHandler(async () => undefined, "m", {});
  assert.deepEqual(ok, { result: null });
  const bad = await callHandler(async () => Promise.reject(Object.assign(new Error("no"), { code: "rpc" })), "m", {});
  assert.deepEqual(bad, { error: "no", code: "rpc" });
});
