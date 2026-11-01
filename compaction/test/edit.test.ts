// An edit (harness-core's rewind) replaces the tail of the record under a saved state. The step resets when
// the cut lies at or past the new end, or when the message before the cut is no longer the one compacted
// over (the anchor); an ordinary turn that only appends keeps the summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contentText, textContent } from "@thetis/runtime/lib/content";
import type { Message } from "@thetis/runtime/contracts";
import { compact, messageHash, editedUnder } from "../src/index.js";
import { conversationOf, dataOf, fakeEnv, fakeProvider, msg, phases, stateOf, stepCtx, summaryEvents, summarized } from "./fixtures.js";

test("messageHash is sha256 of the role, a newline and the message's text, as harness-core hashes it", () => {
  const m: Message = { role: "user", content: textContent("hello") };
  assert.equal(messageHash(m), createHash("sha256").update("user\nhello").digest("hex"));
  assert.match(messageHash(m), /^[0-9a-f]{64}$/);
  assert.equal(contentText(m.content), "hello");
});

test("a compaction writes the anchor: the hash of the message just before the cut", async () => {
  const conversation = conversationOf(10);
  const { ctx } = stepCtx({ conversation, env: fakeEnv({ provider: fakeProvider(summaryEvents()) }) });
  const state = stateOf((await compact(ctx)).harness);
  assert.equal(state.cut, 8);
  assert.equal(state.anchor, messageHash(conversation[7]));
});

test("an edit that leaves the cut at or past the end resets with trigger edit and sends the full history", async () => {
  const provider = fakeProvider(summaryEvents());
  // Six messages were summarized; the person edited message 3, so the record is now four long.
  const conversation = conversationOf(4);
  const { ctx, events } = stepCtx({ conversation, state: summarized(6, { anchor: "a".repeat(64) }), env: fakeEnv({ provider }) });
  const result = await compact(ctx);
  const state = stateOf(result.harness);
  assert.equal(state.cut, 0);
  assert.equal(state.summary, null);
  assert.equal(state.anchor, undefined);
  assert.deepEqual(state.ledger.at(-1), { at: state.projectedAt, kind: "reset", trigger: "edit", cut: 0, from: 6 });
  assert.deepEqual(result.call!.messages, conversation);
  assert.deepEqual(phases(events), ["reset"]);
  const data = dataOf(events[0]);
  assert.equal(data.trigger, "edit");
  assert.equal(data.from, 6);
  assert.equal(data.detail, "the conversation was edited inside the summarized part");
  assert.equal(provider.sent.length, 0, "below the trigger after the reset: nothing to summarize");
});

test("a cut exactly at the new end is a reset too", async () => {
  const { ctx, events } = stepCtx({ conversation: conversationOf(6), state: summarized(6) });
  const result = await compact(ctx);
  assert.equal(stateOf(result.harness).cut, 0);
  assert.deepEqual(phases(events), ["reset"]);
});

test("an anchor that no longer matches resets, though the record is long enough", async () => {
  const conversation = conversationOf(6);
  const state = summarized(4, { anchor: messageHash(conversation[3]) });
  const edited = [...conversation.slice(0, 3), msg(400, "assistant", { content: textContent("y".repeat(400)) }), ...conversation.slice(4)];
  assert.equal(editedUnder(edited, state), true);
  const { ctx, events } = stepCtx({ conversation: edited, state });
  const result = await compact(ctx);
  assert.equal(stateOf(result.harness).cut, 0);
  assert.deepEqual(phases(events), ["reset"]);
  assert.equal(dataOf(events[0]).trigger, "edit");
  assert.deepEqual(result.call!.messages, edited);
});

test("an ordinary turn that appends keeps the summary: the anchor matches and nothing is said", async () => {
  const provider = fakeProvider(summaryEvents());
  const first = stepCtx({ conversation: conversationOf(10), env: fakeEnv({ provider }) });
  const compacted = stateOf((await compact(first.ctx)).harness);
  const longer: Message[] = [...first.ctx.conversation, msg(40, "assistant"), msg(40, "user")];
  assert.equal(editedUnder(longer, compacted), false);
  const { ctx, events } = stepCtx({ conversation: longer, state: compacted, turn: "t2", env: fakeEnv({ provider }) });
  const result = await compact(ctx);
  assert.deepEqual(events, []);
  assert.deepEqual(stateOf(result.harness), compacted);
});

test("a state from before 0.3.1 has no anchor and is checked by the cut alone", async () => {
  const conversation = conversationOf(6);
  const { ctx, events } = stepCtx({ conversation, state: summarized(4) });
  const result = await compact(ctx);
  assert.equal(stateOf(result.harness).cut, 4);
  assert.deepEqual(events, []);
});
