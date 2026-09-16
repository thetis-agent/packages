// The hand parser: what the subset reads, and that everything outside it is refused rather than guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, splitDocument, yamlString } from "../lib/frontmatter.js";

test("key: value, a metadata block, inline and block lists, quoted strings", () => {
  const { data, errors } = parseFrontmatter(
    [
      "name: packages",
      'description: "What it does: installs. Use when asked to \\"install\\"."',
      "metadata:",
      "  title: 'Packages and forks'",
      "  tags: [install, forks, \"pro-mote\"]",
      "  related:",
      "    - packages/forks",
      "    - projects",
      '  universal: "true"',
      "  version: 3",
    ].join("\n"),
  );
  assert.deepEqual(errors, []);
  assert.equal(data.name, "packages");
  assert.equal(data.description, 'What it does: installs. Use when asked to "install".');
  assert.equal(data.metadata.title, "Packages and forks");
  assert.deepEqual(data.metadata.tags, ["install", "forks", "pro-mote"]);
  assert.deepEqual(data.metadata.related, ["packages/forks", "projects"]);
  assert.equal(data.metadata.universal, "true");
  assert.equal(data.metadata.version, "3");
});

test("blank lines and comment lines are skipped; a trailing comment is stripped from a plain value", () => {
  const { data, errors } = parseFrontmatter("# a comment\n\nname: x # the name\n\ndescription: y\n");
  assert.deepEqual(errors, []);
  assert.equal(data.name, "x");
  assert.equal(data.description, "y");
});

test("a value with a colon stays whole when plain", () => {
  const { data } = parseFrontmatter("description: Use when: the request says so");
  assert.equal(data.description, "Use when: the request says so");
});

test("block scalars are refused", () => {
  const { errors } = parseFrontmatter("description: >\n  a long\n  text\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 1: block scalars/);
});

test("a multi-line plain scalar is refused", () => {
  const { errors } = parseFrontmatter("description: first line\n  second line\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 2: unexpected indentation/);
});

test("a map nested more than one level is refused", () => {
  const { errors } = parseFrontmatter("metadata:\n  deep:\n    key: v\n");
  assert.match(errors[0], /nested more than one level/);
});

test("anchors, tags, flow maps and an unterminated quote are refused", () => {
  assert.match(parseFrontmatter("name: &a x").errors[0], /"&"/);
  assert.match(parseFrontmatter("name: !!str x").errors[0], /"!"/);
  assert.match(parseFrontmatter("meta: { a: 1 }").errors[0], /"\{"/);
  assert.match(parseFrontmatter('name: "open').errors[0], /double-quoted/);
  assert.match(parseFrontmatter("name: 'it's'").errors[0], /single quote/);
});

test("a repeated key is an error", () => {
  const { errors } = parseFrontmatter("name: a\nname: b\n");
  assert.match(errors[0], /appears twice/);
});

test("splitDocument finds the fences and keeps the body verbatim", () => {
  const { frontmatter, body } = splitDocument("---\nname: x\n---\nline one\n\n---\nnot a fence\n");
  assert.equal(frontmatter, "name: x");
  assert.equal(body, "line one\n\n---\nnot a fence\n");
  assert.equal(splitDocument("no fence").frontmatter, null);
  assert.equal(splitDocument("---\nname: x\n").frontmatter, null);
  assert.equal(splitDocument("---\r\nname: x\r\n---\r\nbody").body, "body");
});

test("yamlString round-trips through the parser", () => {
  for (const s of ["plain words", 'with "quotes"', "a: colon", "trailing space ", "  leading", "#hash", "x # y", "", "über"]) {
    const { data, errors } = parseFrontmatter(`k: ${yamlString(s)}`);
    assert.deepEqual(errors, [], s);
    assert.equal(data.k, s, JSON.stringify(s));
  }
});
