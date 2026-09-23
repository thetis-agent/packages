import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsage } from "../src/usage.js";

test("openrouter usage is flattened with cache fields", () => {
  const u = normalizeUsage({ prompt_tokens: 9653, completion_tokens: 1, total_tokens: 9654, cost: 0.0027, prompt_tokens_details: { cached_tokens: 9308, cache_write_tokens: 343, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
  assert.equal(u.cache_read_tokens, 9308);
  assert.equal(u.cache_write_tokens, 343);
  assert.equal(u.prompt_tokens, 9653);
  assert.equal(u.cost, 0.0027);
  assert.equal(u.reasoning_tokens, 0);
  assert.equal(u.cache_read_ratio, 0.964);
  assert.equal("prompt_tokens_details" in u, false);
});

test("anthropic usage maps to the same fields", () => {
  const u = normalizeUsage({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 88 });
  assert.equal(u.cache_read_tokens, 900);
  assert.equal(u.cache_write_tokens, 88);
  assert.equal(u.prompt_tokens, 1000);
  assert.equal(u.completion_tokens, 5);
  assert.equal(u.cache_read_ratio, 0.9);
});

test("garbage in, empty out", () => {
  assert.deepEqual(normalizeUsage(null), {});
  assert.deepEqual(normalizeUsage("x"), {});
  assert.equal(normalizeUsage({}).cache_read_tokens, 0);
});

test("usage rejects arrays and ignores nonfinite or incorrectly typed metrics", () => {
  assert.deepEqual(normalizeUsage([12, 34]), {});
  const usage = normalizeUsage({ prompt_tokens: "12", cost: Infinity, input_tokens: 10, prompt_tokens_details: { cached_tokens: "3", cache_write_tokens: 2 } });
  assert.equal(usage.prompt_tokens, 12);
  assert.equal(usage.cache_read_tokens, 0);
  assert.equal(usage.cache_write_tokens, 2);
  assert.equal(usage.cost, undefined);
});
