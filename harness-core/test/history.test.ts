import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, PackageStepContext } from "@thetis/contracts";
import { trimHistory } from "../src/index.js";

const msg = (i: number): Message => (i % 3 === 0 ? { role: "user", content: `u${i}` } : i % 3 === 1 ? { role: "assistant", content: `a${i}` } : { role: "tool", content: `t${i}`, toolCallId: `c${i}`, name: "x" });
const conv = (n: number) => Array.from({ length: n }, (_, i) => msg(i));
const ctx = (conversation: Message[], harness: Record<string, unknown> = {}, config: Record<string, unknown> = {}): PackageStepContext =>
  ({ session: { id: "s", user: "u" }, turn: { id: "t", input: [] }, conversation, call: { model: "m", messages: [], tools: [], params: {} }, harness, packages: { has: () => false, get: () => undefined, list: () => [] }, env: {} as never, config }) as PackageStepContext;

test("a short conversation is sent whole and the harness is untouched", async () => {
  const r = (await trimHistory(ctx(conv(10), {}, { historyWindow: 12 })))!;
  assert.equal(r.call!.messages.length, 10);
  assert.equal(r.harness, undefined);
});

test("the cut moves only when the window overflows, and then jumps", async () => {
  const cfg = { historyWindow: 12, historyKeep: 0.5 };
  const first = (await trimHistory(ctx(conv(13), {}, cfg)))!;
  const cut = (first.harness!["@thetis/harness-core"] as { cut: number }).cut;
  assert.equal(conv(13)[cut].role, "user", "the cut lands on a user message");
  assert.ok(cut >= 13 - 6 && cut <= 13 - 4, `cut ${cut} leaves about half the window`);
  assert.equal(first.call!.messages[0].content, `u${cut}`);

  // Grown to exactly a full window: the prefix is byte-identical and the cut holds.
  const second = (await trimHistory(ctx(conv(cut + 12), first.harness!, cfg)))!;
  assert.equal(second.harness, undefined);
  assert.equal(second.call!.messages[0].content, `u${cut}`);
  assert.deepEqual(second.call!.messages.slice(0, first.call!.messages.length), first.call!.messages, "the previous call is a prefix of this one");

  // One more message overflows the window: the cut jumps forward again.
  const third = (await trimHistory(ctx(conv(cut + 13), first.harness!, cfg)))!;
  const cut3 = (third.harness!["@thetis/harness-core"] as { cut: number }).cut;
  assert.ok(cut3 > cut, "the cut only moves forward");
});

test("a stale cut beyond the conversation is ignored", async () => {
  const r = (await trimHistory(ctx(conv(5), { "@thetis/harness-core": { cut: 99 } }, { historyWindow: 80 })))!;
  assert.equal(r.call!.messages.length, 5);
});
