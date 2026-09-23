import { test } from "node:test";
import assert from "node:assert/strict";
import type { PackageStepContext, ProviderCall } from "@thetis/runtime/contracts";
import { diagnose, fingerprint } from "../src/fingerprint.js";
import { HARNESS_KEY, affinityOf, cacheHints } from "../src/step.js";
import type { CacheDiagnostics } from "../src/fingerprint.js";
import type { CacheHint } from "../src/policy.js";

const call = (messages: string[], system = "sys"): ProviderCall => ({ model: "anthropic/claude-sonnet-5", system, messages: messages.map((content) => ({ role: "user" as const, content })), tools: [], params: {} });

const ctx = (c: ProviderCall, harness: Record<string, unknown> = {}, config: Record<string, unknown> = {}): PackageStepContext =>
  ({ session: { id: "s1", user: "alice" }, turn: { id: "t1", input: [] }, conversation: c.messages, call: c, harness, packages: { has: () => false, get: () => undefined, list: () => [] }, env: {} as never, config, emit: () => {}, signal: new AbortController().signal }) as PackageStepContext;

test("fingerprint diagnosis: prefix kept, rewritten, truncated, head changed", () => {
  const a = fingerprint(call(["1", "2"]));
  assert.equal(diagnose(undefined, a), undefined);
  assert.equal(diagnose(a, fingerprint(call(["1", "2", "3"]))), undefined, "appending keeps the prefix");
  assert.deepEqual(diagnose(a, fingerprint(call(["1", "x", "3"]))), { kind: "rewrite", at: 1 });
  assert.deepEqual(diagnose(a, fingerprint(call(["1"]))), { kind: "truncate", at: 1 });
  assert.deepEqual(diagnose(a, fingerprint(call(["1", "2"], "other"))), { kind: "head" });
});

test("the step attaches a policy hint and records diagnostics in the harness", async () => {
  const first = (await cacheHints(ctx(call(["hello"]))))!;
  const hint = first.call!.hints!.cache as CacheHint;
  assert.equal(hint.strategy, undefined, "an unconfigured step advises nothing about the strategy");
  assert.equal(hint.affinity, affinityOf("alice"));
  assert.notEqual(hint.affinity, "thetis:alice", "the user id is not spelled out");
  const diag = first.harness![HARNESS_KEY] as CacheDiagnostics;
  assert.equal(diag.turns, 1);
  assert.equal(diag.divergences, 0);

  const second = (await cacheHints(ctx(call(["hello", "again"]), first.harness!)))!;
  const d2 = second.harness![HARNESS_KEY] as CacheDiagnostics;
  assert.equal(d2.turns, 2);
  assert.equal(d2.divergences, 0);

  const third = (await cacheHints(ctx(call(["changed", "again"]), second.harness!)))!;
  const d3 = third.harness![HARNESS_KEY] as CacheDiagnostics;
  assert.equal(d3.divergences, 1);
  assert.deepEqual(d3.last, { kind: "rewrite", at: 0, turn: 3 });
});

test("diagnostics and affinity can be turned off; other hints survive", async () => {
  const c = { ...call(["x"]), hints: { other: 1 } };
  const r = (await cacheHints(ctx(c, { keep: true }, { diagnostics: false, affinity: false })))!;
  assert.equal(r.harness, undefined);
  assert.equal(r.call!.hints!.other, 1);
  assert.equal((r.call!.hints!.cache as CacheHint).affinity, undefined);
});
