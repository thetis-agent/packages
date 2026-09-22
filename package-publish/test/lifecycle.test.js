// The whole loop, in the order a person walks it, against a real bare registry: create a package, publish
// it, fork it, change the fork, publish the change, go back to the origin, and take the package out of the
// registry. Every step asserts what the registry holds afterwards, because that is the only thing any other
// installation ever sees, and it is where both of the holes this file exists for were.
//
// The two that were wrong: publishing a fork used to put a second, separate package in the registry with
// nothing said about it, so the change went out under a name nobody installs and un-forking put the person
// back on the old code; and nothing could take a package out of a registry at all. A unit test for either
// would have passed all the way through. Only walking the loop shows that it does not close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publish } from "../lib/publish.js";
import { unpublish } from "../lib/unpublish.js";
import { held, makeEnv, makeFork, makePackage, makeRegistry, manifest, refusal, show, temp, versionIn } from "./helpers.js";

test("create, publish, fork, change, publish as the origin, un-fork, remove", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  // 1. Create. A package existing publishes nothing, which is the whole premise of this package.
  const widget = await makePackage(join(fx.home, "packages", "widget"), manifest("@dev/widget", "0.1.0"), { "index.js": "export const answer = 1;\n" });
  assert.deepEqual(held(bare), {});

  // 2. Publish.
  const first = await publish({ package: "packages/widget", to: "reg" }, env);
  assert.equal(first.first, true);
  assert.equal(first.as, "itself", "a package that is nobody's copy is published as itself and asked nothing");
  assert.equal(first.forkedFrom, null);
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.1.0" });

  // 3. Fork. The copy takes its own name and a fork's version, and records where it came from.
  const mine = await makeFork(join(fx.home, "packages", "widget-mine"), widget, "@dev/widget-mine");
  const forked = async () => JSON.parse(await readFile(join(mine, "package.json"), "utf8"));
  assert.equal((await forked()).version, "0.1.0-fork.1");
  assert.deepEqual((await forked()).thetis.forkedFrom, { name: "@dev/widget", version: "0.1.0" });
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.1.0" }, "forking publishes nothing either");

  // 4. Change the fork.
  await writeFile(join(mine, "index.js"), "export const answer = 42;\n");

  // 5. Publish it. This is the step that used to grow a second package in silence. "Publish my change" over
  //    a fork is two different acts, so it is refused until the person says which, and both are named.
  const asked = await refusal(publish({ package: "packages/widget-mine", to: "reg", version: "0.2.0" }, env));
  assert.equal(asked.code, "ambiguous-fork");
  assert.match(asked.message, /@dev\/widget-mine is a fork of @dev\/widget, and reg already holds @dev\/widget in widget\//);
  assert.match(asked.message, /thetis publish packages\/widget-mine --to reg --as origin --version 0\.1\.1/, "the upstreaming way out, as a command");
  assert.match(asked.message, /thetis publish packages\/widget-mine --to reg --as itself/, "and the divergence, as a command");
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.1.0" }, "and nothing went anywhere");

  // 5b. As its origin: the change becomes the next version of the package it was forked from.
  const up = await publish({ package: "packages/widget-mine", to: "reg", as: "origin", version: "0.2.0" }, env);
  assert.equal(up.package, "@dev/widget", "what was published is the origin");
  assert.equal(up.as, "origin");
  assert.equal(up.directory, "widget", "in the origin's own directory, not a new one");
  assert.equal(up.was, "0.1.0", "measured against what the target holds for the origin");
  assert.equal(up.now, "0.2.0");
  assert.equal(up.first, false);
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.2.0" }, "one package in the registry, at a new version");

  const published = JSON.parse(show(bare, "main", "widget/package.json"));
  assert.equal(published.name, "@dev/widget");
  assert.equal(published.version, "0.2.0");
  assert.ok(!("forkedFrom" in published.thetis), "what landed is the origin, not a copy that would displace it on install");
  assert.equal(show(bare, "main", "widget/index.js"), "export const answer = 42;\n", "carrying the change");

  // The person's own copy is not rewritten. They go on running their fork, under their own name.
  assert.equal((await forked()).name, "@dev/widget-mine");
  assert.equal((await forked()).version, "0.1.0-fork.1");
  assert.deepEqual((await forked()).thetis.forkedFrom, { name: "@dev/widget", version: "0.1.0" });
  assert.match(up.summary, /Your copy is still @dev\/widget-mine 0\.1\.0-fork\.1, a fork\./);
  assert.equal(up.journals[0].data.fork, "@dev/widget-mine", "the row says which copy the origin's new version came out of");
  assert.equal(up.records[0].fork, "@dev/widget-mine");

  // 6. Un-fork. The swap itself is the kernel's; what this step turns on is what it puts the person back
  //    on, and that is now their own work rather than the code they left behind.
  assert.equal(versionIn(bare, "main", "widget"), "0.2.0");
  assert.equal(show(bare, "main", "widget/index.js"), "export const answer = 42;\n", "going back to @dev/widget is going back to their change, which is the loop closing");
  assert.ok(existsSync(join(mine, "index.js")), "and the fork's files are still on disk, which is what un-fork leaves behind");

  // 7. Remove. The registry stops carrying it at all.
  const gone = await unpublish({ package: "@dev/widget", to: "reg" }, env);
  assert.equal(gone.removed, true);
  assert.equal(gone.pushed, true);
  assert.equal(gone.package, "@dev/widget");
  assert.equal(gone.held, "0.2.0", "the version it was holding when it went");
  assert.equal(gone.directory, "widget");
  assert.deepEqual([...gone.files].sort(), ["widget/index.js", "widget/package.json"]);
  assert.deepEqual(held(bare), {}, "the registry holds nothing now");
  assert.equal(show(bare, "main", "widget/package.json"), null);
  assert.equal(gone.journals[0].kind, "package.unpublish", "its own kind of row, not a publish with a flag on it");
  assert.equal(gone.journals[0].data.version, "0.2.0");
  assert.equal(gone.records[0].removed, true);
  assert.match(gone.summary, /leaves the marketplace index at the next refresh/);
  assert.match(gone.summary, /Every installation that already has it keeps it, goes on running it, and is not told\./);

  // And removing it again is refused rather than committing nothing: there is a difference between a
  // registry that dropped a package and a person who thinks one did.
  const twice = await refusal(unpublish({ package: "@dev/widget", to: "reg" }, env));
  assert.equal(twice.code, "not-held");
  assert.match(twice.message, /reg does not hold @dev\/widget on main, so there is nothing to take out of it\./);
});

