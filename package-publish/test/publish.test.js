// The two sources, both of them end to end against a real bare repository over `file://`: a userspace
// package that is not a git repository at all and has to be copied into a clone, and a package that is
// already inside a checkout of the target, which is the maintainer's own case and the one where a commit
// must not spill over into the rest of the tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publish } from "../lib/publish.js";
import { AUTHOR, git, makeCheckout, makeEnv, makePackage, makeRegistry, manifest, refusal, seedRegistry, show, temp, versionIn } from "./helpers.js";

test("a userspace package is cloned into, copied in, committed and pushed", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  const src = await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"), { "README.md": "# hello\n" });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const first = await publish({ package: "packages/hello" }, env);
  assert.equal(first.ok, true);
  assert.equal(first.mode, "copy");
  assert.equal(first.first, true, "a registry that does not hold the package at all is a first publish");
  assert.equal(first.was, null);
  assert.equal(first.now, "0.1.0");
  assert.equal(first.directory, "hello");
  assert.equal(first.branch, "main");
  assert.equal(first.target, "reg");
  assert.equal(first.pushed, true);
  assert.equal(first.committed, true);
  assert.match(first.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual([...first.files].sort(), ["hello/README.md", "hello/index.js", "hello/package.json"]);
  assert.equal(versionIn(bare, "main", "hello"), "0.1.0", "the registry holds it now");
  assert.equal(first.repo, join(fx.home, "publish", "reg"), "the clone lives under the configured work directory");

  // The same version again is the refusal the package exists for.
  const again = await refusal(publish({ package: "packages/hello" }, env));
  assert.equal(again.code, "not-newer");
  assert.match(again.message, /does not move past 0\.1\.0, which reg already holds/);
  assert.match(again.message, /Raise the version to 0\.1\.1 or later, then publish it\./, "the closing reads for a person, not as an argument to pass");

  const bumped = await publish({ package: "packages/hello", bump: "minor" }, env);
  assert.equal(bumped.was, "0.1.0");
  assert.equal(bumped.now, "0.2.0");
  assert.equal(bumped.first, false);
  assert.equal(versionIn(bare, "main", "hello"), "0.2.0");
  assert.equal(JSON.parse(await readFile(join(src, "package.json"), "utf8")).version, "0.2.0", "the source manifest moved too, so the next bump starts from here");
});

test("a file the package no longer has stops being in the registry", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  const src = await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"), { "old.js": "export const gone = true;\n" });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });
  await publish({ package: "packages/hello" }, env);
  assert.ok(show(bare, "main", "hello/old.js"));

  await rm(join(src, "old.js"));
  const next = await publish({ package: "packages/hello", bump: "patch" }, env);
  assert.ok(next.files.includes("hello/old.js"), "the removal is one of the files that went");
  assert.equal(show(bare, "main", "hello/old.js"), null, "a copy over the top would have left it there for ever");
});

test("node_modules never travels into the registry", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"), { "node_modules/left/index.js": "module.exports = 1;\n" });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });
  const r = await publish({ package: "packages/hello" }, env);
  assert.ok(!r.files.some((f) => f.includes("node_modules")), r.files.join(", "));
  assert.equal(show(bare, "main", "hello/node_modules/left/index.js"), null);
});

test("a package inside a checkout of the target commits only its own directory", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@thetis/hello", "0.1.0"), other: manifest("@thetis/other", "0.3.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  await writeFile(join(checkout, "hello", "index.js"), "export const ok = 2;\n");
  await writeFile(join(checkout, "other", "index.js"), "export const meddled = true;\n");
  // The url is written the other way round from the checkout's own origin on purpose: one is a plain
  // path, the other a file url, and the two have to be recognised as one repository for this to work.
  const env = makeEnv(fx.home, {
    config: { targets: [{ name: "reg", url: `file://${bare}` }] },
    packages: [{ name: "@thetis/hello", version: "0.1.0", root: join(checkout, "hello") }],
  });

  const r = await publish({ package: "@thetis/hello", bump: "patch" }, env);
  assert.equal(r.mode, "checkout", "the checkout is the work tree; nothing is cloned or copied");
  assert.equal(r.repo, checkout);
  assert.equal(r.directory, "hello");
  assert.equal(r.was, "0.1.0");
  assert.equal(r.now, "0.1.1");
  assert.deepEqual([...r.files].sort(), ["hello/index.js", "hello/package.json"]);
  assert.equal(versionIn(bare, "main", "hello"), "0.1.1");
  assert.equal(show(bare, "main", "other/index.js"), "export const ok = true;\n", "the other package is untouched in the registry");
  assert.match(git(checkout, "status", "--porcelain"), /other\/index\.js/, "and its change is still in the tree, not quietly committed or dropped");
  assert.ok(!existsSync(join(fx.home, "publish", "reg")), "the checkout case clones nothing");
});

