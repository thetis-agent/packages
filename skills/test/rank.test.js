// BM25 determinism, fusion, and the two parent rules against small fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens, bm25Index, bm25Search, fuse, absorb, promote, closest } from "../lib/rank.js";

const sk = (id, description, tags = []) => ({ id, name: id.split("/").pop(), description, tags });
const skills = [
  sk("packages", "Install, fork and promote packages. Use when asked to change what is installed.", ["install"]),
  sk("packages/forks", "Fork an installed package and replace it with the copy.", ["fork"]),
  sk("projects", "Named workspaces with directories and instructions.", ["workspace"]),
  sk("concise", "Answer in short sentences."),
  sk("bench", "Measure the harness with the benchmark suites.", ["benchmark", "measure"]),
];

test("tokens: lowercase, split on non-alphanumerics, no stop words, no one-letter tokens", () => {
  assert.deepEqual(tokens("Install the Packages, and use v1.2 of R!"), ["install", "packages", "v1", "of"]);
});

test("bm25Search ranks the best match first, breaks ties by id, and is deterministic across index orders", () => {
  const a = bm25Index(skills);
  const b = bm25Index([...skills].reverse());
  const q = "how do I fork a package";
  const ra = bm25Search(a, q, 10);
  const rb = bm25Search(b, q, 10);
  assert.deepEqual(ra, rb);
  assert.equal(ra[0].id, "packages/forks");
  assert.ok(ra.every((h) => h.score > 0));
  assert.deepEqual(bm25Search(a, "nothing matches zzz", 10), []);
  // Two documents with an equal score come back in id order.
  const tie = bm25Index([sk("b", "same words here"), sk("a", "same words here")]);
  assert.deepEqual(bm25Search(tie, "same words", 10).map((h) => h.id), ["a", "b"]);
});

test("bm25Search respects k", () => {
  const idx = bm25Index(skills);
  assert.equal(bm25Search(idx, "packages fork install workspace benchmark", 2).length, 2);
});

test("fuse: weighted reciprocal rank fusion with K 60; an empty side leaves the other's order", () => {
  const dense = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const lexical = [{ id: "c" }, { id: "a" }];
  const out = fuse(dense, lexical, 0.7);
  assert.deepEqual(out.map((h) => h.id), ["a", "c", "b"]);
  assert.equal(out[0].score, Math.round((0.7 / 61 + 0.3 / 62) * 1e6) / 1e6);
  assert.deepEqual(fuse([], lexical, 0.7).map((h) => h.id), ["c", "a"]);
  assert.deepEqual(fuse(dense, [], 0.7).map((h) => h.id), ["a", "b", "c"]);
  assert.deepEqual(fuse(["x", "y"], ["y"], 0.5).map((h) => h.id), ["y", "x"]);
});

test("absorb folds a child into a parent that is also in the pool, keeping the better score", () => {
  const ranked = [
    { id: "packages/forks", score: 3 },
    { id: "projects", score: 2 },
    { id: "packages", score: 1 },
  ];
  const out = absorb(skills, ranked);
  assert.deepEqual(out, [
    { id: "packages", score: 3 },
    { id: "projects", score: 2 },
  ]);
  // A child whose parent is absent is left alone.
  assert.deepEqual(absorb(skills, [{ id: "packages/forks", score: 3 }]), [{ id: "packages/forks", score: 3 }]);
});

test("promote adds the parent of a lone child at 0.99 of its score and cuts to the limit", () => {
  const out = promote(skills, [{ id: "packages/forks", score: 2 }, { id: "projects", score: 1 }], 3);
  assert.deepEqual(out, [
    { id: "packages/forks", score: 2 },
    { id: "packages", score: 1.98, how: "promoted" },
    { id: "projects", score: 1 },
  ]);
  assert.equal(promote(skills, [{ id: "packages/forks", score: 2 }, { id: "projects", score: 1 }], 2).length, 2);
  // A parent already in the pool is not added twice.
  assert.equal(promote(skills, [{ id: "packages/forks", score: 2 }, { id: "packages", score: 1 }], 5).length, 2);
});

test("closest names the nearest ids for a misspelt name", () => {
  assert.equal(closest(skills, "package", 3)[0], "packages");
  assert.equal(closest(skills, "fork", 3)[0], "packages/forks");
  assert.equal(closest(skills, "projcts", 1)[0], "projects");
});
