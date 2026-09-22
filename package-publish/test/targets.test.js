// `publish_targets`: what a person is asking when they ask where they may publish, which is nearly always
// "is what I have here in front of what is out there". The answer is fields, because a page renders it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { publish } from "../lib/publish.js";
import { targets } from "../lib/targets.js";
import { publishPackage, publishTargets, unpublishPackage } from "../index.js";
import { makeEnv, makePackage, makeRegistry, manifest, seedRegistry, temp } from "./helpers.js";

test("without a package it is the configured list and nothing is cloned", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: "file:///srv/reg.git" }, { name: "team", url: "git@git.example.com:t/p.git", branch: "trunk" }] } });
  const r = await targets({}, env);
  assert.equal(r.package, null);
  assert.equal(r.defaultTarget, null, "two targets, so none is the default");
  assert.equal(r.workDir, join(fx.home, "publish"));
  assert.deepEqual(r.targets.map((x) => [x.name, x.url, x.branch, x.cloned]), [
    ["reg", "file:///srv/reg.git", null, false],
    ["team", "git@git.example.com:t/p.git", "trunk", false],
  ]);
  assert.ok(!existsSync(join(fx.home, "publish")), "asking what is configured costs no network");
});

test("with a package it says what each target holds and whether this one is in front", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const held = await makeRegistry(fx.root, "held");
  const empty = await makeRegistry(fx.root, "empty");
  await seedRegistry(fx.root, held, { hello: manifest("@alice/hello", "0.3.0") });
  await seedRegistry(fx.root, empty, {});
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.2.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "held", url: `file://${held}` }, { name: "empty", url: `file://${empty}` }] } });

  const r = await targets({ package: "packages/hello" }, env);
  assert.deepEqual(r.package, { name: "@alice/hello", version: "0.2.0", path: join(fx.home, "packages", "hello"), directory: "hello", installed: false, problem: null });
  const [a, b] = r.targets;
  assert.equal(a.holds, "0.3.0");
  assert.equal(a.directory, "hello");
  assert.equal(a.first, false);
  assert.equal(a.ahead, false, "0.2.0 is behind the 0.3.0 the registry holds");
  assert.equal(a.mode, "copy");
  assert.equal(b.holds, null);
  assert.equal(b.first, true);
  assert.equal(b.ahead, true, "a registry that does not hold it at all is a first publish");
});

test("an unsound package is reported on the card, not thrown", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await makePackage(join(fx.home, "packages", "hello"), { name: "@alice/hello", version: "0.1.0", main: "index.js" });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}` }] } });
  const r = await targets({ package: "packages/hello" }, env);
  assert.match(r.package.problem, /has no thetis field/);
});

test("one unreachable registry does not hide what the other one holds", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const good = await makeRegistry(fx.root, "good");
  await seedRegistry(fx.root, good, { hello: manifest("@alice/hello", "0.1.0") });
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "gone", url: `file://${join(fx.root, "gone.git")}` }, { name: "good", url: `file://${good}` }] } });

  const r = await targets({ package: "packages/hello" }, env);
  assert.equal(r.targets[0].code, "git");
  assert.match(r.targets[0].error, /could not clone gone/);
  assert.equal(r.targets[1].holds, "0.1.0");
  assert.equal(r.targets[1].error, null);
});

test("the last publish to a target is read back, which is the record the package can keep", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });
  assert.equal((await targets({}, env)).targets[0].lastPublish, null);

  await publish({ package: "packages/hello" }, env);
  const row = (await targets({}, env)).targets[0].lastPublish;
  assert.equal(row.name, "@alice/hello");
  assert.equal(row.version, "0.1.0");
  assert.equal(row.first, true);
  assert.equal(row.target, "reg");
  assert.match(row.at, /^\d{4}-/);
});

test("the tool exports are the library, with the arguments a model actually sends", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const dry = await publishPackage({ package: " packages/hello ", to: "reg", dryRun: "true" }, env);
  assert.equal(dry.dryRun, true, "a model writes JSON, and it writes booleans as strings");
  assert.equal(dry.package, "@alice/hello", "and pads its strings");

  const real = await publishPackage({ package: "packages/hello", dryRun: "false" }, env);
  assert.equal(real.dryRun, false, "the string false is not a dry run either way round");
  assert.equal(real.pushed, true);
  assert.equal((await publishTargets({ package: "packages/hello" }, env)).targets[0].holds, "0.1.0");

  const gone = await unpublishPackage({ package: " @alice/hello ", to: " reg ", dryRun: "0" }, env);
  assert.equal(gone.dryRun, false, "the string zero is not a dry run either");
  assert.equal(gone.package, "@alice/hello");
  assert.equal(gone.pushed, true);
  const after = (await publishTargets({ package: "packages/hello" }, env)).targets[0];
  assert.equal(after.holds, null, "the registry stopped holding it");
  assert.equal(after.lastRemoval.name, "@alice/hello", "and the removal is read back where the record is shown");
  assert.equal(after.lastPublish.version, "0.1.0", "while the last publish goes on meaning the last publish");
});

test("a fence with no store loses the record and nothing else", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] }, storage: false });
  const r = await publish({ package: "packages/hello" }, env);
  assert.equal(r.pushed, true);
  assert.equal(r.records, null);
});
