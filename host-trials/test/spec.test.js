import { test } from "node:test";
import assert from "node:assert/strict";
import { interleave, newTrial, parseArms, parseChange, parseStart } from "../lib/spec.js";
import { START, code } from "./helpers.js";

test("a valid start is answered with only its own fields, numbers from strings included", () => {
  const spec = parseStart({ ...START, runs: "3", project: "p_0123abcd", extra: "ignored" });
  assert.deepEqual(Object.keys(spec).sort(), ["arms", "costUsd", "minutes", "model", "project", "request", "runs", "scratchMb", "session"]);
  assert.equal(spec.runs, 3);
  assert.equal(spec.project, "p_0123abcd");
  assert.equal(parseStart(START).project, null);
});

test("every field of start is checked", () => {
  const bad = [
    { session: "nope" },
    { session: undefined },
    { request: "text" },
    { request: { text: "" } },
    { request: { text: "x".repeat(100_001) } },
    { request: { text: "hi", attachments: [{ id: "a" }] } },
    { project: "p_xyz" },
    { model: "" },
    { model: "two words" },
    { arms: [] },
    { runs: 0 },
    { runs: 6 },
    { runs: 1.5 },
    { costUsd: 0 },
    { costUsd: -1 },
    { costUsd: 101 },
    { costUsd: "lots" },
    { minutes: 0 },
    { minutes: 121 },
    { scratchMb: 10 },
    { scratchMb: 1e9 },
  ];
  for (const b of bad) assert.throws(() => parseStart({ ...START, ...b }), code("invalid"), JSON.stringify(b));
  assert.throws(() => parseStart(null), code("invalid"));
});

test("the arms are exactly base then change, either with a change or null, at least one with one", () => {
  const change = { kind: "guide-note", note: "n" };
  const removal = { kind: "skill", path: "skills/x/SKILL.md", content: null };
  assert.deepEqual(parseArms([{ id: "base", change: null }, { id: "change", change }]), [{ id: "base", change: null }, { id: "change", change }]);
  // A re-trial of an adopted change: the base arm undoes it, the change arm has nothing to add.
  assert.deepEqual(parseArms([{ id: "base", change: removal }, { id: "change", change: null }]), [{ id: "base", change: removal }, { id: "change", change: null }]);
  assert.deepEqual(parseArms([{ id: "base", change }, { id: "change" }])[1], { id: "change", change: null });
  for (const arms of [
    [{ id: "change", change }, { id: "base", change: null }],
    [{ id: "base", change: null }, { id: "change", change: null }],
    [{ id: "base" }, { id: "change" }],
    [{ id: "base", change: { kind: "nope" } }, { id: "change", change }],
    [{ id: "base", change: null }],
    [{ id: "base", change: null }, { id: "change", change }, { id: "x", change }],
  ]) assert.throws(() => parseArms(arms), code("invalid"), JSON.stringify(arms));
});

test("a skill change: a skill id, a path under skills/ with no way out, and content", () => {
  const ok = { kind: "skill", id: "thetis/packages", path: "skills/thetis/packages/SKILL.md", content: "---\nname: x\n---\n" };
  assert.deepEqual(parseChange({ ...ok, junk: 1 }), ok);
  for (const b of [
    { id: "Bad Id" },
    { path: "/home/x/skills/a/SKILL.md" },
    { path: "skills/../secrets/SKILL.md" },
    { path: "skills/a/../../x" },
    { path: "notskills/a/SKILL.md" },
    { path: "skills" },
    { path: "skills/.hidden/SKILL.md" },
    { path: "skills//a.md" },
    { path: "skills/a\\b.md" },
    { content: "" },
    { content: "x".repeat(256 * 1024 + 1) },
  ]) assert.throws(() => parseChange({ ...ok, ...b }), code("invalid"), JSON.stringify(b));
});

