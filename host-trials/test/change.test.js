// Applying an arm's change, against a fake kernel's settings and a scratch home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyChange, assignProject } from "../lib/change.js";
import { parseChange } from "../lib/spec.js";
import { code, scratchHome } from "./helpers.js";

function fakeKernel(values = {}) {
  const calls = [];
  return {
    calls,
    settings: {
      show: async ({ name }) => ({ keys: Object.entries(values[name] ?? {}).map(([key, value]) => ({ key, value })) }),
      set: async (target, key, value, actor) => calls.push(["set", target, key, value, actor]),
      unset: async (target, key, actor) => calls.push(["unset", target, key, actor]),
    },
  };
}

function home() {
  const dir = scratchHome([]);
  mkdirSync(join(dir, "projects"));
  writeFileSync(join(dir, "projects", "p_0123abcd.json"), JSON.stringify({ id: "p_0123abcd" }));
  return dir;
}

test("no change is nothing", async () => {
  assert.equal(await applyChange(fakeKernel(), "ann", "/nonexistent", null), "no change");
});

test("a skill is written, and removed with its directory when that is left empty", async () => {
  const h = home();
  try {
    await applyChange(fakeKernel(), "ann", h, parseChange({ kind: "skill", id: "probe", path: "skills/probe/SKILL.md", content: "---\nname: probe\n---\n" }));
    assert.equal(readFileSync(join(h, "skills/probe/SKILL.md"), "utf8"), "---\nname: probe\n---\n");
    await applyChange(fakeKernel(), "ann", h, parseChange({ kind: "skill", path: "skills/probe/SKILL.md", content: null }));
    assert.ok(!existsSync(join(h, "skills/probe")));
    assert.ok(existsSync(join(h, "skills")), "skills/ itself stays");
    // A directory with something else in it stays.
    mkdirSync(join(h, "skills/kept"));
    writeFileSync(join(h, "skills/kept/SKILL.md"), "x");
    writeFileSync(join(h, "skills/kept/notes.md"), "y");
    await applyChange(fakeKernel(), "ann", h, parseChange({ kind: "skill", path: "skills/kept/SKILL.md", content: null }));
    assert.ok(existsSync(join(h, "skills/kept/notes.md")) && !existsSync(join(h, "skills/kept/SKILL.md")));
    // Removing what is not there is not an error.
    await applyChange(fakeKernel(), "ann", h, parseChange({ kind: "skill", path: "skills/none/SKILL.md", content: null }));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("a skill is never written through a link in the home", async () => {
  const h = home();
  const outside = `${h}-outside`;
  mkdirSync(outside);
  try {
    symlinkSync(outside, join(h, "skills"));
    await assert.rejects(applyChange(fakeKernel(), "ann", h, parseChange({ kind: "skill", id: "probe", path: "skills/probe/SKILL.md", content: "x" })), code("unauthorized"));
    assert.ok(!existsSync(join(outside, "probe")));
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("project instructions are replaced whole or removed, for a project that exists", async () => {
  const h = home();
  try {
    writeFileSync(join(h, "projects/p_0123abcd.md"), "old");
    await applyChange(fakeKernel(), "ann", h, parseChange({ kind: "project-instructions", project: "p_0123abcd", content: "new" }));
    assert.equal(readFileSync(join(h, "projects/p_0123abcd.md"), "utf8"), "new");
    await applyChange(fakeKernel(), "ann", h, parseChange({ kind: "project-instructions", project: "p_0123abcd", content: null }));
    assert.ok(!existsSync(join(h, "projects/p_0123abcd.md")));
    await assert.rejects(applyChange(fakeKernel(), "ann", h, parseChange({ kind: "project-instructions", project: "p_99999999", content: "x" })), /does not exist/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("a guide note is appended to the notes in force; config is set or unset at the person's layer", async () => {
  const k = fakeKernel({ "@thetis/harness-core": { guideNotes: ["first"] } });
  await applyChange(k, "ann", "/x", parseChange({ kind: "guide-note", note: "second" }));
  await applyChange(fakeKernel(), "ann", "/x", parseChange({ kind: "guide-note", note: "only" })).then(() => {});
  await applyChange(k, "ann", "/x", parseChange({ kind: "config", package: "@thetis/tools-files", key: "maxBytes", value: 9 }));
  await applyChange(k, "ann", "/x", parseChange({ kind: "config", package: "@thetis/tools-files", key: "maxBytes", value: null }));
  assert.deepEqual(k.calls, [
    ["set", { user: "ann", name: "@thetis/harness-core" }, "guideNotes", ["first", "second"], "trial"],
    ["set", { user: "ann", name: "@thetis/tools-files" }, "maxBytes", 9, "trial"],
    ["unset", { user: "ann", name: "@thetis/tools-files" }, "maxBytes", "trial"],
  ]);
  const fresh = fakeKernel();
  await applyChange(fresh, "ann", "/x", parseChange({ kind: "guide-note", note: "only" }));
  assert.deepEqual(fresh.calls[0][3], ["only"]);
});

test("a session is assigned to a project in projects/sessions.json, the rest of the map kept", () => {
  const h = home();
  try {
    writeFileSync(join(h, "projects/sessions.json"), JSON.stringify({ s_aa: "p_0123abcd" }));
    assignProject(h, "s_bb", "p_0123abcd");
    assert.deepEqual(JSON.parse(readFileSync(join(h, "projects/sessions.json"), "utf8")), { s_aa: "p_0123abcd", s_bb: "p_0123abcd" });
    assert.throws(() => assignProject(h, "s_cc", "p_99999999"), /does not exist/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
