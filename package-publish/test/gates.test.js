// Every refusal, and the sentence it makes. The sentences are checked as well as the codes because a
// refusal here is read on its own -- in a transcript, on a terminal, in a toast -- and one that does not
// name what to do next leaves a person exactly where a silent failure would have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publish } from "../lib/publish.js";
import { AUTHOR, git, makeCheckout, makeEnv, makePackage, makeRegistry, manifest, refusal, seedRegistry, show, temp, versionIn } from "./helpers.js";

const oneTarget = (bare) => ({ targets: [{ name: "reg", url: `file://${bare}`, branch: "main" }] });

/** A fixture with an empty registry and one sound userspace package at packages/hello. */
async function fixture(t, config) {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  const src = await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  return { ...fx, bare, src, env: makeEnv(fx.home, { config: config ?? oneTarget(bare) }) };
}

test("no target configured, and a target that is not configured", async (t) => {
  const fx = await fixture(t, { targets: [] });
  const none = await refusal(publish({ package: "packages/hello" }, fx.env));
  assert.equal(none.code, "no-targets");
  assert.match(none.message, /nowhere to publish/);
  assert.match(none.message, /Somebody has to add one first: thetis config set @thetis\/package-publish targets/, "it says how to add one");

  const two = makeEnv(fx.home, { config: { targets: [{ name: "a", url: `file://${fx.bare}` }, { name: "b", url: "file:///nowhere.git" }] } });
  const wrong = await refusal(publish({ package: "packages/hello", to: "c" }, two));
  assert.equal(wrong.code, "unknown-target");
  assert.match(wrong.message, /no publish target called c\. The configured targets are a, b\./);

  const which = await refusal(publish({ package: "packages/hello" }, two));
  assert.equal(which.code, "ambiguous-target");
  assert.match(which.message, /More than one publish target is configured \(a, b\)\. Say which of them to publish to\./, "no argument shapes in a sentence a person reads in a toast");
});

test("a package that is neither installed here nor a directory", async (t) => {
  const fx = await fixture(t);
  const missing = await refusal(publish({ package: "packages/nope" }, fx.env));
  assert.equal(missing.code, "not-found");
  assert.match(missing.message, /neither a package installed here nor a directory I can reach/);

  const nothing = await refusal(publish({}, fx.env));
  assert.equal(nothing.code, "no-package");
  assert.match(nothing.message, /publish needs a package/);
});

test("the manifest has to be sound before anything is cloned", async (t) => {
  const fx = await fixture(t);
  const dir = join(fx.home, "packages", "broken");
  const cases = [
    [manifest(undefined, "0.1.0"), /has no name/],
    [manifest("@alice/broken", undefined), /has no version/],
    [manifest("@alice/broken", "latest"), /is not a semantic version like 1\.2\.0/],
    [{ name: "@alice/broken", version: "0.1.0", main: "index.js" }, /has no thetis field/],
  ];
  for (const [m, sentence] of cases) {
    await rm(dir, { recursive: true, force: true });
    await makePackage(dir, m);
    const err = await refusal(publish({ package: "packages/broken" }, fx.env));
    assert.equal(err.code, "manifest", err.message);
    assert.match(err.message, sentence);
  }
  assert.ok(!existsSync(join(fx.home, "publish")), "not one of those refusals needed the registry to be cloned");

  await rm(dir, { recursive: true, force: true });
  await makePackage(dir, manifest("@alice/broken", "0.1.0"));
  await rm(join(dir, "index.js"));
  const gone = await refusal(publish({ package: "packages/broken" }, fx.env));
  assert.equal(gone.code, "manifest");
  assert.match(gone.message, /names main index\.js, which is not in /);
});

test("version and bump: one or the other, and both have to make sense", async (t) => {
  const fx = await fixture(t);
  const both = await refusal(publish({ package: "packages/hello", version: "1.0.0", bump: "patch" }, fx.env));
  assert.equal(both.code, "bad-version");
  assert.match(both.message, /Say which version to publish, or ask for a patch, minor or major step from 0\.1\.0, but not both at once\./);

  const bad = await refusal(publish({ package: "packages/hello", version: "v1" }, fx.env));
  assert.equal(bad.code, "bad-version");
  assert.match(bad.message, /v1 is not a semantic version/);

  const sideways = await refusal(publish({ package: "packages/hello", bump: "sideways" }, fx.env));
  assert.equal(sideways.code, "bad-version");
  assert.match(sideways.message, /A step is patch, minor or major, not sideways\./);
});