test("a checkout with another package staged is refused by name", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@thetis/hello", "0.1.0"), other: manifest("@thetis/other", "0.3.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  await writeFile(join(checkout, "other", "index.js"), "export const meddled = true;\n");
  git(checkout, "add", "other/index.js");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@thetis/hello", root: join(checkout, "hello") }] });

  const err = await refusal(publish({ package: "@thetis/hello", bump: "patch" }, env));
  assert.equal(err.code, "dirty-index");
  assert.match(err.message, /other\/index\.js/, "it says which");
  assert.match(err.message, /commits only hello\//, "and that only this package's directory would go");
  assert.equal(versionIn(bare, "main", "hello"), "0.1.0", "nothing was published");
  assert.equal(JSON.parse(await readFile(join(checkout, "hello", "package.json"), "utf8")).version, "0.1.0", "and no version was written");
});

test("a checkout that is behind the registry is refused rather than finding out at the push", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@thetis/hello", "0.1.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  // Somebody else publishes 0.5.0 while this checkout is not looking.
  const other = await makeCheckout(fx.root, bare, "other-checkout");
  await writeFile(join(other, "hello", "package.json"), `${JSON.stringify(manifest("@thetis/hello", "0.5.0"), null, 2)}\n`);
  git(other, "add", "-A");
  git(other, ...AUTHOR, "commit", "-m", "0.5.0");
  git(other, "push", "origin", "main");

  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@thetis/hello", root: join(checkout, "hello") }] });
  const err = await refusal(publish({ package: "@thetis/hello", bump: "patch" }, env));
  assert.equal(err.code, "not-newer");
  assert.match(err.message, /0\.1\.1 does not move past 0\.5\.0/);
  assert.match(err.message, /Raise the version to 0\.5\.1 or later/);
});

test("a dry run reports what would happen and changes nothing", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@thetis/hello", "0.1.0") });
  const src = await makePackage(join(fx.home, "packages", "hello"), manifest("@thetis/hello", "0.1.0"), { "extra.js": "export const x = 1;\n" });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}` }] } });

  const r = await publish({ package: "packages/hello", bump: "minor", dryRun: true }, env);
  assert.equal(r.dryRun, true);
  assert.equal(r.committed, false);
  assert.equal(r.pushed, false);
  assert.equal(r.commit, null);
  assert.equal(r.was, "0.1.0");
  assert.equal(r.now, "0.2.0");
  assert.ok(r.files.includes("hello/extra.js"), r.files.join(", "));
  assert.ok(r.files.includes("hello/package.json"), "the manifest is named even though the version is not written in a dry run");
  assert.equal(versionIn(bare, "main", "hello"), "0.1.0", "the registry is where it was");
  assert.equal(JSON.parse(await readFile(join(src, "package.json"), "utf8")).version, "0.1.0", "and so is the package");
  assert.match(r.summary, /^dry run: /);
});

test("a dry run in a checkout leaves the index exactly as it found it", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@thetis/hello", "0.1.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  await writeFile(join(checkout, "hello", "index.js"), "export const ok = 2;\n");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@thetis/hello", root: join(checkout, "hello") }] });

  const r = await publish({ package: "@thetis/hello", bump: "patch", dryRun: true }, env);
  assert.equal(r.mode, "checkout");
  assert.deepEqual([...r.files].sort(), ["hello/index.js", "hello/package.json"]);
  assert.equal(git(checkout, "diff", "--cached", "--name-only"), "", "nothing was staged");
  assert.equal(git(checkout, "rev-parse", "HEAD"), git(checkout, "rev-parse", "origin/main"), "and nothing was committed");
});

test("the answer carries the journal rows the kernel has no seam to take", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "1.0.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const first = await publish({ package: "packages/hello" }, env);
  assert.equal(first.journals.length, 1, "one row per package this act published");
  assert.equal(first.journals[0].kind, "package.publish");
  assert.equal(first.journals[0].target, "@alice/hello");
  assert.deepEqual(Object.keys(first.journals[0].data).sort(), ["branch", "commit", "first", "name", "target", "url", "version"]);
  assert.equal(first.journals[0].data.first, true);
  assert.ok(!("was" in first.journals[0].data), "a first publish has no version it moved past");

  const next = await publish({ package: "packages/hello", bump: "patch" }, env);
  assert.equal(next.journals[0].data.was, "1.0.0");
  assert.equal(next.journals[0].data.version, "1.0.1");
  assert.equal(next.journals[0].data.first, false);
  assert.equal(next.journals[0].data.commit, next.commit);
  assert.equal(next.records[0].version, "1.0.1", "and the package keeps its own record, which is the seam it does have");
  // What the marketplace will pin, and the plain fact that its index has not seen it yet.
  assert.equal(next.source, `${next.url}#hello@${next.commit}`);
  assert.equal(next.indexed, false);
  assert.match(next.summary, /The marketplace index catches up on its next refresh\./);
});
