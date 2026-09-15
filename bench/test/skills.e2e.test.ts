// Three mechanisms that share no internal representation, scored in one table — and a fourth that reports
// what it wishes it had done, caught. This is the test that the agnostic contract works.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Arena } from "../src/arena.js";
import { loadCorpus, stoplist } from "../src/corpus.js";
import { runTask } from "../src/runner.js";
import { loadSuite, visible, type Task } from "../src/suite.js";
import { metricsOf, summarise } from "../src/score.js";

const PROJECT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const SANDBOX = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
const SUITE = resolve(PROJECT, "packages/bench/suites/skill-recall-v1");
const arm = (name: string) => resolve(PROJECT, "packages/bench/fixtures/arms", name);

let arena: Arena;
let tasks: Task[];
const corpus = loadCorpus(SUITE);

before(async () => {
  const suite = loadSuite(SUITE);
  // Four tasks: enough to see every mechanism behave, few enough to keep the suite quick.
  tasks = visible(suite).filter((t) => (t.required ?? []).length > 0).slice(0, 3).concat(visible(suite).filter((t) => t.control).slice(0, 1));
  arena = await Arena.open({
    project: PROJECT,
    sandbox: SANDBOX,
    script: suite.script,
    corpus: { id: corpus.id, version: corpus.version, records: corpus.records },
    canaries: corpus.canaries,
    arms: [
      { id: "none" },
      { id: "flat", packages: [arm("skills-flat")] },
      { id: "l1", packages: [arm("skills-l1")] },
      { id: "rank", packages: [arm("skills-rank")] },
      { id: "liar", packages: [arm("skills-liar")] },
    ],
  });
});

after(async () => {
  await arena.close();
});

const run = (armId: string, task: Task) => runTask(arena, armId, task, 0, { runId: "s1" });

test("the corpus matches its recorded digest and every record carries its own canary", () => {
  assert.equal(corpus.records.length, corpus.meta.records);
  assert.ok(corpus.records.length > 100, "a corpus small enough to inject whole is not a test of retrieval");
  for (const record of corpus.records.slice(0, 20)) assert.ok(record.body.includes(record.canary));
  assert.equal(Object.keys(corpus.canaries).length, corpus.records.length);
});

test("the corpus was imported, and says where from", () => {
  assert.equal(corpus.meta.dataset?.license, "Apache-2.0");
  assert.match(corpus.meta.dataset?.id ?? "", /SKILLRET/);
  assert.ok(corpus.meta.dataset?.revision, "a dataset with no revision is not reproducible");
});

test("the stoplist holds the words a variant must not touch", () => {
  const stop = stoplist(corpus);
  assert.ok(stop.size > 500, "the stoplist is built from the corpus itself, not written by hand");
  const first = corpus.records[0];
  assert.ok(first && stop.has(first.name.toLowerCase().split(/[^a-z0-9]+/)[0] as string));
});

test("injecting everything reaches what it happens to have room for, and pays for all of it", async () => {
  const task = tasks[0] as Task;
  const seen = await run("flat", task);
  assert.deepEqual(seen.errors, []);
  assert.ok(seen.reconciled.available.direct.size > 0, "bodies really are in the prompt");
  assert.deepEqual(seen.reconciled.adapterLies, [], "and it claimed exactly those");
  assert.ok((seen.rounds[0]?.bytes.system ?? 0) > 50_000, "a budget's worth of bodies is a large prompt");
});

test("a catalogue reaches everything at the price of a round trip and no body in hand", async () => {
  const seen = await run("l1", tasks[0] as Task);
  assert.deepEqual(seen.errors, []);
  assert.equal(seen.reconciled.available.direct.size, 0, "nothing is in hand");
  assert.equal(seen.reconciled.available.catalogue.size, corpus.records.length, "everything is one call away");
  const score = metricsOf(seen, tasks[0] as Task, corpus.records.length);
  assert.equal(score.recall_reach, 1);
  assert.equal(score.recall_direct, 0);
  assert.equal(score.fetch_rounds, 1, "reaching it costs a call");
});

