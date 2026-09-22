// The version comparison, which is the gate the package exists for. There is no semver dependency in this
// repository and a package in a fence installs none, so the rules are written out and checked here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bumpVersion, compareVersions, isVersion } from "../lib/semver.js";

test("what counts as a version", () => {
  for (const v of ["0.0.1", "1.2.3", "10.0.0", "1.0.0-rc.1", "1.0.0+build.5"]) assert.ok(isVersion(v), v);
  for (const v of ["1.2", "v1.2.3", "1.2.3.4", "latest", "", undefined, "1.2.x"]) assert.ok(!isVersion(v), String(v));
});

test("numbers compare as numbers, not as text", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
});

test("a release outranks its own prereleases, and prereleases order among themselves", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
});

test("build metadata is not a version difference", () => {
  assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
});

test("a version that is not one compares to nothing", () => {
  assert.equal(compareVersions("latest", "1.0.0"), null);
});

test("one step along", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.0-rc.1", "patch"), "1.2.0", "a patch off a prerelease is the release it leads to");
  assert.equal(bumpVersion("nope", "patch"), null);
  assert.equal(bumpVersion("1.2.3", "sideways"), null);
});
