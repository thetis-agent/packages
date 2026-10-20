// Findings: written from a reflection, same-as appends a sighting, possibly-fixed on a newer install,
// reopened by a later sighting, closed by a person, and reopened past the version it was closed at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeFinding, compareVersions, listFindings, readFindings, recordFindings, sweepFindings } from "../lib/library.js";
import { get, tempHome } from "./helpers.js";

const F = (o = {}) => ({ package: "@thetis/tools-files", component: "read_file", what: "Cut the file.", version: "0.4.0", events: [3], rows: [1], sameAs: null, ...o });

test("versions compare by their numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.4.0", "0.4.1"), -1);
});

test("a new finding, then same-as appends a sighting instead of a second finding", async () => {
  const { home, done } = await tempHome();
  try {
    const [id] = await recordFindings(home, [F()], { session: "s_a1", title: "One" });
    assert.match(id, /^F-[0-9a-f]{6}$/);
    let f = (await get(home, "reflections/findings.json")).findings[0];
    assert.deepEqual([f.package, f.component, f.what, f.state, f.since, f.closedAt], ["@thetis/tools-files", "read_file", "Cut the file.", "open", null, null]);
    assert.deepEqual(f.seen.map((s) => [s.session, s.title, s.version, s.events, s.rows]), [["s_a1", "One", "0.4.0", [3], [1]]]);
    const [again] = await recordFindings(home, [F({ sameAs: id, version: "0.4.0" })], { session: "s_b2", title: "Two" });
    assert.equal(again, id);
    f = (await readFindings(home)).findings;
    assert.equal(f.length, 1);
    assert.deepEqual(f[0].seen.map((s) => s.session), ["s_a1", "s_b2"]);
  } finally {
    await done();
  }
});

test("a newer install makes an open finding possibly-fixed; a later sighting reopens it", async () => {
  const { home, done } = await tempHome();
  try {
    const [id] = await recordFindings(home, [F()], { session: "s_a1", title: "One" });
    assert.equal(await sweepFindings(home, { "@thetis/tools-files": "0.4.0" }), 0, "the same version fixes nothing");
    assert.equal(await sweepFindings(home, { "@thetis/tools-files": "0.3.0" }), 0, "an older one neither");
    assert.equal(await sweepFindings(home, {}), 0, "nor an uninstalled package");
    assert.equal(await sweepFindings(home, { "@thetis/tools-files": "0.5.0" }), 1);
    let f = (await readFindings(home)).findings[0];
    assert.deepEqual([f.state, f.since], ["possibly-fixed", "0.5.0"]);
    assert.equal(await sweepFindings(home, { "@thetis/tools-files": "0.6.0" }), 0, "only open findings move");
    await recordFindings(home, [F({ sameAs: id, version: "0.5.0" })], { session: "s_b2", title: "Two" });
    f = (await readFindings(home)).findings[0];
    assert.deepEqual([f.state, f.since], ["open", null]);
  } finally {
    await done();
  }
});

test("close; a sighting at the same version stays closed, a newer one reopens", async () => {
  const { home, done } = await tempHome();
  try {
    const [id] = await recordFindings(home, [F()], { session: "s_a1", title: "One" });
    const closed = await closeFinding(home, id);
    assert.equal(closed.state, "closed");
    assert.ok(closed.closedAt);
    await assert.rejects(closeFinding(home, id), /^Error: It is already closed\.$/);
    await assert.rejects(closeFinding(home, "F-000000"), /^Error: There is no finding F-000000\.$/);
    await assert.rejects(closeFinding(home, "x"), /is required/);
    await recordFindings(home, [F({ sameAs: id, version: "0.4.0" })], { session: "s_b2", title: "Two" });
    assert.equal((await readFindings(home)).findings[0].state, "closed");
    await recordFindings(home, [F({ sameAs: id, version: "0.5.0" })], { session: "s_c3", title: "Three" });
    const f = (await readFindings(home)).findings[0];
    assert.deepEqual([f.state, f.closedAt], ["open", null]);
    assert.equal(f.seen.length, 3);
  } finally {
    await done();
  }
});

test("a conversation reflected again replaces its own sightings; a finding left with none goes", async () => {
  const { home, done } = await tempHome();
  try {
    const [a] = await recordFindings(home, [F()], { session: "s_a1", title: "One" });
    const [b] = await recordFindings(home, [F({ component: "write_file" })], { session: "s_b2", title: "Two" });
    await recordFindings(home, [F({ sameAs: b })], { session: "s_a1", title: "One" });
    const list = await listFindings(home);
    assert.deepEqual(list.map((f) => f.id), [b], `${a} had only s_a1's sighting, and the new reflection did not repeat it`);
    assert.deepEqual(list[0].seen.map((s) => s.session), ["s_b2", "s_a1"]);
  } finally {
    await done();
  }
});

test("listFindings groups by package, the most recently seen first", async () => {
  const { home, done } = await tempHome();
  try {
    await recordFindings(home, [F({ package: "@thetis/zz" })], { session: "s_a1" });
    await recordFindings(home, [F({ package: "@thetis/aa", what: "older" })], { session: "s_b2" });
    await new Promise((r) => setTimeout(r, 5));
    await recordFindings(home, [F({ package: "@thetis/aa", what: "newer" })], { session: "s_c3" });
    assert.deepEqual((await listFindings(home)).map((f) => `${f.package} ${f.what}`), ["@thetis/aa newer", "@thetis/aa older", "@thetis/zz Cut the file."]);
  } finally {
    await done();
  }
});
