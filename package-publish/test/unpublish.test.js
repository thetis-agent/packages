// Taking a package out of a registry: the two sources, the gates, and the sentence that says what a
// removal does not do. `lifecycle.test.js` removes a package at the end of the loop; this one is what the
// act refuses, and the case that is easy to get wrong, which is removing a package this installation has
// never had a copy of.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unpublish } from "../lib/unpublish.js";
import { AUTHOR, git, held, makeCheckout, makeEnv, makePackage, makeRegistry, manifest, refusal, seedRegistry, show, temp } from "./helpers.js";

test("a package nothing here has ever held is removed by name", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "0.3.0"), other: manifest("@dev/other", "0.1.0") });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const r = await unpublish({ package: "@dev/widget", to: "reg" }, env);
  assert.equal(r.removed, true);
  assert.equal(r.mode, "copy", "nothing local is needed: a package published by mistake is often one nobody kept");
  assert.equal(r.held, "0.3.0");
  assert.equal(r.directory, "widget");
  assert.equal(r.pushed, true);
  assert.deepEqual(held(bare), { other: "@dev/other@0.1.0" }, "and only that one went");
  assert.equal(show(bare, "main", "README.md"), "# registry\n", "the rest of the repository is untouched");
});

test("a removal is refused when the target does not hold it, or holds something else there", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "0.3.0") });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const missing = await refusal(unpublish({ package: "@dev/nothing", to: "reg" }, env));
  assert.equal(missing.code, "not-held");
  assert.match(missing.message, /reg does not hold @dev\/nothing on main, so there is nothing to take out of it\./);
  assert.match(missing.message, /Check the name against what the registry holds, or the target, and try again\./);

  // The name is spelled the way the directory is, and the directory holds somebody else's package.
  const wrong = await refusal(unpublish({ package: "@someone/widget", to: "reg" }, env));
  assert.equal(wrong.code, "name-mismatch");
  assert.match(wrong.message, /reg holds @dev\/widget in widget\/, not @someone\/widget, so removing that directory would take somebody else's package out instead\./);
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.3.0" }, "neither refusal touched the registry");

  const nothing = await refusal(unpublish({ to: "reg" }, env));
  assert.equal(nothing.code, "no-package");
  assert.match(nothing.message, /unpublish needs a package/);
});

test("a removal by the directory the registry keeps it in", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { "widget-search": manifest("@dev/widget", "0.3.0") });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const r = await unpublish({ package: "widget-search", to: "reg" }, env);
  assert.equal(r.package, "@dev/widget", "the answer names the package, whatever the directory was called");
  assert.equal(r.directory, "widget-search");
  assert.deepEqual(held(bare), {});
});

test("a dry run says what would go and what the registry would be left holding, and changes nothing", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "0.3.0") });
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] } });

  const r = await unpublish({ package: "@dev/widget", to: "reg", dryRun: true }, env);
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
  assert.equal(r.pushed, false);
  assert.equal(r.commit, null);
  assert.deepEqual([...r.files].sort(), ["widget/index.js", "widget/package.json"]);
  assert.match(r.summary, /^dry run: @dev\/widget 0\.3\.0 would be taken out of reg \(main\)/);
  assert.match(r.summary, /Every installation that already has it keeps it, goes on running it, and is not told\./);
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.3.0" });
});

test("in a checkout that is the registry, the removal is a commit in the checkout and says so", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "0.3.0"), other: manifest("@dev/other", "0.1.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@dev/widget", root: join(checkout, "widget") }] });

  const r = await unpublish({ package: "@dev/widget", to: "reg" }, env);
  assert.equal(r.mode, "checkout");
  assert.equal(r.repo, checkout);
  assert.ok(!existsSync(join(checkout, "widget")), "the source and the registry are the same directory here, and the removal takes it");
  assert.ok(existsSync(join(checkout, "other")), "and nothing else");
  assert.match(r.summary, /The directory is gone from .*checkout as well, because that checkout is the registry; git has it in the history\./);
  assert.deepEqual(held(bare), { other: "@dev/other@0.1.0" });
  assert.ok(!existsSync(join(fx.home, "publish", "reg")), "the checkout case clones nothing");
});

test("a removal pushes the branch too, so it meets the same gates about what else is on it", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "0.3.0"), beta: manifest("@dev/beta", "0.1.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@dev/widget", root: join(checkout, "widget") }] });

  // Another package, committed on this branch and not in the registry yet, whose version has moved.
  await makePackage(join(checkout, "beta"), manifest("@dev/beta", "0.2.0"));
  git(checkout, "add", "-A");
  git(checkout, ...AUTHOR, "commit", "-m", "beta 0.2.0");

  const err = await refusal(unpublish({ package: "@dev/widget", to: "reg" }, env));
  assert.equal(err.code, "unnamed-others");
  assert.match(err.message, /and a removal pushes the branch, so they would go with it: @dev\/beta 0\.2\.0 here, 0\.1\.0 in reg\./, "the sentence is about the act being refused, not about a publish");
  // Read in a browser toast, where there is deliberately no tick beside a removal, the first thing offered
  // has to be something the reader can actually do. The flag comes after, and says it is a terminal's.
  assert.match(err.message, /Taking a package out of a registry is not a reason to publish anybody's work, so nothing goes that was not asked for\. Move them off this branch first: git branch keep;/, "the procedure leads");
  assert.ok(err.message.indexOf("Move them off this branch first") < err.message.indexOf("--with"), "and the flag never comes before it");
  assert.match(err.message, /From a terminal they can also go deliberately, each as a publish of its own: thetis unpublish @dev\/widget --to reg --with @dev\/beta\./, "which still works, and is still said");
  assert.deepEqual(held(bare), { widget: "@dev/widget@0.3.0", beta: "@dev/beta@0.1.0" });

  // Named, it rides, and it is a publish in its own right alongside the removal.
  const r = await unpublish({ package: "@dev/widget", to: "reg", with: ["@dev/beta"] }, env);
  assert.deepEqual(held(bare), { beta: "@dev/beta@0.2.0" });
  assert.equal(r.with.length, 1);
  assert.equal(r.with[0].package, "@dev/beta");
  assert.equal(r.with[0].now, "0.2.0");
  assert.deepEqual(r.journals.map((j) => j.kind), ["package.unpublish", "package.publish"], "one row of each kind, because one act did both");
  assert.equal(r.records[1].alongside, "@dev/widget", "and the rider's record says what it went with");

  // And the smaller cousin: a file staged in the checkout that the removal's own commit would leave behind.
  await writeFile(join(checkout, "README.md"), "# meddled\n");
  git(checkout, "add", "README.md");
  const betaEnv = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@dev/beta", root: join(checkout, "beta") }] });
  const dirty = await refusal(unpublish({ package: "@dev/beta", to: "reg" }, betaEnv));
  assert.equal(dirty.code, "dirty-index");
  assert.match(dirty.message, /A removal commits only beta\/, so those would be left behind\./);
});
