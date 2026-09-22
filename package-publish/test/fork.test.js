// The gate a fork meets, and the publish it turns into. `lifecycle.test.js` walks the whole loop; this one
// is the corners of it: when the question is asked and when it is not, what `as` refuses, and where the
// version of an as-origin publish comes from, which is the origin's and never the fork's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publish } from "../lib/publish.js";
import { held, makeCheckout, makeEnv, makeFork, makePackage, makeRegistry, manifest, refusal, seedRegistry, show, temp } from "./helpers.js";

const oneTarget = (bare) => ({ targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] });

/** A registry holding @dev/widget 0.1.0, a local copy of it, and a fork of that copy. */
async function forked(t, { publishOrigin = true } = {}) {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  const env = makeEnv(fx.home, { config: oneTarget(bare) });
  const widget = await makePackage(join(fx.home, "packages", "widget"), manifest("@dev/widget", "0.1.0"));
  if (publishOrigin) await publish({ package: "packages/widget", to: "reg" }, env);
  const mine = await makeFork(join(fx.home, "packages", "widget-mine"), widget, "@dev/widget-mine");
  await writeFile(join(mine, "index.js"), "export const answer = 42;\n");
  return { ...fx, bare, env, widget, mine };
}

test("as takes origin or itself, and origin needs a package that is a fork", async (t) => {
  const fx = await forked(t);
  const sideways = await refusal(publish({ package: "packages/widget-mine", to: "reg", as: "sideways" }, fx.env));
  assert.equal(sideways.code, "bad-as");
  assert.match(sideways.message, /A publish goes as origin or as itself, not as sideways\./);
  assert.match(sideways.message, /the change becomes the next version of the package this one was forked from/, "it says what each of the two means");

  const plain = await refusal(publish({ package: "packages/widget", to: "reg", as: "origin", bump: "patch" }, fx.env));
  assert.equal(plain.code, "not-a-fork");
  assert.match(plain.message, /@dev\/widget is not a fork: its manifest has no thetis\.forkedFrom, so there is no origin to publish it as\./);
});

test("an as-origin publish is versioned as the origin, never as the fork", async (t) => {
  const fx = await forked(t);
  const unsaid = await refusal(publish({ package: "packages/widget-mine", to: "reg", as: "origin" }, fx.env));
  assert.equal(unsaid.code, "bad-version");
  assert.match(unsaid.message, /Publishing @dev\/widget-mine as @dev\/widget needs the version @dev\/widget becomes, and 0\.1\.0-fork\.1 is a fork's version, never one of the origin's\./);
  assert.match(unsaid.message, /ask for a patch, minor or major step from 0\.1\.0, which reg holds\./, "the step is offered from what the registry holds, not from the fork");

  const forkish = await refusal(publish({ package: "packages/widget-mine", to: "reg", as: "origin", version: "0.2.0-fork.1" }, fx.env));
  assert.equal(forkish.code, "bad-version");
  assert.match(forkish.message, /0\.2\.0-fork\.1 is a fork's version, and @dev\/widget is not a fork\. Give the version @dev\/widget becomes, such as 0\.1\.1\./);

  // A step is taken from what the target holds for the origin. From the fork's own 0.1.0-fork.1 a patch
  // would be 0.1.0, which is the version the registry already holds and the one thing it must never be.
  const stepped = await publish({ package: "packages/widget-mine", to: "reg", as: "origin", bump: "minor" }, fx.env);
  assert.equal(stepped.now, "0.2.0");
  assert.equal(stepped.was, "0.1.0");
  assert.deepEqual(held(fx.bare), { widget: "@dev/widget@0.2.0" });
  assert.equal(JSON.parse(await readFile(join(fx.mine, "package.json"), "utf8")).version, "0.1.0-fork.1", "and the fork's own file was not touched");
});

test("a version that does not move past what the target holds for the origin is refused for the origin", async (t) => {
  const fx = await forked(t);
  const err = await refusal(publish({ package: "packages/widget-mine", to: "reg", as: "origin", version: "0.1.0" }, fx.env));
  assert.equal(err.code, "not-newer");
  assert.match(err.message, /@dev\/widget 0\.1\.0 does not move past 0\.1\.0, which reg already holds/, "the name in the sentence is the one being published");
  assert.deepEqual(held(fx.bare), { widget: "@dev/widget@0.1.0" });
});

test("nothing is asked when the target does not hold the origin, and as origin is then a first publish", async (t) => {
  const fx = await forked(t, { publishOrigin: false });
  const alone = await publish({ package: "packages/widget-mine", to: "reg" }, fx.env);
  assert.equal(alone.as, "itself", "there is no second reading to offer when the registry has never heard of the origin");
  assert.equal(alone.package, "@dev/widget-mine");
  assert.deepEqual(held(fx.bare), { "widget-mine": "@dev/widget-mine@0.1.0-fork.1" });

  // Said deliberately, it still goes: the origin's unscoped name is the directory a registry gives a
  // package it does not hold yet, exactly as a first publish of the origin itself would have got.
  const up = await publish({ package: "packages/widget-mine", to: "reg", as: "origin", version: "0.2.0" }, fx.env);
  assert.equal(up.package, "@dev/widget");
  assert.equal(up.directory, "widget");
  assert.equal(up.first, true);
  assert.deepEqual(held(fx.bare), { widget: "@dev/widget@0.2.0", "widget-mine": "@dev/widget-mine@0.1.0-fork.1" });
});

test("a dry run reports the fork question instead of refusing it, and says what each way out would do", async (t) => {
  const fx = await forked(t);
  const r = await publish({ package: "packages/widget-mine", to: "reg", version: "0.2.0", dryRun: true }, fx.env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blockers.map((b) => b.code), ["ambiguous-fork"]);
  assert.match(r.blockers[0].message, /--as origin --version 0\.1\.1/);
  assert.equal(r.blockers[0].details.origin.dir, "widget", "in fields as well as in the sentence, for a page that draws it");
  assert.equal(r.blockers[0].details.fork.name, "@dev/widget-mine");
  assert.equal(r.package, "@dev/widget-mine", "and what it reports is the publish it would have made, which is as itself");
  assert.equal(r.committed, false);
  assert.deepEqual(held(fx.bare), { widget: "@dev/widget@0.1.0" });
});

test("a fork inside the registry checkout cannot be published as its origin, and is told why", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "0.1.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  const mine = await makeFork(join(checkout, "widget-mine"), join(checkout, "widget"), "@dev/widget-mine");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@dev/widget-mine", root: mine }] });

  const err = await refusal(publish({ package: "@dev/widget-mine", to: "reg", as: "origin", version: "0.2.0" }, env));
  assert.equal(err.code, "fork-in-checkout");
  assert.match(err.message, /is inside the registry checkout at /);
  assert.match(err.message, /commits the directory a package already sits in and copies nothing, so it cannot go into @dev\/widget's directory from there/);
  assert.match(err.message, /Publish it as itself, or move the fork out of the checkout/);
  assert.equal(show(bare, "main", "widget-mine/package.json"), null, "nothing was published");
});
