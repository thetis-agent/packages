// The mount mechanism: what a list is when it arrives, what presence says, and what browse answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDirectories, parseMountList, withPresence } from "../lib/mounts.js";

test("mounts: a list is parsed strictly, presence is what the fence will bind, and browse answers what a path is", () => {
  const dir = mkdtempSync(join(tmpdir(), "mounts-"));
  try {
    mkdirSync(join(dir, "repos"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "note.txt"), "x");
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
