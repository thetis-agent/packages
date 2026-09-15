// The arena through the real kernel, the real fence and the real agent. This is the test that proves the
// whole mechanism: the bench phase runs when configured and never otherwise, the provider sees the assembled
// call, and a package's claim is checked against what actually reached the prompt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Arena, BENCH_PHASE } from "../src/arena.js";
import { runTask, probeRan } from "../src/runner.js";
import { loadSuite, strata, validateSuite, visible } from "../src/suite.js";

const PROJECT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const SANDBOX = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
const SUITE = resolve(PROJECT, "packages/bench/suites/assembly-cost-v1");

let arena: Arena;

/** A package that injects a body and claims it honestly, and one that claims a body it never injected. */
function writeFixtures(root: string): { honest: string; liar: string } {
  const honest = resolve(root, "honest");
  const liar = resolve(root, "liar");
  for (const [dir, name, injects] of [
    [honest, "@honest/skills", true],
    [liar, "@liar/skills", false],
  ] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({
        name,
        version: "0.1.0",
        description: "A bench fixture.",
        type: "module",
        main: "index.js",
        thetis: {
          type: "loader",
          steps: [
            { id: "inject", phase: "prompt", export: "inject" },
            { id: "bench-report", phase: BENCH_PHASE, export: "benchReport" },
          ],
          bench: { suites: ["assembly-cost@1"], adapter: "benchReport" },
        },
      }),
    );
    writeFileSync(
      resolve(dir, "index.js"),
      `const BODY = ${JSON.stringify(injects ? "## cap.alpha\\n[[c:alpha]] the body of alpha.\\n" : "## cap.alpha\\nno body here.\\n")};
export async function inject(ctx) {
  return { call: { ...ctx.call, system: [ctx.call.system, BODY].filter(Boolean).join("\\n\\n") } };
}
export async function benchReport(ctx) {
  const prev = ctx.harness["@thetis/bench"] ?? {};
  return { harness: { ...ctx.harness, "@thetis/bench": { ...prev, claims: { ...(prev.claims ?? {}), ${JSON.stringify(name)}: { direct: ["cap.alpha"], offered: [] } } } } };
}`,
    );
  }
  return { honest, liar };
}

before(async () => {
  const staging = resolve(PROJECT, "packages/bench/dist/.fixtures");
  const { honest, liar } = writeFixtures(staging);
  arena = await Arena.open({
    project: PROJECT,
    sandbox: SANDBOX,
    canaries: { "cap.alpha": "[[c:alpha]]", "cap.beta": "[[c:beta]]" },
    script: { default: { turns: [{ text: "ok" }, { text: "ok" }] } },
    arms: [
      { id: "none" },
      { id: "honest", packages: [honest] },
      { id: "liar", packages: [liar] },
      { id: "tools", packages: [resolve(PROJECT, "packages/tools-files")] },
    ],
  });
});

after(async () => {
  await arena.close();
});

const task = { id: "t-read", query: "Read src/index.ts and say what it exports.", turns: 2 };
const run = (arm: string) => runTask(arena, arm, task, 0, { runId: "r1" });

test("a suite on disk loads, validates, and reports its strata", () => {
  const suite = loadSuite(SUITE);
  assert.equal(suite.id, "assembly-cost@1");
  assert.equal(suite.probe, "A");
  assert.ok(suite.tasks.length >= 7);
  assert.equal(visible(suite).length, suite.tasks.length, "nothing in this suite is held back");
  assert.ok(strata(suite.tasks).control >= 2, "a suite needs tasks no capability should help with");
  assert.throws(() => validateSuite({ ...suite, tasks: [suite.tasks[0]!, suite.tasks[0]!] }), /repeats the task id/);
});

test("the floor arm assembles a prompt and the bench phase runs in it", async () => {
  const seen = await run("none");
  assert.deepEqual(seen.errors, []);
  assert.ok(probeRan(seen), "the probe's step must run, or the bench phase was never configured");
  assert.ok(seen.rounds.length >= 2, "two turns were driven, so the provider saw the call twice");
  assert.ok(seen.rounds[0]!.bytes.system > 0, "the harness builds a system prompt even with no package");
  assert.deepEqual(seen.reconciled.available.direct, new Set(), "the floor surfaces no capability");
});

test("the query reaches the harness exactly as written, with the addressing in the model name", async () => {
  const seen = await run("none");
  assert.equal(seen.rounds[0]!.model, "bench/r1/none/t-read/0");
  const messages = arena.kernel.sessions.list(arena.userOf("none"));
  assert.ok(messages.length > 0);
  const record = arena.kernel.sessions.inspect(arena.userOf("none"), messages.at(-1)!.id);
  assert.ok(
    record.conversation.some((m) => m.role === "user" && m.content === task.query),
    "no marker is added to the query: a retriever matches on this text",
  );
});

test("an honest package's claim is confirmed by the canary it left in the prompt", async () => {
  const seen = await run("honest");
  assert.deepEqual(seen.errors, []);
  assert.deepEqual([...seen.reconciled.available.direct], ["cap.alpha"]);
  assert.deepEqual(seen.reconciled.adapterLies, [], "what it claimed is what it injected");
  assert.deepEqual(seen.claims["@honest/skills"]?.direct, ["cap.alpha"]);
});

test("a package that claims a body it never injected is caught", async () => {
  const seen = await run("liar");
  assert.deepEqual(seen.errors, []);
  assert.deepEqual(seen.reconciled.adapterLies, ["cap.alpha"], "claimed direct, no canary in the prompt");
  assert.deepEqual([...seen.reconciled.available.direct], [], "nothing is scored on a claim alone");
});

test("a package's prompt cost shows up as bytes the floor arm does not pay", async () => {
  const floor = await run("none");
  const honest = await run("honest");
  assert.ok(honest.rounds[0]!.bytes.system > floor.rounds[0]!.bytes.system, "an injected body costs system bytes");
});

test("a tool package's cost shows up in the tool segment, not the prompt segment", async () => {
  const floor = await run("none");
  const tools = await run("tools");
  assert.ok(tools.rounds[0]!.bytes.tools > floor.rounds[0]!.bytes.tools, "six tool schemas are not free");
  assert.ok(tools.rounds[0]!.toolNames.length > floor.rounds[0]!.toolNames.length);
  assert.ok(tools.rounds[0]!.toolNames.includes("read_path"));
});

test("steps are timed and the assembly cost excludes the built-in call", async () => {
  const seen = await run("honest");
  assert.ok(seen.steps.length >= 3, "the harness prompt, the tool attach, the adapter and the probe all ran");
  assert.ok(seen.steps.some((s) => s.package === "@thetis/kernel"), "the built-in call is a step too");
  assert.ok(seen.assembleMs >= 0);
  assert.ok(!seen.steps.filter((s) => s.package === "@thetis/kernel").some((s) => s.ms === undefined));
});

test("the same conversation on a second turn keeps its prefix, which is what caching makes free", async () => {
  const seen = await run("none");
  const second = seen.rounds[1];
  assert.ok(second, "the second turn was captured");
  assert.ok(second.prefixBytes > 0, "the prompt prefix survives from one turn to the next");
  assert.equal(second.sha.system, seen.rounds[0]!.sha.system, "nothing rewrote the system prompt between turns");
});