test("verify runs in the package's directory and a non-zero exit refuses the publish", async (t) => {
  const fx = await fixture(t);
  const failing = makeEnv(fx.home, { config: { ...oneTarget(fx.bare), verify: "echo 'two of the tests failed' >&2; exit 3" } });
  const err = await refusal(publish({ package: "packages/hello" }, failing));
  assert.equal(err.code, "verify-failed");
  assert.match(err.message, /verify refused @alice\/hello/);
  assert.match(err.message, /exited 3/);
  assert.match(err.message, /two of the tests failed/, "git and the command both get to say what went wrong");
  assert.equal(versionIn(fx.bare, "main", "hello"), null, "nothing was published");

  // The command runs where the package is, not where the fence started.
  const passing = makeEnv(fx.home, { config: { ...oneTarget(fx.bare), verify: "test -f index.js" } });
  const ok = await publish({ package: "packages/hello" }, passing);
  assert.equal(ok.verify.command, "test -f index.js");
  assert.equal(ok.pushed, true);
});

test("a directory in the registry that holds another package is not overwritten", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@thetis/hello", "0.4.0") });
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  const env = makeEnv(fx.home, { config: oneTarget(bare) });

  const err = await refusal(publish({ package: "packages/hello" }, env));
  assert.equal(err.code, "name-mismatch");
  assert.match(err.message, /reg already holds @thetis\/hello in hello\/, so publishing @alice\/hello there would replace it/);
  assert.equal(versionIn(bare, "main", "hello"), "0.4.0");
});

test("a package that is the root of the registry repository has no single directory to commit", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "one");
  const work = join(fx.root, "one-package");
  git(fx.root, "clone", bare, "one-package");
  await makePackage(work, manifest("@alice/one", "0.1.0"));
  git(work, "add", "-A");
  git(work, ...AUTHOR, "commit", "-m", "the package is the repository");
  git(work, "push", "origin", "HEAD:refs/heads/main");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "one", url: bare, branch: "main" }] } });

  const err = await refusal(publish({ package: work }, env));
  assert.equal(err.code, "package-is-repo-root");
  assert.match(err.message, /A registry holds each package in a directory of its own/);
});

test("a registry that cannot be reached is a refusal that says so", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.1.0"));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${join(fx.root, "not-a-repo.git")}` }] } });
  const err = await refusal(publish({ package: "packages/hello" }, env));
  assert.equal(err.code, "git");
  assert.match(err.message, /could not clone reg from /);
});

