// The version rules, which are the gate the package exists for. There is no semver dependency in this
// repository, so they are written out and checked here.
//
// The ordering itself now lives in `@thetis/lib/versions` and is shared with `@thetis/marketplace`, which
// decides the same question on the way out. These cases stay pointed at it rather than being deleted: they
// are the ones this author thought of, the marketplace's own cases are the ones that author thought of, and
// a merge that kept only one set would have quietly dropped half of what is known about this function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions as fromMarketplace } from "@thetis/marketplace";
import { bumpVersion, compareVersions, isVersion } from "../lib/semver.js";

test("the marketplace and the publisher compare versions with one function, not two that agree today", () => {
  assert.equal(compareVersions, fromMarketplace, "the same function object, so there is nothing to drift");
});

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

test("everything has an order, including what this package would never publish", () => {
  // This is the case the two implementations disagreed on, and the strict one lost. `isVersion` still
  // refuses `1.2` as something to publish, but a registry is free to hold a package at it, and the version
  // a publish is measured against is read out of somebody else's manifest. Answering null there fell
  // through the `<= 0` test as though it meant "not newer", and refused every publish of that package.
  assert.ok(!isVersion("1.2"), "still not a version this package will write");
  assert.equal(compareVersions("1.2", "1.2.0"), 0, "and still exactly the version 1.2.0 is, when read");
  assert.equal(compareVersions("1.2.1", "1.2"), 1, "so a publish over it moves past it, and is allowed");
  assert.equal(compareVersions("1.2", "1.2.1"), -1);
  // Whatever the string is, it orders. Garbage in is garbage out, but never a null that reads as "no".
  assert.equal(compareVersions("latest", "1.0.0"), 1, "text sorts against text, and l is past 1");
  assert.equal(compareVersions("1.0.0", "latest"), -1);
  assert.equal(compareVersions("", "0.0.1"), -1, "and nothing at all is older than something");
});

test("one step along", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.0-rc.1", "patch"), "1.2.0", "a patch off a prerelease is the release it leads to");
  assert.equal(bumpVersion("nope", "patch"), null);
  assert.equal(bumpVersion("1.2", "patch"), null, "orderable is not the same as steppable; the refusal says so instead of guessing");
  assert.equal(bumpVersion("1.2.3", "sideways"), null);
});
