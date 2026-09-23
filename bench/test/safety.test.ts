// The whole opt-in safety story is one property: a step declared against the `bench` phase cannot run unless
// a configuration lists that phase, and no production configuration does. This test is that property.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Enumerator, defaultConfig, type KernelConfig } from "@thetis/runtime/kernel";
import type { PackageInfo } from "@thetis/runtime/contracts";

const PROJECT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const BENCH_PHASE = "bench";

const pkg = (name: string, steps: { id: string; phase: string; export: string }[]): PackageInfo =>
  ({ name, version: "0.1.0", type: "loader", root: "/nowhere", thetis: { type: "loader", steps } }) as PackageInfo;

const enumeratorFor = (config: KernelConfig) => new Enumerator(config, { request: async () => [] } as never);

const candidate = pkg("@alice/skills", [
  { id: "inject", phase: "prompt", export: "injectSkills" },
  { id: "bench-import", phase: BENCH_PHASE, export: "importCorpus" },
  { id: "bench-report", phase: BENCH_PHASE, export: "benchReport" },
]);

test("the default phases do not include the bench phase", () => {
  assert.ok(!defaultConfig("/tmp/home", PROJECT).phases.includes(BENCH_PHASE));
});

test("a bench step is never scheduled under a production configuration", () => {
  const plan = enumeratorFor(defaultConfig("/tmp/home", PROJECT)).defaultPlan([candidate]);
  assert.deepEqual(plan.map((s) => s.export), ["injectSkills"], "the package's ordinary step runs and both of its bench steps are absent");
  assert.equal(plan.filter((s) => s.phase === BENCH_PHASE).length, 0);
});

test("the same package under a bench configuration schedules both bench steps, before the call", () => {
  const config = defaultConfig("/tmp/home", PROJECT);
  config.phases = ["history", "prompt", "tools", BENCH_PHASE, "call", "execute", "after"];
  // The harness's call step is the one that sends the request; it lives in `execute`, after the bench phase.
  const caller = { ...candidate, name: "@thetis/harness-core", thetis: { type: "loader", steps: [{ id: "call", phase: "execute", export: "callModel" }] } } as typeof candidate;
  const plan = enumeratorFor(config).defaultPlan([candidate, caller]);
  const exports = plan.map((s) => s.export);
  assert.deepEqual(exports, ["injectSkills", "importCorpus", "benchReport", "callModel"]);
  assert.ok(exports.indexOf("benchReport") < exports.indexOf("callModel"), "the adapter must report before the call it is reporting on");
});

test("bench steps keep their declared order, so a probe installed last collects last", () => {
  const config = defaultConfig("/tmp/home", PROJECT);
  config.phases = ["prompt", BENCH_PHASE, "call"];
  const probe = pkg("@thetis/bench-probe", [{ id: "collect", phase: BENCH_PHASE, export: "collect" }]);
  const plan = enumeratorFor(config).defaultPlan([candidate, probe]);
  const benchSteps = plan.filter((s) => s.phase === BENCH_PHASE).map((s) => s.export);
  assert.deepEqual(benchSteps, ["importCorpus", "benchReport", "collect"]);
});

test("the shipped bench-probe declares its only step against the bench phase", () => {
  const manifest = JSON.parse(readFileSync(resolve(PROJECT, "packages/bench-probe/package.json"), "utf8"));
  assert.deepEqual(manifest.thetis.steps, [{ id: "collect", phase: BENCH_PHASE, export: "collect" }]);
  assert.equal(manifest.thetis.tools, undefined, "the probe offers the model nothing");
});

test("the measuring provider is not a system package of any production userspace", () => {
  const config = defaultConfig("/tmp/home", PROJECT);
  const named = Object.values(config.systemPackages).flat();
  assert.ok(!named.includes("@thetis/provider-bench"));
  assert.ok(!named.includes("@thetis/bench-probe"));
});
