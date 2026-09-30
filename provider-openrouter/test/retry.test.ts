import { test } from "node:test";
import assert from "node:assert/strict";
import { askedWaitMs, refusal, retryAfterMs, stopMessage } from "../src/index.js";

test("a final refusal is not retried; a transient one waits for Retry-After, the body's hint, or a backoff", () => {
  assert.equal(retryAfterMs(401, "unauthorized", null, 0), undefined);
  assert.equal(retryAfterMs(402, '{"error":{"message":"insufficient credits"}}', null, 0), undefined);
  assert.equal(retryAfterMs(402, '{"metadata":{"reason":"in_flight_budget_exhausted","headers":{"Retry-After":"120"}}}', null, 0), 120_000);
  assert.equal(retryAfterMs(429, "slow down", "7", 0), 7000);
  assert.equal(retryAfterMs(503, "busy", null, 2), 4000);
  assert.equal(retryAfterMs(503, "busy", "9999", 0), 120_000);
});

test("a refusal is reported as one sentence, with the reason when the body names one", () => {
  assert.equal(refusal(402, '{"error":{"message":"This request\'s maximum cost exceeds your available credits.","code":402,"metadata":{"reason":"weight_exceeds_budget"}}}'), "openrouter 402: This request's maximum cost exceeds your available credits. (weight_exceeds_budget)");
  assert.equal(refusal(502, "<html>bad gateway</html>"), "openrouter 502: <html>bad gateway</html>");
  // an upstream's refusal: OpenRouter says only "Provider returned error"; the reason is in metadata.raw
  const raw = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content.21.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels" } });
  assert.equal(
    refusal(400, JSON.stringify({ error: { message: "Provider returned error", code: 400, metadata: { raw, provider_name: "Anthropic" } } })),
    "openrouter 400: Provider returned error (Anthropic: messages.0.content.21.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels)",
  );
  assert.equal(refusal(400, JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: "upstream said no" } } })), "openrouter 400: Provider returned error (upstream said no)");
});

test("a reply cut at the output limit is reported; a normal stop is not", () => {
  assert.match(stopMessage("length", 8192) ?? "", /output limit of 8192 tokens/);
  assert.match(stopMessage("length", undefined) ?? "", /output limit;/);
  assert.equal(stopMessage("stop", 8192), undefined);
  assert.equal(stopMessage(undefined, 8192), undefined);
});

test("askedWaitMs reads only what the refusal asked for; a transient refusal with nothing asked falls back to the backoff", () => {
  assert.equal(askedWaitMs("busy", "3"), 3000);
  assert.equal(askedWaitMs('{"metadata":{"headers":{"Retry-After":"12"}}}', null), 12_000);
  assert.equal(askedWaitMs("busy", null), undefined);
  assert.equal(retryAfterMs(529, "overloaded", null, 1), 2000, "529 is transient too");
});