test("a work directory somebody else's clone is sitting in is replaced, not published into", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const right = await makeRegistry(fx.root, "right");
  const wrong = await makeRegistry(fx.root, "wrong");
  await seedRegistry(fx.root, right, { hello: manifest("@alice/hello", "0.1.0") });
  await seedRegistry(fx.root, wrong, {});
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "0.2.0"));
  // The clone under the work directory points at the wrong registry, as it would after the target's url
  // was changed. Publishing must not commit into it.
  git(fx.home, "clone", wrong, "publish/reg");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${right}` }] } });

  const r = await publish({ package: "packages/hello" }, env);
  assert.equal(r.was, "0.1.0");
  assert.equal(versionIn(right, "main", "hello"), "0.2.0");
  assert.equal(versionIn(wrong, "main", "hello"), null, "the registry that was in the way got nothing");
});

// ---- the sibling package, in each of the three states it can be in ----
//
// Scoping the commit to one directory does not scope the push: `git push` sends the branch, and a branch
// that already carries a commit to another package carries it to the registry. The maintainer's habit is
// to commit as they go across several packages and then ship one, so the committed state is their normal
// state and the one that was quietly leaking. All three are here together so the next person can see at a
// glance which are covered.
const UNTOUCHED = "export const ok = true;\n";

async function siblings(t, state, { bumpBeta = false } = {}) {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { alpha: manifest("@thetis/alpha", "0.1.0"), beta: manifest("@thetis/beta", "0.1.0") });
  const checkout = await makeCheckout(fx.root, bare, "checkout");
  await writeFile(join(checkout, "alpha", "index.js"), "export const ok = 2;\n");
  await writeFile(join(checkout, "beta", "index.js"), "export const meddled = true;\n");
  if (bumpBeta) await writeFile(join(checkout, "beta", "package.json"), `${JSON.stringify(manifest("@thetis/beta", "0.2.0"), null, 2)}\n`);
  if (state !== "unstaged") git(checkout, "add", "beta");
  if (state === "committed") git(checkout, ...AUTHOR, "commit", "-m", "beta, in passing");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: bare }] }, packages: [{ name: "@thetis/alpha", root: join(checkout, "alpha") }] });
  return { ...fx, bare, checkout, env };
}

const publishAlpha = (fx, args = {}) => publish({ package: "@thetis/alpha", bump: "patch", ...args }, fx.env);

test("a sibling package's work reaches the registry in none of the three states it can be in", async (t) => {
  // Unstaged: it is not in the commit and not in any commit, so it stays where it is and alpha goes.
  const loose = await siblings(t, "unstaged");
  const went = await publishAlpha(loose);
  assert.equal(went.pushed, true);
  assert.deepEqual(went.others, [], "nothing is riding along");
  assert.deepEqual(went.with, []);
  assert.equal(versionIn(loose.bare, "main", "alpha"), "0.1.1");
  assert.equal(show(loose.bare, "main", "beta/index.js"), UNTOUCHED, "beta stayed put");

  // Staged: named and refused, and neither package moves.
  const staged = await siblings(t, "staged");
  const one = await refusal(publishAlpha(staged));
  assert.equal(one.code, "dirty-index");
  assert.match(one.message, /beta\/index\.js/);
  assert.equal(versionIn(staged.bare, "main", "alpha"), "0.1.0");
  assert.equal(show(staged.bare, "main", "beta/index.js"), UNTOUCHED);

  // Committed: the commit is scoped exactly as designed and the push is not, which is the hole. beta's
  // version has not moved, so it cannot be published at all and no amount of consent makes it safe.
  const done = await siblings(t, "committed");
  const two = await refusal(publishAlpha(done));
  assert.equal(two.code, "unpushed-others");
  assert.match(two.message, /a publish pushes the branch, so they would go with it/);
  assert.match(two.message, /These cannot be published, and saying you want them anyway will not change that/);
  assert.match(two.message, /@thetis\/beta is 0\.1\.0 here and in reg, so its code would land under a version every installation already believes it has/);
  assert.match(two.message, /git branch keep; git reset --hard origin\/main; git checkout keep -- alpha/);
  assert.deepEqual(two.details.blocked.map((o) => [o.package, o.reason]), [["@thetis/beta", "not-newer"]]);
  assert.equal(show(done.bare, "main", "beta/index.js"), UNTOUCHED, "the hole this closes");
  assert.equal(versionIn(done.bare, "main", "alpha"), "0.1.0", "and alpha did not go either");
});

test("a publishable sibling waits to be named, and then rides as a publish of its own", async (t) => {
  const fx = await siblings(t, "committed", { bumpBeta: true });
  // A version having moved is not consent: a person bumps to try something as readily as to ship it.
  const err = await refusal(publishAlpha(fx));
  assert.equal(err.code, "unnamed-others");
  assert.match(err.message, /@thetis\/beta 0\.2\.0 here, 0\.1\.0 in reg/);
  assert.match(err.message, /a version having moved is not the same as meaning to ship it, so nothing goes that you did not ask for/);
  assert.match(err.message, /thetis publish alpha --with @thetis\/beta/, "the refusal names its own way out");
  assert.deepEqual(err.details.nameable.map((o) => o.package), ["@thetis/beta"]);
  assert.equal(versionIn(fx.bare, "main", "beta"), "0.1.0", "nothing went");

  const r = await publishAlpha(fx, { with: ["@thetis/beta"] });
  assert.equal(r.pushed, true);
  assert.equal(versionIn(fx.bare, "main", "alpha"), "0.1.1");
  assert.equal(versionIn(fx.bare, "main", "beta"), "0.2.0", "the one that was named went too");
  // It is a result, not a name: everything a card shows for a package that was published.
  assert.deepEqual(r.with.map((x) => [x.package, x.directory, x.was, x.now, x.first, x.commit, x.source]), [["@thetis/beta", "beta", "0.1.0", "0.2.0", false, r.commit, `${r.url}#beta@${r.commit}`]]);
  assert.deepEqual(r.with[0].files.sort(), ["beta/index.js", "beta/package.json"]);
  assert.equal(r.journals.length, 2, "one journal row per package published");
  assert.deepEqual(r.journals.map((j) => [j.target, j.data.was, j.data.version]), [["@thetis/alpha", "0.1.0", "0.1.1"], ["@thetis/beta", "0.1.0", "0.2.0"]]);
  assert.equal(r.records.length, 2);
  assert.equal(r.records[1].alongside, "@thetis/alpha", "the record says it rode rather than that it was shipped");
  assert.match(r.summary, /Along with it: @thetis\/beta 0\.1\.0 to 0\.2\.0\./);
});

