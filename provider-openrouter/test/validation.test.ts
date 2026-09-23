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
  for await (const event of createProvider({ apiKey: "test" }).call(call)) events.push(event);
  assert.equal(events[0].type, "error");
  if (events[0].type === "error") assert.match(events[0].message, /tool arguments/i);
});
