import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../src/index.js";
import type { ProviderCall, ProviderEvent } from "@thetis/runtime/contracts";

const call: ProviderCall = { model: "model", messages: [], tools: [], params: {} };

test("models validates nested provider data before returning descriptors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: 42 }] }));
  await assert.rejects(createProvider().models(), /OpenRouter models.*data.*id/i);
});

test("malformed SSE payloads become explicit provider errors", async (t) => {
  for (const payload of ["not json", "null", JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: "zero" }] } }] }), JSON.stringify({ choices: [{ delta: { reasoning: 7 } }] })]) {
    t.mock.method(globalThis, "fetch", async () => new Response(`data: ${payload}\n\ndata: [DONE]\n\n`));
    const events: ProviderEvent[] = [];
    for await (const event of createProvider({ apiKey: "test" }).call(call)) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    if (events[0].type === "error") assert.match(events[0].message, /OpenRouter stream/i);
    t.mock.restoreAll();
  }
});

test("provider extensions remain compatible while tool arguments require objects", async (t) => {
  const payload = { unknownFutureField: true, choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "tool", arguments: "[]" } }] } }] };
  t.mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`));
  const events: ProviderEvent[] = [];
  for await (const event of createProvider({ apiKey: "test" }).call(call)) if (event.type !== "extension") events.push(event);
  assert.equal(events[0].type, "error");
  if (events[0].type === "error") assert.match(events[0].message, /tool arguments/i);
});

test("tool call arguments still arriving are reported as progress, so a long write is not silence", async (t) => {
  const pieces = Array.from({ length: 40 }, (_, i) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(i === 0 ? { id: "c1", function: { name: "write", arguments: "{\"text\":\"" } } : { function: { arguments: "x".repeat(100) } }) }] } }] }));
  pieces.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"}" } }] } }] });
  t.mock.method(globalThis, "fetch", async () => new Response(pieces.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n"));
  let now = 0;
  t.mock.method(Date, "now", () => (now += 1_000));
  const events: ProviderEvent[] = [];
  for await (const event of createProvider({ apiKey: "test" }).call(call)) events.push(event);
  const progress = events.filter((e) => e.type === "extension" && e.name === "tool_call.progress");
  assert.ok(progress.length >= 5, `expected progress while the arguments streamed, got ${progress.length}`);
  assert.ok(progress.length < pieces.length, "progress is throttled, not one per chunk");
  const lastData = (progress.at(-1) as unknown as { data: { name: string; chars: number } }).data;
  assert.equal(lastData.name, "write");
  assert.ok(lastData.chars > 1_000);
  const done = events.find((e) => e.type === "tool_call");
  assert.ok(done && done.type === "tool_call" && done.call.name === "write");
});

test("reasoning chunks with empty content do not emit text events", async (t) => {
  const chunks = Array.from({ length: 12 }, (_, i) => ({ content: "", reasoning: `thought ${i} ` }));
  const deltas = [{ role: "assistant", content: "" }, ...chunks, { content: "The" }, { content: " " }, { content: "answer" }];
  const body = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n";
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  const events: ProviderEvent[] = [];
  for await (const event of createProvider({ apiKey: "test" }).call(call)) events.push(event);
  assert.deepEqual(events, [
    ...chunks.map((chunk) => ({ type: "reasoning", delta: chunk.reasoning })),
    ...["The", " ", "answer"].map((delta) => ({ type: "text", delta })),
  ]);
});