test("a sibling that cannot be published can never be named", async (t) => {
  const fx = await siblings(t, "committed");
  const err = await refusal(publishAlpha(fx, { with: ["@thetis/beta"] }));
  assert.equal(err.code, "unpushed-others");
  assert.match(err.message, /@thetis\/beta cannot be published: @thetis\/beta is 0\.1\.0 here and in reg/);
  assert.match(err.message, /Naming it alongside alpha\/ changes nothing about that/);
  assert.equal(versionIn(fx.bare, "main", "alpha"), "0.1.0");
});

test("naming something that is not riding is a refusal, not a silent no-op", async (t) => {
  const fx = await siblings(t, "committed", { bumpBeta: true });
  const err = await refusal(publishAlpha(fx, { with: ["@thetis/delta"] }));
  assert.equal(err.code, "not-a-passenger");
  assert.match(err.message, /@thetis\/delta is not riding on this branch: nothing outside alpha\/ is committed for it/);
  assert.match(err.message, /What is riding is @thetis\/beta\./);

  const clean = await siblings(t, "unstaged");
  const none = await refusal(publishAlpha(clean, { with: ["@thetis/beta"] }));
  assert.equal(none.code, "not-a-passenger");
  assert.match(none.message, /Nothing else is riding on this branch\./);
});

test("a rider is verified like any other publish, because that is what it is", async (t) => {
  const fx = await siblings(t, "committed", { bumpBeta: true });
  // The check passes where alpha is and fails where beta is, so only the rider's verify can refuse this.
  const env = makeEnv(fx.home, {
    config: { targets: [{ name: "reg", url: fx.bare }], verify: "test ! -f no-ship.txt" },
    packages: [{ name: "@thetis/alpha", root: join(fx.checkout, "alpha") }],
  });
  await writeFile(join(fx.checkout, "beta", "no-ship.txt"), "not ready\n");
  const err = await refusal(publish({ package: "@thetis/alpha", bump: "patch", with: ["@thetis/beta"] }, env));
  assert.equal(err.code, "verify-failed");
  assert.match(err.message, /verify refused @thetis\/beta/, "publishing code nobody checked is what verify exists to prevent");
  assert.equal(versionIn(fx.bare, "main", "alpha"), "0.1.0", "and the primary did not go either");
});