test("removals: a skill or instructions with content null, a config key with value null", () => {
  assert.deepEqual(parseChange({ kind: "skill", path: "skills/x/SKILL.md", content: null }), { kind: "skill", path: "skills/x/SKILL.md", content: null });
  assert.deepEqual(parseChange({ kind: "skill", id: "x", path: "skills/x/SKILL.md", content: null }), { kind: "skill", id: "x", path: "skills/x/SKILL.md", content: null });
  assert.throws(() => parseChange({ kind: "skill", path: "skills/../x", content: null }), code("invalid"));
  assert.throws(() => parseChange({ kind: "skill", id: "Bad Id", path: "skills/x/SKILL.md", content: null }), code("invalid"));
  assert.throws(() => parseChange({ kind: "skill", id: "x", path: "skills/x/SKILL.md" }), code("invalid"), "absent content is not a removal");
  assert.deepEqual(parseChange({ kind: "project-instructions", project: "p_0123abcd", content: null }), { kind: "project-instructions", project: "p_0123abcd", content: null });
  assert.deepEqual(parseChange({ kind: "config", package: "@thetis/x", key: "k", value: null }), { kind: "config", package: "@thetis/x", key: "k", value: null });
  // A revert of the guide notes is a config change; a guide-note change is only ever an append.
  assert.deepEqual(parseChange({ kind: "config", package: "@thetis/harness-core", key: "guideNotes", value: ["a"] }).value, ["a"]);
  assert.throws(() => parseChange({ kind: "guide-note", note: null }), code("invalid"));
});

test("a project-instructions change names a project and carries text", () => {
  assert.deepEqual(parseChange({ kind: "project-instructions", project: "p_0123abcd", content: "Use pnpm." }), { kind: "project-instructions", project: "p_0123abcd", content: "Use pnpm." });
  assert.deepEqual(parseChange({ kind: "project-instructions", project: "p_0123abcd", content: "" }).content, "");
  for (const b of [{ project: "../p" }, { project: "p_0123abc" }, { content: 5 }, { content: "x".repeat(32 * 1024 + 1) }]) {
    assert.throws(() => parseChange({ kind: "project-instructions", project: "p_0123abcd", content: "x", ...b }), code("invalid"), JSON.stringify(b));
  }
});

test("a guide note is one line of at most 300 characters", () => {
  assert.deepEqual(parseChange({ kind: "guide-note", note: "Read the error first." }), { kind: "guide-note", note: "Read the error first." });
  for (const note of ["", "  ", "a\nb", "a\rb", "x".repeat(301), 5]) assert.throws(() => parseChange({ kind: "guide-note", note }), code("invalid"), JSON.stringify(note));
  assert.equal(parseChange({ kind: "guide-note", note: "x".repeat(300) }).note.length, 300);
});

test("a config change names a package and a key, and its value is JSON", () => {
  assert.deepEqual(parseChange({ kind: "config", package: "@thetis/tools-files", key: "maxBytes", value: 5 }), { kind: "config", package: "@thetis/tools-files", key: "maxBytes", value: 5 });
  assert.deepEqual(parseChange({ kind: "config", package: "@thetis/x", key: "k", value: { a: [1] } }).value, { a: [1] });
  for (const b of [{ package: "tools-files" }, { package: "@thetis/../x" }, { key: "a.b" }, { key: "1a" }, { value: undefined }, { value: "x".repeat(70_000) }]) {
    assert.throws(() => parseChange({ kind: "config", package: "@thetis/x", key: "k", value: 1, ...b }), code("invalid"), JSON.stringify(b));
  }
});

test("an unknown kind or a non-object is refused", () => {
  for (const c of [null, "skill", [], { kind: "prompt" }, {}]) assert.throws(() => parseChange(c), code("invalid"));
});

test("runs interleave the arms: base-1, change-1, base-2, change-2", () => {
  const arms = [{ id: "base" }, { id: "change" }];
  assert.deepEqual(interleave(arms, 3).map((r) => `${r.arm}-${r.n}`), ["base-1", "change-1", "base-2", "change-2", "base-3", "change-3"]);
  assert.deepEqual(interleave(arms, 1).map((r) => `${r.arm}-${r.n}`), ["base-1", "change-1"]);
});

test("a new trial is queued, every run queued, with the contract's fields", () => {
  const spec = parseStart(START);
  const trial = newTrial({ id: "t_0123abcd", user: "ann", spec, now: "2026-10-20T00:00:00.000Z" });
  assert.equal(trial.state, "queued");
  assert.deepEqual(trial.runs[0], { arm: "base", n: 1, state: "queued", session: null, costUsd: 0, tokens: 0, startedAt: null, finishedAt: null });
  assert.equal(trial.runs.length, 4);
  for (const k of ["id", "user", "session", "state", "model", "project", "request", "arms", "runs", "costUsd", "createdAt"]) assert.ok(k in trial, k);
  assert.equal(trial.capUsd, 1);
});
