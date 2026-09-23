import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ProviderEvent } from "@thetis/runtime/contracts";
import { createProvider } from "../src/index.js";

test("inspection capture matches the sent JSON after defaults, overrides and cache breakpoints, without headers", async () => {
  let posted: unknown;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    posted = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = createProvider({ apiKey: "test-capture-key", headers: { "X-Private": "private-header" }, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, defaults: { temperature: 0.9, max_tokens: 1000 } });
    const events: ProviderEvent[] = [];
    for await (const event of provider.call({ model: "anthropic/claude-sonnet-4", system: "Stable prompt", messages: [{ role: "user", content: "hello" }], tools: [], params: { temperature: 0.2 }, hints: { context: true } })) events.push(event);
    const capture = events[0];
    assert.equal(capture.type, "request");
    if (capture.type !== "request") throw new Error("missing capture");
    assert.deepEqual(capture.body, posted);
    assert.equal(capture.body.temperature, 0.2);
    assert.equal(capture.body.max_tokens, 1000);
    assert.match(JSON.stringify(capture.body), /cache_control/);
    assert.doesNotMatch(JSON.stringify(capture.body), /test-capture-key|private-header|Authorization|hints/);
    assert.ok(Number.isFinite(Date.parse(capture.at)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