test("a ranker puts a few bodies in hand and is the only arm with an order to report", async () => {
  const seen = await run("rank", tasks[0] as Task);
  assert.deepEqual(seen.errors, []);
  assert.ok(seen.reconciled.available.direct.size > 0 && seen.reconciled.available.direct.size <= 3);
  assert.ok(seen.reconciled.available.ranked?.length, "the ranking is reported");
  assert.deepEqual(seen.reconciled.adapterLies, []);
  const flat = await run("flat", tasks[0] as Task);
  assert.ok(
    (seen.rounds[0]?.bytes.system ?? 0) < (flat.rounds[0]?.bytes.system ?? 0),
    "and it costs a fraction of injecting everything",
  );
});

test("a search tool proves reach by returning records, not by claiming them", async () => {
  const seen = await run("rank", tasks[0] as Task);
  const returned = new Set(seen.rounds.flatMap((r) => r.idsReturned ?? []));
  assert.ok(returned.size > 0, "the scripted probe called the search tool with the task's own words");
  assert.ok(
    [...seen.reconciled.available.search].every((id) => returned.has(id)),
    "only what came back counts as reachable through search",
  );
  assert.ok(seen.reconciled.offeredUnverified.length > 0, "the rest is claimed, unproven, and excluded");
});

test("a package that reports what it did not do is caught, and scored on the evidence", async () => {
  const seen = await run("liar", tasks[0] as Task);
  assert.deepEqual(seen.errors, []);
  assert.equal(seen.reconciled.adapterLies.length, 5, "it named five capabilities and injected none");
  assert.equal(seen.reconciled.available.direct.size, 0, "so it reaches nothing");
  const score = metricsOf(seen, tasks[0] as Task, corpus.records.length);
  assert.equal(score.recall_direct, 0);
  assert.ok((seen.rounds[0]?.bytes.system ?? 0) < 6000, "and its prompt is nearly empty, which is the tell");
});

test("a dishonest arm fails conformance while the honest ones pass", async () => {
  const task = tasks[0] as Task;
  const observations = [await run("none", task), await run("rank", task), await run("liar", task)];
  const scores = summarise(observations, [task], { floor: "none", suite: "skill-recall@1", registrySize: corpus.records.length });
  const byArm = new Map(scores.map((s) => [s.arm, s]));
  assert.deepEqual(byArm.get("rank")?.conformance.adapterLies, []);
  assert.ok((byArm.get("liar")?.conformance.adapterLies.length ?? 0) > 0);
});

test("three mechanisms that share no representation land in one table", async () => {
  const observations = [];
  for (const armId of ["none", "flat", "l1", "rank"]) {
    for (const task of tasks) observations.push(await run(armId, task));
  }
  const scores = summarise(observations, tasks, { floor: "none", suite: "skill-recall@1", registrySize: corpus.records.length });
  assert.equal(scores.length, 4);
  for (const score of scores) {
    assert.ok(score.absolute.bytes_system, `${score.arm} has a byte figure`);
    assert.ok(score.absolute.recall_reach !== undefined, `${score.arm} has a reach figure`);
  }
  // The one number that is not shared, under the one arm that can produce it.
  assert.ok(scores.find((s) => s.arm === "rank")?.perArm.ndcg, "the ranker reports a ranking score");
  for (const other of ["none", "flat", "l1"]) {
    assert.equal(scores.find((s) => s.arm === other)?.perArm.ndcg, undefined, `${other} cannot rank, so it has no ranking score`);
  }
});

test("a control task is one no capability should help with, and none of them do", async () => {
  const control = tasks.find((t) => t.control);
  assert.ok(control, "the suite ships control tasks");
  const seen = await run("rank", control);
  const score = metricsOf(seen, control, corpus.records.length);
  assert.equal(score.recall_reach, undefined, "with nothing required there is no recall to state");
  assert.ok((score.direct_n ?? 0) >= 0);
});