test("the other way out: a fork published as itself is a package of its own, and is asked only once", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });
  const widget = await makePackage(join(fx.home, "packages", "widget"), manifest("@dev/widget", "0.1.0"));
  await publish({ package: "packages/widget", to: "reg" }, env);
  const mine = await makeFork(join(fx.home, "packages", "widget-mine"), widget, "@dev/widget-mine");
  await writeFile(join(mine, "index.js"), "export const answer = 42;\n");

  const own = await publish({ package: "packages/widget-mine", to: "reg", as: "itself", version: "0.2.0" }, env);
  assert.equal(own.package, "@dev/widget-mine");
  assert.equal(own.as, "itself");
  assert.equal(own.forkedFrom, "@dev/widget", "it is still a fork, and the answer says so");
  assert.equal(own.first, true);
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.1.0", "widget-mine": "@dev/widget-mine@0.2.0" }, "two packages, deliberately");
  assert.ok(JSON.parse(show(bare, "main", "widget-mine/package.json")).thetis.forkedFrom, "published as itself, it stays a fork and goes on displacing the origin where it is installed");

  // The registry now carries the answer, so the question is not asked again. A second publish of a package
  // the target already holds under its own name has only one reading left.
  const again = await publish({ package: "packages/widget-mine", to: "reg", version: "0.3.0" }, env);
  assert.equal(again.package, "@dev/widget-mine");
  assert.equal(again.was, "0.2.0");
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.1.0", "widget-mine": "@dev/widget-mine@0.3.0" });
});
