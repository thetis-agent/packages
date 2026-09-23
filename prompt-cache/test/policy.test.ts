import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHint, readHint, resolveHint, resolvePolicy, vendorOf } from "../src/policy.js";

test("vendors come from the model id", () => {
  assert.equal(vendorOf("anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(vendorOf("openai/gpt-5"), "openai");
  assert.equal(vendorOf("Anthropic/x"), "anthropic");
  assert.equal(vendorOf("echo"), "echo");
});

test("explicit vendors get breakpoints, others stay automatic", () => {
  assert.equal(resolvePolicy({}, "anthropic/claude-sonnet-5").strategy, "breakpoints");
  assert.equal(resolvePolicy({}, "openai/gpt-5").strategy, "automatic");
  assert.equal(resolvePolicy({ explicitVendors: ["echo"] }, "echo").strategy, "breakpoints");
  assert.equal(resolvePolicy({ enabled: false }, "anthropic/claude-sonnet-5").strategy, "off");
});

test("defaults and overrides", () => {
  const p = resolvePolicy({}, "anthropic/claude-sonnet-5");
  assert.equal(p.ttl, "5m");
  assert.equal(p.systemTtl, "1h");
  assert.equal(p.anchorStride, 8);
  assert.equal(p.maxBreakpoints, 4);
  const o = resolvePolicy({ overrides: { anthropic: { ttl: "1h" }, "anthropic/claude-opus": { anchorStride: 4 }, google: { strategy: "breakpoints" } } }, "anthropic/claude-opus-5");
  assert.equal(o.anchorStride, 4, "the longest matching key wins");
  assert.equal(o.ttl, "5m", "an override replaces only what it names");
  assert.equal(resolvePolicy({ overrides: { google: { strategy: "breakpoints" } } }, "google/gemini-3-pro").strategy, "breakpoints");
  assert.equal(resolvePolicy({ enabled: false, overrides: { anthropic: { strategy: "breakpoints" } } }, "anthropic/x").strategy, "off", "disabled wins");
});

test("a hint from the fence is validated field by field", () => {
  assert.equal(readHint(undefined), undefined);
  assert.equal(readHint({ strategy: "bogus", ttl: "2h" }), undefined, "nothing usable");
  assert.deepEqual(readHint({ strategy: "off", ttl: "1h", anchorStride: 4, maxBreakpoints: 99, affinity: "thetis:abc", extra: 1 }), { strategy: "off", ttl: "1h", anchorStride: 4, maxBreakpoints: 99, affinity: "thetis:abc" });
  assert.equal(readHint({ affinity: "x".repeat(200) }), undefined);
});

test("the step's hint is sparse: only what its configuration names", () => {
  assert.deepEqual(resolveHint({}, "anthropic/claude-sonnet-5"), { version: 1 });
  assert.deepEqual(resolveHint({ ttl: "1h" }, "anthropic/x"), { version: 1, ttl: "1h" });
  assert.deepEqual(resolveHint({ explicitVendors: ["echo"] }, "echo"), { version: 1, strategy: "breakpoints" });
  assert.deepEqual(resolveHint({ enabled: false }, "anthropic/x"), { version: 1, strategy: "off" });
  assert.deepEqual(resolveHint({ overrides: { anthropic: { anchorStride: 4 } } }, "anthropic/x"), { version: 1, anchorStride: 4 });
});

test("hint modes: ignore keeps the policy, tune never changes the strategy, override may", () => {
  const policy = resolvePolicy({}, "anthropic/claude-sonnet-5");
  const hint = { strategy: "off" as const, ttl: "1h" as const, anchorStride: 4, maxBreakpoints: 99, affinity: "thetis:abc" };
  assert.deepEqual(applyHint(policy, hint, "ignore"), policy);
  assert.deepEqual(applyHint(policy, undefined, "override"), policy);
  const tuned = applyHint(policy, hint, "tune");
  assert.equal(tuned.strategy, "breakpoints", "whether caching happens stays with the payer");
  assert.equal(tuned.ttl, "1h");
  assert.equal(tuned.anchorStride, 4);
  assert.equal(tuned.maxBreakpoints, 4, "clamped");
  assert.equal(tuned.affinity, "thetis:abc");
  assert.equal(applyHint(policy, hint).strategy, "breakpoints", "tune is the default");
  assert.equal(applyHint(policy, hint, "override").strategy, "off");
  assert.equal(applyHint(policy, { ttl: "1h" }, "tune").systemTtl, "1h", "the system lifetime is lifted with the conversation lifetime");
});

test("a 1h conversation lifetime lifts the system lifetime with it", () => {
  const p = resolvePolicy({ ttl: "1h", systemTtl: "5m" }, "anthropic/x");
  assert.equal(p.systemTtl, "1h");
});

test("hints never coerce objects into trusted enum values", () => {
  assert.equal(readHint({ strategy: { toString: () => "off" } }), undefined);
  assert.deepEqual(readHint({ ttl: "1h", anchorStride: Infinity, maxBreakpoints: "2" }), { ttl: "1h" });
});
