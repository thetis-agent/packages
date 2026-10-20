// safe-fs and the jail: a link planted in the person's space leads no write and no read out of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasBwrap, jail, jailOne, setBwrapForTests, userspaceRoot } from "../lib/jail.js";
import { checkRelative, safeAppend, safeList, safeRead, safeRemove, safeWrite } from "../lib/safe-fs.js";
import { code, scratchHome } from "./helpers.js";

test("a relative path is plain segments only", () => {
  assert.deepEqual(checkRelative("home/trials/t_1/a.json"), ["home", "trials", "t_1", "a.json"]);
  for (const bad of ["", "/abs", "a/../b", "./a", "a//b", "a/", "..", "a/.", "a b", "a\\b"]) assert.throws(() => checkRelative(bad), code("invalid"), bad);
});

test("write, append, read, list and remove, parents made as needed", () => {
  const root = scratchHome([]);
  try {
    safeWrite(root, "a/b/c.txt", "one");
    safeAppend(root, "a/b/log.txt", "1\n");
    safeAppend(root, "a/b/log.txt", "2\n");
    assert.equal(safeRead(root, "a/b/c.txt"), "one");
    assert.equal(safeRead(root, "a/b/log.txt"), "1\n2\n");
    assert.equal(safeRead(root, "a/missing.txt"), null);
    assert.equal(safeRead(root, "nope/missing.txt"), null);
    assert.deepEqual(safeList(root, "a/b").map((e) => e.name), ["c.txt", "log.txt"]);
    assert.deepEqual(safeList(root, "zzz"), []);
    safeWrite(root, "a/b/c.txt", "two");
    assert.equal(safeRead(root, "a/b/c.txt"), "two");
    safeRemove(root, "a/b");
    assert.ok(!existsSync(join(root, "a/b")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function planted() {
  const root = scratchHome([]);
  const outside = join(root, "..", `${root.split("/").pop()}-outside`);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  mkdirSync(join(root, "home"));
  symlinkSync(outside, join(root, "home", "trials"));
  symlinkSync(join(outside, "secret.txt"), join(root, "home", "link.txt"));
  return { root, outside, done: () => [root, outside].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

test("a link anywhere on the way is refused, for writes and reads alike", () => {
  const { root, outside, done } = planted();
  try {
    assert.throws(() => safeWrite(root, "home/trials/t_1/trial.json", "x"), code("unauthorized"));
    assert.throws(() => safeAppend(root, "home/trials/log.txt", "x"), code("unauthorized"));
    assert.throws(() => safeRead(root, "home/trials/secret.txt"), code("unauthorized"));
    assert.throws(() => safeRead(root, "home/link.txt"), code("unauthorized"));
    assert.throws(() => safeWrite(root, "home/link.txt", "x"), code("unauthorized"));
    assert.ok(!existsSync(join(outside, "t_1")));
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
  } finally {
    done();
  }
});

for (const jailed of [false, true]) {
  test(`the ${jailed ? "bubblewrap" : "in-process"} jail answers one result per op and refuses links`, { skip: jailed && !hasBwrap() ? "no bubblewrap" : false }, () => {
    const { root, outside, done } = planted();
    setBwrapForTests(jailed);
    try {
      const out = jail(root, [
        { op: "write", path: "home/x/trial.json", content: "{}" },
        { op: "append", path: "home/x/log.txt", content: "a\n" },
        { op: "read", path: "home/x/trial.json" },
        { op: "list", path: "home/x" },
        { op: "write", path: "home/trials/t_1/trial.json", content: "pwned" },
        { op: "read", path: "home/link.txt" },
        { op: "nope", path: "x" },
      ]);
      assert.deepEqual(out.slice(0, 4), [{ ok: true }, { ok: true }, { ok: true, value: "{}" }, { ok: true, value: [{ name: "log.txt", dir: false }, { name: "trial.json", dir: false }] }]);
      assert.equal(out[4].ok, false);
      assert.equal(out[5].ok, false);
      assert.doesNotMatch(JSON.stringify(out), /secret"/);
      assert.equal(out[6].ok, false);
      assert.ok(!existsSync(join(outside, "t_1")));
      assert.equal(jailOne(root, { op: "read", path: "home/x/log.txt" }), "a\n");
      assert.throws(() => jailOne(root, { op: "read", path: "home/link.txt" }), code("unauthorized"));
    } finally {
      setBwrapForTests(undefined);
      done();
    }
  });
}

test("the userspace root must be a plain directory", () => {
  const home = scratchHome(["ann"]);
  try {
    assert.equal(userspaceRoot(home, "ann"), join(home, "userspaces", "ann"));
    symlinkSync(join(home, "userspaces", "ann"), join(home, "userspaces", "eve"));
    assert.throws(() => userspaceRoot(home, "eve"), code("unauthorized"));
    assert.throws(() => userspaceRoot(home, "nobody"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
