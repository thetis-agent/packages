// The comparison the checkout case turns on. Getting it wrong in one direction costs a needless clone;
// getting it wrong in the other would commit inside a work tree that is not the registry at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoKey, sameRepository, slugOfUrl } from "../lib/git-url.js";

test("the three ways of writing one github repository are one repository", () => {
  const forms = ["git@github.com:thetis-agent/packages.git", "https://github.com/thetis-agent/packages.git", "https://github.com/thetis-agent/packages", "ssh://git@github.com/thetis-agent/packages.git", "https://github.com/thetis-agent/packages/", "git://github.com/thetis-agent/packages.git"];
  for (const a of forms) for (const b of forms) assert.ok(sameRepository(a, b), `${a} should be ${b}`);
  assert.equal(repoKey(forms[0]), "github.com/thetis-agent/packages");
});

test("a port, a user and a case difference in the host do not make a different repository", () => {
  assert.ok(sameRepository("ssh://git@GitHub.com:22/thetis-agent/packages.git", "https://github.com/Thetis-Agent/packages"));
  assert.ok(sameRepository("https://alice@git.example.com/t/p.git", "git@git.example.com:t/p"));
});

test("different repositories on the same host are different", () => {
  assert.ok(!sameRepository("git@github.com:thetis-agent/packages.git", "git@github.com:thetis-agent/runtime.git"));
  assert.ok(!sameRepository("git@github.com:other/packages.git", "https://github.com/thetis-agent/packages.git"));
});

test("a host is never the same repository as a local path with the same tail", () => {
  assert.ok(!sameRepository("git@github.com:thetis-agent/packages.git", "/srv/thetis-agent/packages.git"));
});

test("file urls and plain paths are the same local repository", () => {
  assert.ok(sameRepository("file:///srv/reg.git", "/srv/reg"));
  assert.ok(sameRepository("file://localhost/srv/reg.git", "/srv/reg.git"));
  assert.ok(sameRepository("/srv/./reg.git", "/srv/reg"));
  assert.ok(!sameRepository("/srv/reg.git", "/srv/other.git"));
});

test("an empty url matches nothing, itself included", () => {
  assert.ok(!sameRepository("", ""));
  assert.ok(!sameRepository(undefined, null));
});

test("a target with no name is named after its url", () => {
  assert.equal(slugOfUrl("git@github.com:thetis-agent/packages.git"), "packages");
  assert.equal(slugOfUrl("file:///srv/team-registry.git"), "team-registry");
});
