import { test } from "node:test";
import assert from "node:assert/strict";
import { textContent } from "@thetis/runtime/lib/content";
import { estimate, boundaries, chooseCut, shed, dangling } from "../src/select.js";
import { note, project, projectedIndex } from "../src/project.js";
import { windowFor, measure, measureRound } from "../src/measure.js";
import { freshState } from "../src/schemas.js";
import { conversationOf, msg, summarized, textOf } from "./fixtures.js";

test("estimate counts every string a message carries, a quarter of the characters, rounded up", () => {
  assert.equal(estimate("abcd"), 1);
  assert.equal(estimate("abcde"), 2);
  assert.equal(estimate([msg(400)]), 100);
  assert.equal(estimate(conversationOf(10)), 1000, "one ceiling over the whole run, not one per message");
  const withCall = msg(0, "assistant", { toolCalls: [{ id: "c1", name: "exec", args: { cmd: "ls -la" } }] });
  assert.equal(estimate([withCall]), Math.ceil(("exec".length + JSON.stringify({ cmd: "ls -la" }).length) / 4));
  const toolResult: typeof withCall = { role: "tool", content: textContent("out"), toolCallId: "c1", name: "exec" };
  assert.equal(estimate([toolResult]), Math.ceil(("out".length + "exec".length) / 4));
  const asset = { role: "user" as const, content: [{ type: "asset", data: { id: "a1", mediaType: "image/png" } }] };
  assert.equal(estimate([asset]), Math.ceil(JSON.stringify({ id: "a1", mediaType: "image/png" }).length / 4), "a non-text part counts its JSON");
});

test("boundaries are every index after 0 that is not a tool message", () => {
  const c = [msg(1, "user"), msg(1, "assistant"), msg(1, "tool"), msg(1, "tool"), msg(1, "assistant"), msg(1, "user")];
  assert.deepEqual(boundaries(c), [1, 4, 5]);
  assert.deepEqual(boundaries([]), []);
  assert.deepEqual(boundaries([msg(1)]), []);
});

test("chooseCut keeps at least keepTokens after the cut and takes the latest boundary that does", () => {
  const c = conversationOf(10); // 100 tokens each
  assert.equal(chooseCut(c, 0, 200), 8, "messages 8 and 9 are the kept tail");
  assert.equal(chooseCut(c, 0, 250), 7, "a tail of 200 is not enough; one more message is kept");
  assert.equal(chooseCut(c, 0, 0), 9, "keepTokens 0 still keeps one message: the largest boundary is n-1");
  assert.equal(chooseCut(c, 0, 1000), undefined, "the whole conversation is the tail");
  assert.equal(chooseCut(c, 0, 901), undefined);
  assert.equal(chooseCut(c, 0, 900), 1);
});

test("chooseCut only moves forward from the old cut", () => {
  const c = conversationOf(10);
  assert.equal(chooseCut(c, 7, 200), 8);
  assert.equal(chooseCut(c, 8, 200), undefined, "nothing older than the kept tail lies past the old cut");
  assert.equal(chooseCut(c, 9, 0), undefined);
});

test("chooseCut never lands on a tool message", () => {
  const c = [msg(400, "user"), msg(400, "assistant", { toolCalls: [{ id: "c1", name: "t", args: {} }] }), { ...msg(400, "tool"), toolCallId: "c1" }, msg(400, "user"), msg(400, "assistant")];
  assert.equal(chooseCut(c, 0, 250), 1, "index 2 is a tool message; the cut steps back to the assistant that asked");
  assert.equal(chooseCut(c, 0, 150), 3);
});

test("shed is what the projection loses: the covered messages, plus the old note when there is one", () => {
  const c = conversationOf(10);
  assert.equal(shed(c, freshState(), 8), 800);
  const old = summarized(4);
  assert.equal(shed(c, old, 8), 400 + estimate([note(old)]));
});

test("dangling sees an assistant message whose tool calls have no results", () => {
  const ask = msg(1, "assistant", { toolCalls: [{ id: "c1", name: "t", args: {} }, { id: "c2", name: "t", args: {} }] });
  assert.equal(dangling([msg(1), ask]), true);
  assert.equal(dangling([msg(1), ask, { ...msg(1, "tool"), toolCallId: "c1" }]), true, "one of two answered");
  assert.equal(dangling([msg(1), ask, { ...msg(1, "tool"), toolCallId: "c1" }, { ...msg(1, "tool"), toolCallId: "c2" }]), false);
  assert.equal(dangling([msg(1), msg(1, "assistant")]), false);
  assert.equal(dangling([]), false);
});

