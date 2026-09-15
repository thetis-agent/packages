import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../fixtures/provider-bench/index.js";
import { seen } from "./fixtures/provider-stub/index.js";

const call = (over = {}) => ({
  model: "bench/r1/arm/t-1/0",
  system: "guide",
  messages: [{ role: "user", content: "a question" }],
  tools: [],
  params: {},
  ...over,
});

const drain = async (provider, c) => {
  const events = [];
  for await (const e of provider.call(c)) events.push(e);
  return events;
};

const upstream = (over = {}) => ({
  upstream: { package: new URL("./fixtures/provider-stub/index.js", import.meta.url).href, model: "vendor/real-model", config: {} },
  ...over,
});

test("with an upstream the bench provider stops answering and starts forwarding", async () => {
  seen.length = 0;
  const provider = createProvider(upstream());
  const events = await drain(provider, call());
  assert.deepEqual(events.at(-1), { type: "text", delta: "stub saw vendor/real-model" });
  assert.deepEqual(seen, ["vendor/real-model"], "the address is swapped for a real model id at the boundary");
});

test("the address still rides in the model name, so the query text is untouched either way", async () => {
  seen.length = 0;
  const provider = createProvider(upstream());
  const c = call();
  await drain(provider, c);
  assert.equal(c.messages[0].content, "a question");
  assert.equal(c.model, "bench/r1/arm/t-1/0", "the caller's own object is not rewritten");
});

test("the measurement is taken whether a model answers or a script does", async () => {
  const withModel = await drain(createProvider(upstream()), call());
  const scripted = await drain(createProvider({ inlineScript: { default: { turns: [{ text: "x" }] } } }), call());
  for (const events of [withModel, scripted]) {
    const bench = events.find((e) => e.type === "usage" && e.usage.bench_bytes_system !== undefined);
    assert.ok(bench, "a measurement is emitted in both modes");
    assert.equal(bench.usage.bench_bytes_system, 5);
  }
});

test("what the real provider reported comes through untouched", async () => {
  const events = await drain(createProvider(upstream()), call());
  const real = events.find((e) => e.type === "usage" && e.usage.cost !== undefined);
  assert.equal(real.usage.prompt_tokens, 100);
  assert.equal(real.usage.cost, 0.25);
});

test("spending stops once the ceiling is crossed, and says what it spent", async () => {
  // The ceiling governs whether to start another call, not how much one costs: a call's price is not known
  // until it has been made, so the last one may carry the total past the line. It cannot carry it far.
  const provider = createProvider(upstream({ maxCostUsd: 0.4 }));
  await drain(provider, call());
  await drain(provider, call());
  assert.equal(provider.spent(), 0.5, "the second call was started under the ceiling and finished over it");
  const third = await drain(provider, call());
  const error = third.find((e) => e.type === "error");
  assert.ok(error, "the third call is refused before any money is committed");
  assert.match(error.message, /cost ceiling reached/);
  assert.match(error.message, /\$0\.5000 of \$0\.40/);
  assert.equal(provider.spent(), 0.5, "and nothing more is spent");
});

test("no ceiling means no refusal, which is why the flag has to be passed deliberately", async () => {
  const provider = createProvider(upstream());
  for (let i = 0; i < 5; i++) await drain(provider, call());
  assert.equal(provider.spent(), 1.25);
});
