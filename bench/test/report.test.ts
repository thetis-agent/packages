import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWritable, buildReport, canonical, digestOf, isStale, renderMarkdown, viewFor, writeMarkdown,
  writePackageView, writeSuiteReport, type ReportInputs,
} from "../src/report.js";
import { comparable, participants, peerGroupOf, readParticipant, type Participant } from "../src/peers.js";
import { validateBench } from "../src/manifest.js";
import type { ArmScore } from "../src/score.js";
import { bootstrap, paired, seedOf } from "../src/metrics/stats.js";

const inputs = (over: Partial<ReportInputs> = {}): ReportInputs => ({
  probe: "A",
  suite: { id: "tools@1", version: "1.0.0", sha256: "sha256:aaa", tasks: 10, controls: 3 },
  arms: [
    { id: "none", packages: [] },
    { id: "self", packages: ["@a/x@1.0.0"] },
    { id: "peer", packages: ["@b/y@2.0.0"] },
  ],
  floor: "none",
  scorer: "@thetis/bench@0.1.0",
  seed: seedOf(["tools@1"]),
  model: null,
  sandbox: "bwrap",
  ...over,
});

const armScore = (arm: string, bytes: number): ArmScore => ({
  arm,
  tasks: 4,
  absolute: { bytes_tools: bootstrap([bytes, bytes, bytes, bytes], seedOf([arm])) },
  delta: arm === "none" ? {} : { bytes_tools: paired([bytes, bytes, bytes, bytes], [0, 0, 0, 0], seedOf([arm, "d"])) },
  perArm: arm === "peer" ? { ndcg: bootstrap([0.8, 0.9, 0.7, 0.85], seedOf([arm, "n"])) } : {},
  conformance: { adapterLies: [], adapterModest: [], offeredUnverified: [], errors: [] },
});

const scores = [armScore("none", 0), armScore("self", 500), armScore("peer", 900)];
const report = () => buildReport(scores, inputs(), { none: 1, self: 1.2, peer: 1.4 });

const withTmp = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "bench-report-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("canonical form sorts keys, so the same inputs hash the same however they were built", () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(canonical({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}');
  assert.equal(canonical({ a: 1, skip: undefined }), '{"a":1}');
});

test("the digest moves when an input that matters moves, and not otherwise", () => {
  const base = digestOf(inputs());
  assert.equal(base, digestOf(inputs()));
  assert.notEqual(base, digestOf(inputs({ sandbox: "none" })));
  assert.notEqual(base, digestOf(inputs({ suite: { ...inputs().suite, sha256: "sha256:bbb" } })));
  assert.notEqual(
    base,
    digestOf(inputs({ arms: [{ id: "none", packages: [] }, { id: "self", packages: ["@a/x@1.0.0"] }, { id: "peer", packages: ["@b/y@2.1.0"] }] })),
    "a peer publishing a new version invalidates the comparison it appears in",
  );
});

test("the digest is over inputs only, so writing the report cannot change its own digest", () => {
  const one = report();
  const two = buildReport(scores, inputs(), { none: 1, self: 9.9, peer: 0.1 }, ["a note"]);
  assert.equal(one.digest, two.digest, "results and notes are outputs, not identity");
});

test("writing through a package store link is refused, because the store is symbolic", () => {
  assert.throws(() => assertWritable("/data/userspaces/alice/store/node_modules/@a/x/BENCH.md"), /refusing to write through a package store/);
  assert.doesNotThrow(() => assertWritable("/repo/packages/tools-files/BENCH.md"));
  assert.doesNotThrow(() => assertWritable("/repo/store/other/BENCH.md"));
});

test("a report with unchanged inputs is not rewritten, and --force rewrites it", () => {
  withTmp((dir) => {
    const r = report();
    assert.equal(writeSuiteReport(dir, r).written, true);
    assert.deepEqual(writeSuiteReport(dir, r).reason, "unchanged");
    assert.equal(writeSuiteReport(dir, r, true).written, true);
    const changed = buildReport(scores, inputs({ sandbox: "none" }), {});
    assert.equal(writeSuiteReport(dir, changed).written, true, "different inputs are meaningful new data");
  });
});

test("an unreadable report on disk is replaced rather than trusted", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "report.json"), "not json at all");
    assert.equal(writeSuiteReport(dir, report()).written, true);
  });
});

test("a package's view keeps the floor, itself and its peers, and drops the rest", () => {
  const view = viewFor(report(), "@a/x", "self", "skills", ["peer"]);
  assert.deepEqual(view.arms, ["none", "self", "peer"]);
  assert.equal(view.suiteDigest, report().digest);
  const narrow = viewFor(report(), "@a/x", "self", "skills", []);
  assert.deepEqual(narrow.arms, ["none", "self"], "with no peers a package is shown against the floor alone");
  assert.equal(narrow.report.shared.peer, undefined);
});

test("a view is stale exactly when the suite it came from has moved on", () => {
  const first = report();
  const view = viewFor(first, "@a/x", "self", "skills", ["peer"]);
  assert.equal(isStale(view, first), false);
  assert.equal(isStale(view, buildReport(scores, inputs({ sandbox: "none" }), {})), true);
});

