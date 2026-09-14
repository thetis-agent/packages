import { test } from "node:test";
import assert from "node:assert/strict";
import { refusal, retryAfterMs } from "../src/index.js";

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
});
