import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mount, TurnEvent, WatchedTurnEvent } from "@thetis/contracts";
import { AsyncQueue } from "../src/async.js";
import { Container, token } from "../src/container.js";
import { JsonDirStore } from "../src/json-store.js";
import { MountStore, browseDirectories, parseMountList, withPresence } from "../src/mounts.js";
import { findDependency, forkPackage, forkVersion, isGitSource, isInside, splitSource } from "../src/pkg-fs.js";
import { PendingCalls, callHandler } from "../src/rpc-frames.js";
import { StoreMirror, memoryStore } from "../src/store.js";
import { TurnTaps } from "../src/turn-taps.js";

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

test("fork: the copy drops scripts and devDependencies, links what the origin resolves, and numbers its version", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-fork-"));
  try {
    const origin = join(dir, "origin");
    mkdirSync(join(origin, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(origin, "dist"), { recursive: true });
    writeFileSync(join(origin, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0" }));
    writeFileSync(join(origin, "dist", "index.js"), "export const x = 1;");
    writeFileSync(join(origin, "package.json"), JSON.stringify({
      name: "@thetis/thing", version: "0.2.0", description: "a thing", main: "dist/index.js",
      scripts: { build: "tsc -b" }, dependencies: { "left-pad": "^1", "not-there": "^2" }, devDependencies: { typescript: "^5" },
      peerDependencies: { "@thetis/contracts": "^0.1.0" }, thetis: { type: "tool", tools: [{ name: "t", description: "d", export: "x" }] },
    }));
    const to = join(dir, "home", "packages", "thing");
    const r = forkPackage({ from: origin, to, name: "@alice/thing", version: forkVersion("0.2.0"), origin: { name: "@thetis/thing", version: "0.2.0" }, root: dir });
    assert.deepEqual(r.linked, ["left-pad"]);
    const m = JSON.parse(readFileSync(join(to, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(m.name, "@alice/thing");
    assert.equal(m.version, "0.2.0-fork.1");
    assert.equal(m.description, "a thing", "other fields are kept");
    assert.equal(m.scripts, undefined);
    assert.equal(m.devDependencies, undefined);
    assert.deepEqual(m.dependencies, { "not-there": "^2" }, "an unresolved dependency stays for npm");
    assert.deepEqual(m.peerDependencies, { "@thetis/contracts": "^0.1.0" });
    assert.deepEqual(m.thetis, { type: "tool", tools: [{ name: "t", description: "d", export: "x" }], forkedFrom: { name: "@thetis/thing", version: "0.2.0" } });
    assert.ok(existsSync(join(to, "dist", "index.js")), "the built files came along");
    assert.ok(!existsSync(join(to, "node_modules", "not-there")));
    assert.equal(realpathSync(join(to, "node_modules", "left-pad")), realpathSync(join(origin, "node_modules", "left-pad")), "a resolvable dependency is a link");
    assert.throws(() => forkPackage({ from: origin, to, name: "@alice/thing", version: "x", origin: { name: "@thetis/thing", version: "0.2.0" }, root: dir }), /target exists/);
    assert.equal(forkVersion("0.2.0", "0.2.0-fork.1"), "0.2.0-fork.2");
    assert.equal(forkVersion("0.3.0", "0.2.0-fork.4"), "0.3.0-fork.1", "a new origin version starts over");
    assert.equal(forkVersion("0.2.0", "1.0.0"), "0.2.0-fork.1");
    assert.equal(findDependency(origin, "nope"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mounts: the store keeps one document per person, presence is what the fence will bind, and browse answers what a path is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mounts-"));
  try {
    mkdirSync(join(dir, "repos"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "note.txt"), "x");
    const space = memoryStore().open("mounts");
    const mirror = await StoreMirror.open<{ mounts: Mount[] }>(space);
    const mounts = new MountStore(mirror);
    assert.deepEqual(mounts.get("alice"), []);
    mounts.set("alice", [{ path: join(dir, "repos"), mode: "rw" }]);
    mounts.set("bob", [{ path: dir, mode: "ro" }]);
    assert.deepEqual(mounts.all(), { alice: [{ path: join(dir, "repos"), mode: "rw" }], bob: [{ path: dir, mode: "ro" }] });
    mounts.get("alice")[0].mode = "ro";
    assert.equal(mounts.get("alice")[0].mode, "rw", "get answers a copy");
    mounts.set("bob", []);
    assert.deepEqual(Object.keys(mounts.all()), ["alice"], "an empty list removes the document");
    await mirror.flush();
    assert.deepEqual(await space.get("alice"), { mounts: [{ path: join(dir, "repos"), mode: "rw" }] });
    assert.equal(await space.get("bob"), undefined);
    const reopened = new MountStore(await StoreMirror.open(space));
    assert.deepEqual(reopened.get("alice"), [{ path: join(dir, "repos"), mode: "rw" }], "what was written is what a restart reads");
    assert.deepEqual(parseMountList([{ path: dir, mode: "ro" }]), [{ path: dir, mode: "ro" }]);
    assert.throws(() => parseMountList([{ path: "/a/../b", mode: "ro" }]), /absolute and normalized/);
    assert.throws(() => parseMountList([{ path: "/", mode: "ro" }]), /not \//);
    assert.throws(() => parseMountList([{ path: dir, mode: "rwx" }]), /rw or ro/);
    assert.throws(() => parseMountList(Array.from({ length: 33 }, () => ({ path: dir, mode: "ro" }))), /at most 32/);
    assert.throws(() => parseMountList("nope"), /at most 32/);
    assert.deepEqual(withPresence([{ path: join(dir, "repos"), mode: "rw" }, { path: join(dir, "note.txt"), mode: "ro" }, { path: join(dir, "gone"), mode: "rw" }]), [
      { path: join(dir, "repos"), mode: "rw", present: true, kind: "dir" },
      { path: join(dir, "note.txt"), mode: "ro", present: false, kind: "file" },
      { path: join(dir, "gone"), mode: "rw", present: false, kind: "none" },
    ]);
    // Directories only: a file is not a place to bind, and a hidden name is out of the way unless asked for.
    assert.deepEqual(browseDirectories(dir).entries, [{ name: "repos", path: join(dir, "repos") }]);
    assert.deepEqual(browseDirectories(dir, { all: true }).entries.map((e) => e.name), [".git", "repos"]);
    assert.equal(browseDirectories(dir, { limit: 0 }).truncated, true);
    assert.deepEqual(browseDirectories(join(dir, "note.txt")), { path: join(dir, "note.txt"), parent: dir, kind: "file", readable: false, truncated: false, entries: [] });
    assert.equal(browseDirectories(join(dir, "gone")).kind, "none");
    assert.equal(browseDirectories("/").parent, null);
    assert.throws(() => browseDirectories("relative"), /absolute and normalized/);
    assert.throws(() => browseDirectories("/a/../b"), /absolute and normalized/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn taps: a watcher gets the user's events stamped with the session, input on turn.start only; one that throws is dropped; the signal removes one", async () => {
  const taps = new TurnTaps();
  const seen: WatchedTurnEvent[] = [];
  const inner: TurnEvent[] = [];
  const control = new AbortController();
  const done = taps.watch("alice", (m) => seen.push(m), control.signal);
  let thrown = 0;
  taps.watch("alice", () => {
    thrown++;
    throw new Error("a broken tap");
  });
  taps.watch("bob", () => assert.fail("bob's watcher saw alice's turn"));
  const emit = taps.emitter("alice", { session: "s_1", parent: "s_0", input: "hi" }, (e) => inner.push(e));
  const start: TurnEvent = { type: "turn.start", turn: "t1", session: "s_1" };
  const text: TurnEvent = { type: "text", delta: "x" };
  emit(start);
  emit(text);
  assert.deepEqual(inner, [start, text], "the inner sink gets every event, before the watchers");
  assert.deepEqual(seen, [
    { session: "s_1", parent: "s_0", input: "hi", event: start },
    { session: "s_1", parent: "s_0", event: text },
  ]);
  assert.equal(thrown, 1, "a watcher that throws is dropped after its first throw, and the turn goes on");
  assert.equal(taps.count("alice"), 1);
  control.abort();
  await done;
  assert.equal(taps.count("alice"), 0, "the signal removed the watcher");
  emit({ type: "turn.end", turn: "t1", session: "s_1" });
  assert.equal(seen.length, 2);
  assert.equal(inner.length, 3);
  const plain: WatchedTurnEvent[] = [];
  taps.watch("alice", (m) => plain.push(m));
  taps.emitter("alice", { session: "s_2" }, () => {})({ type: "turn.start", turn: "t2", session: "s_2" });
  assert.deepEqual(plain, [{ session: "s_2", event: { type: "turn.start", turn: "t2", session: "s_2" } }], "no parent and no input: the fields are absent, not undefined");
  const already = new AbortController();
  already.abort();
  await taps.watch("carol", () => {}, already.signal);
  assert.equal(taps.count("carol"), 0, "a signal that is already aborted registers nothing and resolves at once");
});