test("a dry run names the passengers instead of refusing, because it changes nothing", async (t) => {
  const fx = await siblings(t, "committed");
  const r = await publishAlpha(fx, { dryRun: true });
  assert.equal(r.ok, false, "a dry run that would be refused says so in a field rather than by throwing");
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.blockers.map((b) => b.code), ["unpushed-others"]);
  assert.match(r.blockers[0].message, /@thetis\/beta/);
  assert.equal(r.others.length, 1);
  assert.deepEqual(r.nameable, [], "beta cannot be published, so it is not on offer");
  assert.deepEqual(r.files, ["alpha/index.js", "alpha/package.json"], "and still says what this publish itself would send");
  assert.match(r.summary, /would be refused \(unpushed-others\)/);
  assert.equal(versionIn(fx.bare, "main", "alpha"), "0.1.0");

  const staged = await siblings(t, "staged");
  const both = await publishAlpha(staged, { dryRun: true });
  assert.deepEqual(both.blockers.map((b) => b.code), ["dirty-index"], "the other tree gate reports on a dry run too");

  const clean = await siblings(t, "unstaged");
  const fine = await publishAlpha(clean, { dryRun: true });
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.blockers, []);

  // "What would this publish, and what could I add?" is the question a dry run is for.
  const offered = await siblings(t, "committed", { bumpBeta: true });
  const asked = await publishAlpha(offered, { dryRun: true });
  assert.deepEqual(asked.blockers.map((b) => b.code), ["unnamed-others"]);
  assert.deepEqual(asked.nameable, ["@thetis/beta"]);
  const taken = await publishAlpha(offered, { dryRun: true, with: ["@thetis/beta"] });
  assert.equal(taken.ok, true);
  assert.deepEqual(taken.with.map((x) => [x.package, x.was, x.now]), [["@thetis/beta", "0.1.0", "0.2.0"]]);
  assert.equal(versionIn(offered.bare, "main", "beta"), "0.1.0", "and still nothing went");
});

test("the copy case carries no passengers: a local commit in the clone is reset away, not pushed", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { alpha: manifest("@thetis/alpha", "0.1.0"), beta: manifest("@thetis/beta", "0.1.0") });
  await makePackage(join(fx.home, "packages", "alpha"), manifest("@thetis/alpha", "0.2.0"));
  // A commit to another package, made in the work directory's clone and never pushed: the same shape as
  // the checkout hole, planted on the path that is supposed to be immune to it.
  const clone = join(fx.home, "publish", "reg");
  git(fx.home, "clone", bare, "publish/reg");
  await writeFile(join(clone, "beta", "index.js"), "export const meddled = true;\n");
  git(clone, "add", "-A");
  git(clone, ...AUTHOR, "commit", "-m", "beta, in the clone");
  const env = makeEnv(fx.home, { config: { targets: [{ name: "reg", url: `file://${bare}` }] } });

  const r = await publish({ package: "packages/alpha" }, env);
  assert.equal(r.mode, "copy");
  assert.deepEqual(r.others, [], "the clone is reset onto the registry, so there is no local history to carry");
  assert.deepEqual(r.files, ["alpha/package.json"]);
  assert.equal(versionIn(bare, "main", "alpha"), "0.2.0");
  assert.equal(show(bare, "main", "beta/index.js"), UNTOUCHED, "and the planted commit went nowhere");
});

test("a registry holding a version this package would not write still lets a publish past it", async (t) => {
  // The live edge of the two version comparisons disagreeing. `1.2` is not a version `isVersion` accepts,
  // but it is not this package's to reject either: it came out of somebody else's manifest in the registry.
  // When the comparison answered null for it, `null <= 0` read as "not newer" and every publish of that
  // package was refused, with a sentence that was wrong about the reason and nothing a person could do.
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "reg");
  await seedRegistry(fx.root, bare, { hello: manifest("@alice/hello", "1.2"), same: manifest("@alice/same", "1.2") });
  await makePackage(join(fx.home, "packages", "hello"), manifest("@alice/hello", "1.2.1"));
  const env = makeEnv(fx.home, { config: oneTarget(bare) });

  const r = await publish({ package: "packages/hello" }, env);
  assert.equal(r.was, "1.2");
  assert.equal(r.now, "1.2.1");
  assert.equal(r.pushed, true);
  assert.equal(versionIn(bare, "main", "hello"), "1.2.1");

  // And the other side of it: a version that does not move past `1.2` is still refused, and the sentence
  // says what is in the way rather than naming a next version it would have had to invent. The package
  // being published is a sound one, because what this package writes is still held to `isVersion`; it is
  // only what it reads out of the registry that is ordered rather than rejected.
  await makePackage(join(fx.home, "packages", "same"), manifest("@alice/same", "1.1.0"));
  const err = await refusal(publish({ package: "packages/same" }, env));
  assert.equal(err.code, "not-newer");
  assert.match(err.message, /@alice\/same 1\.1\.0 does not move past 1\.2, which reg already holds/);
  assert.match(err.message, /1\.2 is not a semantic version like 1\.2\.0, so there is no next one to name: pick a version above it, and put a sound one in reg's own copy of the manifest while you are there\./);
});