test("the rendered page separates what may be compared from what may not", () => {
  const md = renderMarkdown([viewFor(report(), "@a/x", "self", "skills", ["peer"])]);
  assert.match(md, /# Bench · @a\/x/);
  assert.match(md, /### Compared/);
  assert.match(md, /### Per arm, not compared/);
  assert.match(md, /\*\*peer\*\* — ndcg/, "a ranking score is printed under the arm that produced it");
  const compared = md.slice(md.indexOf("### Compared"), md.indexOf("### Against the floor"));
  assert.ok(!compared.includes("ndcg"), "and never as a column beside arms that cannot produce it");
});

test("the page states which inputs make two reports comparable", () => {
  const md = renderMarkdown([viewFor(report(), "@a/x", "self", "skills", ["peer"])]);
  assert.match(md, /### Inputs/);
  assert.match(md, /tools@1/);
  assert.match(md, /none — this probe needs no model/);
});

test("the page is written once and then left alone, despite carrying a timestamp", () => {
  withTmp((dir) => {
    mkdirSync(join(dir, "pkg"), { recursive: true });
    const view = viewFor(report(), "@a/x", "self", "skills", ["peer"]);
    assert.equal(writeMarkdown(join(dir, "pkg"), [view]).written, true);
    assert.equal(writeMarkdown(join(dir, "pkg"), [{ ...view, generatedAt: "later" }]).written, false, "only the clock moved");
    assert.equal(writePackageView(join(dir, "pkg"), view).written, true);
    assert.equal(writePackageView(join(dir, "pkg"), view).written, false);
    assert.match(readFileSync(join(dir, "pkg", "BENCH.md"), "utf8"), /# Bench · @a\/x/);
  });
});

test("a package that opts into no suite is not a participant", () => {
  withTmp((dir) => {
    const write = (name: string, thetis: unknown) => {
      const at = join(dir, name.replace("/", "-").replace("@", ""));
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, "package.json"), JSON.stringify({ name, version: "1.0.0", thetis }));
      return at;
    };
    write("@a/plain", { type: "tool" });
    write("@a/opted", { type: "tool", bench: { suites: ["tools@1"] } });
    write("@a/other", { type: "tool", bench: { suites: ["skills@1"] } });
    const found = participants([dir], "tools@1");
    assert.deepEqual(found.map((p) => p.name), ["@a/opted"]);
    assert.equal(readParticipant(join(dir, "nothing-here")), null);
  });
});

test("the peer group defaults to the first suite a package runs", () => {
  assert.equal(peerGroupOf({ suites: ["skills@1", "tools@1"] }), "skills@1");
  assert.equal(peerGroupOf({ suites: ["skills@1"], peerGroup: "retrieval" }), "retrieval");
});

const participant = (name: string, bench: Participant["bench"]): Participant => ({
  name,
  version: "1.0.0",
  dir: `/nowhere/${name}`,
  bench,
  thetis: { type: "loader", bench },
  peerGroup: peerGroupOf(bench),
});

test("a peer on a different corpus is omitted with its reason, never quietly included", () => {
  const self = participant("@a/x", { suites: ["skills@1"], corpus: "caps@1", peerGroup: "skills" });
  const same = participant("@b/y", { suites: ["skills@1"], corpus: "caps@1", peerGroup: "skills" });
  const otherCorpus = participant("@c/z", { suites: ["skills@1"], corpus: "caps@2", peerGroup: "skills" });
  const otherGroup = participant("@d/w", { suites: ["skills@1"], corpus: "caps@1", peerGroup: "tools" });
  const check = comparable(self, [self, same, otherCorpus, otherGroup], "skills@1", "caps@1");
  assert.deepEqual(check.peers, ["@b/y"]);
  assert.deepEqual(check.omitted, [{ name: "@c/z", reason: "imports caps@2, not caps@1" }]);
});

test("a bench declaration must name an adapter that is actually callable", () => {
  assert.deepEqual(validateBench("@a/x", { type: "loader", bench: { suites: ["skills@1"] } }), []);
  const problems = validateBench("@a/x", {
    type: "loader",
    steps: [{ id: "report", phase: "prompt", export: "benchReport" }],
    bench: { suites: ["skills@1"], adapter: "benchReport" },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /not declared in thetis.steps with phase "bench"/);
});

test("a declaration is accepted once the adapter is a bench step", () => {
  assert.deepEqual(
    validateBench("@a/x", {
      type: "loader",
      steps: [{ id: "report", phase: "bench", export: "benchReport" }],
      bench: { suites: ["skills@1"], adapter: "benchReport" },
    }),
    [],
  );
});

test("common mistakes in a declaration are each named", () => {
  assert.match(validateBench("@a/x", { type: "loader", bench: { suites: [] } })[0] as string, /at least one suite/);
  assert.match(validateBench("@a/x", { type: "loader", bench: { suites: ["skills"] } })[0] as string, /named id@version/);
  assert.match(validateBench("@a/x", { type: "loader", bench: { suites: ["s@1"], corpus: "caps@1" } })[0] as string, /must name its importer/);
  assert.match(validateBench("@a/x", { type: "loader", bench: { suites: ["s@1"], arms: ["a", "a"] } })[0] as string, /repeats a name/);
});

test("a bench step with no suite opted into is a mistake worth naming", () => {
  const problems = validateBench("@a/x", { type: "loader", steps: [{ id: "r", phase: "bench", export: "r" }], bench: { suites: [] } });
  assert.ok(problems.some((p) => /opts into no suite/.test(p)));
});
