import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../fixtures/provider-bench/index.js";
import { canariesIn, commonPrefix, measure, nonAsciiRatio, parseAddress } from "../fixtures/provider-bench/lib/measure.js";
import { holds, replyFor } from "../fixtures/provider-bench/lib/script.js";

const call = (over = {}) => ({
  model: "bench/r1/arm/t-1/0",
  system: "you are thetis",
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "exec", description: "run a command", parameters: { type: "object" } }],
  params: {},
  ...over,
});

const drain = async (provider, c) => {
  const events = [];
  for await (const e of provider.call(c)) events.push(e);
  return events;
};

test("the provider serves every model, which is how the bench addresses a run", async () => {
  assert.deepEqual(await createProvider({}).models(), [{ id: "*" }]);
});

test("the address rides in the model name, so the query text is never touched", () => {
  assert.deepEqual(parseAddress("bench/r1/l1/t-0007/2"), { run: "r1", arm: "l1", task: "t-0007", attempt: 2 });
  assert.equal(parseAddress("anthropic/claude-sonnet-5"), null);
  assert.equal(parseAddress("bench/short"), null);
  assert.equal(parseAddress(undefined), null);
});

test("a canary is found wherever in the prompt a mechanism chose to put it", () => {
  const canaries = { "cap.a": "[[c:aaa]]", "cap.b": "[[c:bbb]]" };
  assert.deepEqual(canariesIn("## Skills\n[[c:bbb]] reformatted however\n", canaries), ["cap.b"]);
  assert.deepEqual(canariesIn("nothing here", canaries), []);
  assert.deepEqual(canariesIn("[[c:bbb]] and [[c:aaa]]", canaries), ["cap.a", "cap.b"]);
});

test("the shared prefix is what caching makes free, so it is measured in bytes", () => {
  assert.equal(commonPrefix("abcdef", "abcxyz"), 3);
  assert.equal(commonPrefix("same", "same"), 4);
  assert.equal(commonPrefix("", "abc"), 0);
});

test("the non-ascii share flags an arm whose bytes buy unusual numbers of tokens", () => {
  assert.equal(nonAsciiRatio("plain ascii"), 0);
  assert.ok(nonAsciiRatio("日本語テキスト") > 0.5);
  assert.equal(nonAsciiRatio(""), 0);
});

test("measurement splits the call into segments rather than summing it into one number", () => {
  const seen = measure(call(), { "cap.a": "[[c:aaa]]" }, undefined);
  assert.ok(seen.bytes.system > 0 && seen.bytes.tools > 0 && seen.bytes.messages > 0);
  assert.equal(seen.bytes.total, seen.bytes.system + seen.bytes.tools + seen.bytes.messages);
  assert.deepEqual(seen.toolNames, ["exec"]);
  assert.deepEqual(seen.canaryDirect, []);
  assert.deepEqual(seen.hintKeys, []);
});

test("hint keys are recorded when the cache step has added them", () => {
  assert.deepEqual(measure(call({ hints: { cache: { strategy: "a" } } }), {}, undefined).hintKeys, ["cache"]);
});

test("a guard reads what the harness assembled, not what the query said", () => {
  assert.equal(holds(undefined, call()), true);
  assert.equal(holds({ toolsInclude: "exec" }, call()), true);
  assert.equal(holds({ toolsInclude: "skill_fetch" }, call()), false);
  assert.equal(holds({ systemIncludes: "thetis" }, call()), true);
  assert.equal(holds({ systemExcludes: "thetis" }, call()), false);
});

test("a guarded step falls back to its else branch, so one script covers arms that differ", () => {
  const script = {
    tasks: {
      "t-1": {
        turns: [{ when: { toolsInclude: "skill_fetch" }, toolCall: { name: "skill_fetch" }, else: { text: "no tool here" } }],
      },
    },
  };
  assert.deepEqual(replyFor(script, "t-1", 0, call()), { text: "no tool here" });
  const withTool = call({ tools: [{ name: "skill_fetch", description: "d", parameters: {} }] });
  assert.equal(replyFor(script, "t-1", 0, withTool).toolCall.name, "skill_fetch");
});

test("a task with no script of its own falls back to the default, and past the end says done", () => {
  const script = { default: { turns: [{ text: "hi" }] } };
  assert.deepEqual(replyFor(script, "t-unknown", 0, call()), { text: "hi" });
  assert.deepEqual(replyFor(script, "t-unknown", 9, call()), { text: "done" });
});

test("every provider call emits its numbers on the usage channel the kernel already forwards", async () => {
  const provider = createProvider({ inlineScript: { default: { turns: [{ text: "ok" }] } }, canaries: { "cap.a": "[[c:aaa]]" } });
  const events = await drain(provider, call({ system: "guide [[c:aaa]]" }));
  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage, "a usage event is always emitted");
  assert.equal(usage.usage.bench_direct_n, 1);
  assert.equal(usage.usage.bench_tools_n, 1);
  assert.equal(usage.usage.bench_round, 0);
  assert.deepEqual(events.at(-1), { type: "text", delta: "ok" });
});

test("the capture file records one line per provider call, with the address intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-capture-"));
  try {
    const capture = join(dir, "capture.ndjson");
    const provider = createProvider({ capture, inlineScript: { default: { turns: [{ text: "a" }, { text: "b" }] } } });
    await drain(provider, call());
    await drain(provider, call());
    const lines = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.round), [0, 1]);
    assert.equal(lines[0].task, "t-1");
    assert.equal(lines[0].arm, "arm");
    assert.ok(lines[0].bytes.system > 0);
    assert.equal(lines[0].prefixText, undefined, "the prefix text itself is not written to the capture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefix stability is measured across the turns of one run", async () => {
  const provider = createProvider({ inlineScript: { default: { turns: [{ text: "a" }, { text: "b" }] } } });
  const first = await drain(provider, call());
  const stable = await drain(provider, call());
  const changed = await drain(provider, call({ system: "a completely different prompt" }));
  assert.ok(first[0].usage.bench_prefix_bytes > 0, "the first call has no predecessor, so the whole prefix counts");
  assert.equal(stable[0].usage.bench_prefix_bytes, first[0].usage.bench_prefix_bytes, "an identical prompt is wholly cacheable");
  assert.ok(changed[0].usage.bench_prefix_bytes < stable[0].usage.bench_prefix_bytes, "a rewritten prompt breaks the prefix");
});

test("the round cursor is keyed by the whole address, so arms cannot disturb each other", async () => {
  const provider = createProvider({ inlineScript: { default: { turns: [{ text: "first" }, { text: "second" }] } } });
  const armA = await drain(provider, call({ model: "bench/r1/a/t-1/0" }));
  const armB = await drain(provider, call({ model: "bench/r1/b/t-1/0" }));
  assert.deepEqual(armA.at(-1), { type: "text", delta: "first" });
  assert.deepEqual(armB.at(-1), { type: "text", delta: "first" }, "a second arm starts its own script at the beginning");
});

test("injected latency is deliberate and reported, so it can be subtracted again", async () => {
  const provider = createProvider({ inlineScript: { default: { turns: [{ text: "slow", latencyMs: 25 }] } } });
  const started = Date.now();
  await drain(provider, call());
  assert.ok(Date.now() - started >= 20, "the script's latency actually delays the reply");
});
