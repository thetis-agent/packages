import { test } from "node:test";
import assert from "node:assert/strict";
import { uiState, uiRequest, uiReset, fmtTokens, sentenceFor } from "../src/index.js";
import { freshState, type StateView } from "../src/schemas.js";
import { conversationOf, fakeEnv, MemoryStore, summarized, uiEnv } from "./fixtures.js";

function record(over: Record<string, unknown> = {}) {
  return { id: "s1", user: "alice", createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T12:00:00.000Z", turns: 3, conversation: conversationOf(4), harness: {}, status: "idle", ...over };
}

async function view(env: Parameters<typeof uiState>[1], args: Record<string, unknown> = {}): Promise<StateView> {
  const answer = (await uiState(args, env)) as { data: StateView };
  return answer.data;
}

test("uiState reads the record and answers the idle sentence with the percentages", async () => {
  const inspect = async () => record();
  const v = await view(uiEnv(fakeEnv({ inspect })));
  assert.equal(v.enabled, true);
  assert.equal(v.model, "vendor/model", "the fence's default model when no call was made yet");
  assert.equal(v.window, 1000);
  assert.equal(v.trigger, 750);
  assert.equal(v.used, 400);
  assert.equal(v.estimated, true);
  assert.equal(v.pending, null);
  assert.equal(v.status, "idle");
  assert.equal(v.turns, 3);
  assert.deepEqual(v.state, freshState());
  assert.equal(v.sentence, "Auto compaction is on; the conversation is at 40% of the window and compacts at 75%.");
});

test("uiState uses the last call's model and count when they describe the projection", async () => {
  const lastCall = { model: "anthropic/x", messages: 4, at: "2026-09-25T12:00:00.000Z", usage: { prompt_tokens: 350 } };
  const inspect = async () => record({ harness: { "@thetis/harness-core": { lastCall } } });
  const v = await view(uiEnv(fakeEnv({ inspect }), { windows: { "anthropic/": 700 } }));
  assert.equal(v.model, "anthropic/x");
  assert.equal(v.window, 700);
  assert.deepEqual([v.used, v.estimated, v.usedAt], [350, false, lastCall.at]);
  assert.equal(v.sentence, "Auto compaction is on; the conversation is at 50% of the window and compacts at 75%.");
});

test("uiState describes a summarized conversation, a pause, a pending request and the setting being off", async () => {
  const state = summarized(84, { compactions: 2, last: { ...summarized(84).last!, tokensBefore: 730_000, tokensAfter: 21_000, cost: 0.41 } });
  const clock = new Date(state.last!.at);
  const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  const inspect = async () => record({ conversation: conversationOf(90), harness: { "@thetis/compaction": state } });
  assert.equal((await view(uiEnv(fakeEnv({ inspect })))).sentence, `84 messages are summarized (compacted 2 times, last ${hhmm}, auto, 730k → 21k tokens, $0.41).`);

  const paused = summarized(84, { failures: 3, lastFailure: { at: state.last!.at, reason: "boom" } });
  const inspectPaused = async () => record({ harness: { "@thetis/compaction": paused } });
  assert.equal((await view(uiEnv(fakeEnv({ inspect: inspectPaused })))).sentence, "Auto compaction is paused after 3 failed attempts: boom. Request a compaction to try again.");

  const store = new MemoryStore();
  await store.set("s1", { at: "2026-09-25T12:30:00.000Z", instructions: "x" });
  const pending = await view(uiEnv(fakeEnv({ inspect, store })));
  assert.deepEqual(pending.pending, { at: "2026-09-25T12:30:00.000Z", instructions: "x" });
  assert.equal(pending.sentence, "A compaction is requested and runs at the start of the next message.");

  assert.equal((await view(uiEnv(fakeEnv({ inspect }), { enabled: false }))).sentence, "Auto compaction is off for this package (Control panel → Packages → compaction); the existing summary is still sent.");
  assert.equal((await view(uiEnv(fakeEnv({ inspect: async () => record() }), { enabled: false }))).sentence, "Auto compaction is off for this package (Control panel → Packages → compaction).");
});

test("uiState copes with a fence that has no storage", async () => {
  const v = await view(uiEnv(fakeEnv({ inspect: async () => record(), store: () => { throw new Error("no storage"); } })));
  assert.equal(v.pending, null);
});

test("uiState needs a conversation and takes it from the args or the env", async () => {
  const asked: string[] = [];
  const inspect = async (session: string) => { asked.push(session); return record({ id: session }); };
  await view(uiEnv(fakeEnv({ inspect }), {}, null), { session: "s9" });
  await view(uiEnv(fakeEnv({ inspect }), {}, "s1"));
  assert.deepEqual(asked, ["s9", "s1"]);
  await assert.rejects(view(uiEnv(fakeEnv({ inspect }), {}, null)), /no conversation is open/);
});

test("uiRequest and uiReset write the pending request, each replacing the other", async () => {
  const store = new MemoryStore();
  const env = uiEnv(fakeEnv({ store }));
  const asked = (await uiRequest({ instructions: "  keep the file list  " }, env)) as { data: { pending: Record<string, unknown> } };
  assert.equal(asked.data.pending.instructions, "keep the file list");
  assert.equal(new Date(asked.data.pending.at as string).toISOString(), asked.data.pending.at);
  assert.deepEqual(await store.get("s1"), asked.data.pending);

  const reset = (await uiReset({}, env)) as { data: { pending: Record<string, unknown> } };
  assert.equal(reset.data.pending.reset, true);
  assert.equal(reset.data.pending.instructions, undefined);
  assert.deepEqual(await store.get("s1"), reset.data.pending);

  const plain = (await uiRequest({}, env)) as { data: { pending: Record<string, unknown> } };
  assert.equal(plain.data.pending.reset, undefined, "a request replaces the reset");
  assert.equal("instructions" in plain.data.pending, false, "no empty focus is stored");
  await assert.rejects(uiRequest({ instructions: "x".repeat(5000) }, env), /invalid request/);
  await assert.rejects(uiRequest({}, uiEnv(fakeEnv({ store }), {}, null)), /no conversation is open/);
});

test("fmtTokens and sentenceFor read as a person would", () => {
  assert.deepEqual([fmtTokens(850), fmtTokens(21_000), fmtTokens(730_400), fmtTokens(1_200_000), fmtTokens(1_000_000)], ["850", "21k", "730k", "1.2M", "1M"]);
  const base: Omit<StateView, "sentence"> = { enabled: true, model: "m", window: 1000, threshold: 0.75, trigger: 750, used: 140, estimated: true, state: freshState(), pending: null, status: "idle", turns: 1 };
  assert.equal(sentenceFor({ ...base, pending: { at: "x", reset: true } }, { maxFailures: 3 }), "The full history is sent again from the start of the next message.");
  assert.equal(sentenceFor({ ...base, state: summarized(4) }, { maxFailures: 3 }).startsWith("4 messages are summarized (compacted once, last "), true);
  assert.equal(sentenceFor({ ...base, state: { ...freshState(), failures: 3 } }, { maxFailures: 3 }), "Auto compaction is paused after 3 failed attempts: no reason recorded. Request a compaction to try again.");
  assert.equal(sentenceFor({ ...base, state: { ...freshState(), failures: 3 } }, { maxFailures: 5 }), "Auto compaction is on; the conversation is at 14% of the window and compacts at 75%.");
});