test("project leaves the conversation alone until there is a summary, then puts one user-role note in front of the tail", () => {
  const c = conversationOf(6);
  const fresh = project(c, freshState());
  assert.deepEqual(fresh, c);
  assert.notEqual(fresh, c, "a copy, never the record itself");
  const state = summarized(4);
  const projected = project(c, state);
  assert.equal(projected.length, 3);
  assert.equal(projected[0].role, "user");
  const text = textOf(projected[0]);
  assert.match(text, /^\[Context compacted: the first 4 messages of this conversation are summarized below\. The full record is kept; nothing was deleted, and later messages are sent exactly as they were\.\]\n\nold summary$/);
  assert.equal(projected[1], c[4]);
  assert.equal(projected[2], c[5]);
  assert.deepEqual(project(c, { cut: 4, summary: null }), c, "a cut without a summary projects nothing");
});

test("projectedIndex maps a conversation index onto the projection", () => {
  assert.equal(projectedIndex(freshState(), 8), 8);
  assert.equal(projectedIndex(summarized(4), 8), 5, "the note plus messages 4..7");
  assert.equal(projectedIndex(summarized(4), 4), 1);
});

test("windowFor prefers the longest configured prefix, then the descriptor, then the default", () => {
  const config = { window: 200_000, windows: { "anthropic/": 400_000, "anthropic/claude-opus": 300_000 } };
  const descriptors = [{ id: "anthropic/claude-opus-4", contextLength: 1_000_000 }, { id: "openai/gpt", contextLength: 128_000 }, { id: "bare" }];
  assert.equal(windowFor("anthropic/claude-opus-4", config, descriptors), 300_000, "the longest key wins, over the descriptor");
  assert.equal(windowFor("anthropic/claude-sonnet", config, descriptors), 400_000);
  assert.equal(windowFor("openai/gpt", config, descriptors), 128_000);
  assert.equal(windowFor("bare", config, descriptors), 200_000, "a descriptor without contextLength falls through");
  assert.equal(windowFor("unknown", config, []), 200_000);
});

test("measure trusts the provider count only when it describes the current projection", () => {
  const c = conversationOf(10);
  const state = summarized(4);
  const projected = project(c, state);
  const fresh = { model: "vendor/model", messages: 5, at: "2026-09-25T12:04:00.000Z", usage: { prompt_tokens: 5000 } };
  assert.deepEqual(measure(projected, "vendor/model", state, fresh), { used: 5000 + 200, estimated: false, usedAt: fresh.at }, "the two messages it did not see are estimated");
  const stale = { ...fresh, at: "2026-09-25T12:02:00.000Z" };
  assert.deepEqual(measure(projected, "vendor/model", state, stale), { used: estimate(projected), estimated: true }, "a count from before the compaction is discarded");
  assert.equal(measure(projected, "other/model", state, fresh).estimated, true, "another model's count says nothing about this one");
  assert.equal(measure(projected, "vendor/model", state, { ...fresh, usage: {} }).estimated, true);
  assert.equal(measure(projected, "vendor/model", state, { ...fresh, messages: 9 }).estimated, true, "more messages than the projection has: not this projection");
  assert.equal(measure(projected, "vendor/model", state, undefined).estimated, true);
  const reset = { ...freshState(), projectedAt: "2026-09-25T12:05:00.000Z" };
  assert.equal(measure(c, "vendor/model", reset, fresh).estimated, true, "a reset changes the projection as much as a compaction does");
});

test("measureRound adds what the loop appended since the priced request", () => {
  const messages = conversationOf(6);
  assert.deepEqual(measureRound(messages, { prompt_tokens: 700 }, 4), { used: 900, estimated: false });
  assert.deepEqual(measureRound(messages, undefined, 4), { used: 600, estimated: true });
  assert.deepEqual(measureRound(messages, { prompt_tokens: 700 }, 9), { used: 600, estimated: true }, "a priced count larger than the list is not about this list");
});
