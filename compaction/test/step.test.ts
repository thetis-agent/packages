import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderCall, ProviderEvent } from "@thetis/runtime/contracts";
import { compact, beforeRound, SUMMARY_INSTRUCTIONS, NAME } from "../src/index.js";
import { note, project } from "../src/project.js";
import { estimate } from "../src/select.js";
import { freshState, type CompactionState, type RoundHookArgs } from "../src/schemas.js";
import { conversationOf, dataOf, fakeEnv, fakeProvider, MemoryStore, phases, stateOf, stepCtx, summaryEvents, summarized, textOf, toolEnv } from "./fixtures.js";

const textAt = (call: ProviderCall, i: number): string => textOf(call.messages.at(i)!);

test("below the trigger the step sets only the projection and the hint, and the state is unchanged", async () => {
  const provider = fakeProvider(summaryEvents());
  const { ctx, events } = stepCtx({ conversation: conversationOf(4), env: fakeEnv({ provider }) }); // 400 of 1000; trigger 750
  const before = JSON.stringify(ctx);
  const result = await compact(ctx);
  assert.equal(JSON.stringify(ctx), before, "the context is not mutated");
  assert.deepEqual(result.call!.messages, ctx.conversation);
  assert.deepEqual(result.call!.hints, { cache: { affinity: "thetis:abc" }, beforeRound: { package: NAME, export: "beforeRound" } });
  assert.equal(result.call!.system, "You are Thetis.");
  assert.deepEqual(result.harness![NAME], freshState());
  assert.deepEqual(result.harness!["@thetis/prompt-cache"], { turns: 3 }, "other keys survive");
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(events, [], "nothing to say: below the trigger is not an event");
});

test("above the trigger the step summarizes the prefix through the same system, tools and hints, and projects the result", async () => {
  const provider = fakeProvider(summaryEvents());
  const conversation = conversationOf(10); // 1000 tokens; cut 8 keeps 200
  const { ctx, events } = stepCtx({ conversation, env: fakeEnv({ provider }) });
  const before = JSON.stringify(ctx);
  const result = await compact(ctx);
  assert.equal(JSON.stringify(ctx), before);

  assert.equal(provider.sent.length, 1);
  const sent = provider.sent[0].call;
  assert.equal(sent.model, "vendor/model");
  assert.equal(sent.system, "You are Thetis.");
  assert.deepEqual(sent.tools, ctx.call.tools);
  assert.deepEqual(sent.params, { temperature: 0, max_tokens: 16000, tool_choice: "none" });
  assert.deepEqual(sent.hints, { cache: { affinity: "thetis:abc" }, context: false });
  assert.equal(sent.messages.length, 9, "the 8 summarized messages and the instructions");
  assert.deepEqual(sent.messages.slice(0, 8), conversation.slice(0, 8));
  assert.equal(sent.messages[8].role, "user");
  assert.equal(textAt(sent, 8), SUMMARY_INSTRUCTIONS);
  assert.ok(provider.sent[0].signal instanceof AbortSignal, "the request is bounded");

  const state = stateOf(result.harness);
  assert.equal(state.cut, 8);
  assert.equal(state.summary, "short");
  assert.equal(state.compactions, 1);
  assert.equal(state.failures, 0);
  assert.equal(state.projectedAt, state.last!.at);
  const expectedAfter = estimate([note(state), ...conversation.slice(8)]);
  const { at, ms, ...last } = state.last!;
  assert.deepEqual(last, { turn: "t1", round: 1, cut: 8, from: 0, tokensBefore: 1000, tokensAfter: expectedAfter, cost: 0.01, model: "vendor/model", messages: 8, trigger: "auto" });
  assert.equal(new Date(at).toISOString(), at);
  assert.ok(ms >= 0);
  assert.equal(state.ledger.length, 1);
  assert.deepEqual(state.ledger[0], { at, kind: "compact", trigger: "auto", cut: 8, from: 0, tokensBefore: 1000, tokensAfter: expectedAfter, model: "vendor/model", cost: 0.01 });

  assert.deepEqual(result.call!.messages, [note(state), conversation[8], conversation[9]]);
  assert.deepEqual(result.call!.hints!.beforeRound, { package: NAME, export: "beforeRound" });
  assert.deepEqual(phases(events), ["planning", "summarizing", "finished"]);
  const finished = dataOf(events[2]);
  assert.equal(finished.trigger, "auto");
  assert.equal(finished.used, 1000);
  assert.equal(finished.window, 1000);
  assert.equal(finished.threshold, 0.75);
  assert.equal(finished.cut, 8);
  assert.equal(finished.messages, 8);
  assert.equal(finished.tokensAfter, expectedAfter);
  assert.equal(finished.cost, 0.01);
});

test("a re-compaction sends the old note and the middle, and rewrites the summary instead of stacking one", async () => {
  const provider = fakeProvider(summaryEvents("<summary>newer</summary>"));
  const conversation = conversationOf(12);
  const old = summarized(4);
  const { ctx } = stepCtx({ conversation, state: old, env: fakeEnv({ provider }) });
  const result = await compact(ctx);
  const sent = provider.sent[0].call;
  assert.deepEqual(sent.messages.slice(0, -1), [note(old), ...conversation.slice(4, 10)]);
  const state = stateOf(result.harness);
  assert.equal(state.cut, 10);
  assert.equal(state.summary, "newer");
  assert.equal(state.compactions, 2);
  assert.equal(state.last!.from, 4);
  assert.equal(state.last!.messages, 6);
  assert.equal(state.ledger.length, 2);
  assert.deepEqual(result.call!.messages, [note(state), conversation[10], conversation[11]]);
});

const failureCases: Array<{ name: string; events: ProviderEvent[]; reason: RegExp }> = [
  { name: "a provider error", events: [{ type: "error", message: "boom" }], reason: /^boom$/ },
  { name: "an empty answer", events: [{ type: "text", delta: "  <summary> </summary> " }], reason: /no summary text/ },
  { name: "a tool call", events: [{ type: "text", delta: "let me look" }, { type: "tool_call", call: { id: "c", name: "greet", args: {} } }], reason: /called a tool/ },
  { name: "a summary no smaller than what it replaces", events: summaryEvents(`<summary>${"y".repeat(3200)}</summary>`), reason: /not smaller/ },
];
for (const c of failureCases) {
  test(`${c.name} is a failure: state kept, failures counted, a failed event and a ledger row`, async () => {
    const provider = fakeProvider(c.events);
    const old = summarized(2, { failures: 1 });
    const conversation = conversationOf(10);
    const { ctx, events } = stepCtx({ conversation, state: old, env: fakeEnv({ provider }) });
    const result = await compact(ctx);
    const state = stateOf(result.harness);
    assert.equal(state.cut, 2);
    assert.equal(state.summary, "old summary");
    assert.equal(state.failures, 2);
    assert.match(state.lastFailure!.reason, c.reason);
    const row = state.ledger.at(-1)!;
    assert.equal(row.kind, "failed");
    assert.equal(row.cut, 8);
    assert.equal(row.from, 2);
    assert.match(row.reason!, c.reason);
    assert.deepEqual(phases(events), ["planning", "summarizing", "failed"]);
    assert.match(String(dataOf(events[2]).detail), c.reason);
    assert.deepEqual(result.call!.messages, project(conversation, old), "the old projection is still what is sent");
  });
}

test("a summary that takes too long is abandoned through the signal and counted as a failure", async () => {
  const seen: AbortSignal[] = [];
  const provider = async (_call: ProviderCall, _on: (e: ProviderEvent) => void, signal?: AbortSignal) => {
    seen.push(signal!);
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
  };
  const { ctx, events } = stepCtx({ env: fakeEnv({ provider }), config: { summaryTimeoutMs: 20 } });
  const result = await compact(ctx);
  assert.equal(seen[0].aborted, true, "the provider was told to stop");
  const state = stateOf(result.harness);
  assert.equal(state.failures, 1);
  assert.match(state.lastFailure!.reason, /no summary within/);
  assert.deepEqual(phases(events), ["planning", "summarizing", "failed"]);
});

test("a provider that ignores the signal cannot hold the step past the timeout", async () => {
  const provider = () => new Promise<void>(() => {});
  const { ctx } = stepCtx({ env: fakeEnv({ provider }), config: { summaryTimeoutMs: 20 } });
  const result = await compact(ctx);
  assert.match(stateOf(result.harness).lastFailure!.reason, /no summary within/);
});

test("after maxFailures auto compaction pauses: a skipped event, no request", async () => {
  const provider = fakeProvider(summaryEvents());
  const paused = summarized(2, { failures: 3, lastFailure: { at: "2026-09-25T12:10:00.000Z", reason: "boom" } });
  const { ctx, events } = stepCtx({ state: paused, env: fakeEnv({ provider }) });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(phases(events), ["skipped"]);
  assert.match(String(dataOf(events[0]).detail), /paused after 3 failed attempts/);
  assert.deepEqual(stateOf(result.harness), paused);
});

test("a shed smaller than minShedTokens is not worth breaking the cache for", async () => {
  const provider = fakeProvider(summaryEvents());
  const { ctx, events } = stepCtx({ state: summarized(7), env: fakeEnv({ provider }), config: { minShedTokens: 500 } });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(events, []);
  assert.equal(stateOf(result.harness).cut, 7);
});

test("a stale provider count falls back to the estimate, and a fresh one is trusted", async () => {
  const provider = fakeProvider(summaryEvents());
  const state = summarized(2); // projectedAt 12:03
  const small = conversationOf(5); // 300 tokens projected: below the trigger by estimate
  const stale = { model: "vendor/model", messages: 2, at: "2026-09-25T12:00:00.000Z", usage: { prompt_tokens: 5000 } };
  const s1 = stepCtx({ conversation: small, state, env: fakeEnv({ provider }), harness: { "@thetis/harness-core": { lastCall: stale } } });
  await compact(s1.ctx);
  assert.equal(provider.sent.length, 0, "5000 came from before the compaction; the estimate says 300");

  const fresh = { ...stale, at: "2026-09-25T12:04:00.000Z" };
  const s2 = stepCtx({ conversation: small, state, env: fakeEnv({ provider }), harness: { "@thetis/harness-core": { lastCall: fresh } }, config: { keepTokens: 100, minShedTokens: 0 } });
  const result = await compact(s2.ctx);
  assert.equal(provider.sent.length, 1, "the provider's count is what triggers it");
  assert.equal(stateOf(result.harness).last!.tokensBefore, 5000 + 200);
});

test("a manual request compacts below the trigger with the focus appended, ignores minShed, and is consumed", async () => {
  const provider = fakeProvider(summaryEvents());
  const store = new MemoryStore();
  await store.set("s1", { at: "2026-09-25T12:00:00.000Z", instructions: "keep the file list" });
  const { ctx, events } = stepCtx({ conversation: conversationOf(4), env: fakeEnv({ provider, store }), config: { minShedTokens: 100_000, keepTokens: 100 } });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 1);
  assert.equal(textAt(provider.sent[0].call, -1), `${SUMMARY_INSTRUCTIONS}\n\nAdditional focus from the person: keep the file list`);
  const state = stateOf(result.harness);
  assert.equal(state.cut, 3);
  assert.equal(state.last!.trigger, "manual");
  assert.equal(await store.get("s1"), undefined, "consumed");
  assert.equal(dataOf(events[0]).trigger, "manual");
});

test("a manual request that finds nothing to summarize says so with a skipped event and is still consumed", async () => {
  const provider = fakeProvider(summaryEvents());
  const store = new MemoryStore();
  await store.set("s1", { at: "2026-09-25T12:00:00.000Z" });
  const { ctx, events } = stepCtx({ conversation: conversationOf(2), env: fakeEnv({ provider, store }) });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(phases(events), ["skipped"]);
  assert.match(String(dataOf(events[0]).detail), /nothing older than the kept tail/);
  assert.equal(stateOf(result.harness).failures, 0, "not the model's fault");
  assert.equal(await store.get("s1"), undefined);
});

test("a manual success resets the failure counter of a paused conversation", async () => {
  const provider = fakeProvider(summaryEvents());
  const store = new MemoryStore();
  await store.set("s1", { at: "2026-09-25T12:00:00.000Z" });
  const { ctx } = stepCtx({ state: summarized(2, { failures: 3 }), env: fakeEnv({ provider, store }) });
  const result = await compact(ctx);
  assert.equal(stateOf(result.harness).failures, 0);
  assert.equal(stateOf(result.harness).cut, 8);
});

test("a reset clears the summary, keeps a ledger row, emits reset, sends the full history and is consumed", async () => {
  const provider = fakeProvider(summaryEvents());
  const store = new MemoryStore();
  await store.set("s1", { at: "2026-09-25T12:00:00.000Z", reset: true });
  const conversation = conversationOf(4);
  const { ctx, events } = stepCtx({ conversation, state: summarized(2, { failures: 3 }), env: fakeEnv({ provider, store }) });
  const result = await compact(ctx);
  const state = stateOf(result.harness);
  assert.equal(state.cut, 0);
  assert.equal(state.summary, null);
  assert.equal(state.failures, 0);
  assert.equal(state.last, undefined);
  assert.equal(state.compactions, 1, "history is kept");
  assert.deepEqual(state.ledger.at(-1), { at: state.projectedAt, kind: "reset", trigger: "manual", cut: 0, from: 2 });
  assert.deepEqual(result.call!.messages, conversation);
  assert.deepEqual(phases(events), ["reset"]);
  assert.equal(dataOf(events[0]).from, 2);
  assert.equal(await store.get("s1"), undefined);
});

test("a reset on a conversation over the trigger still sends the full history this turn; auto compaction waits for the next", async () => {
  const provider = fakeProvider(summaryEvents("<summary>fresh</summary>"));
  const store = new MemoryStore();
  await store.set("s1", { at: "2026-09-25T12:00:00.000Z", reset: true });
  const { ctx, events } = stepCtx({ conversation: conversationOf(10), state: summarized(6), env: fakeEnv({ provider, store }) });
  const result = await compact(ctx);
  assert.deepEqual(phases(events), ["reset"], "the person asked for the full history: it goes out at least once");
  assert.equal(provider.sent.length, 0, "no summary request in the reset's own turn");
  assert.deepEqual(result.call!.messages, ctx.conversation);
  assert.equal(stateOf(result.harness).summary, null);
  // The next turn is an ordinary one: over the trigger, it compacts from the record rather than from the old note.
  const again = stepCtx({ conversation: conversationOf(10), state: stateOf(result.harness), env: fakeEnv({ provider, store }) });
  const second = await compact(again.ctx);
  assert.deepEqual(phases(again.events), ["planning", "summarizing", "finished"]);
  assert.deepEqual(provider.sent[0].call.messages.slice(0, 8), again.ctx.conversation.slice(0, 8), "summarized from the record, not from the old note");
  assert.equal(stateOf(second.harness).summary, "fresh");
});

test("with enabled false an existing summary is still projected, no hint is set and nothing runs", async () => {
  const provider = fakeProvider(summaryEvents());
  const conversation = conversationOf(10);
  const state = summarized(6);
  const { ctx, events } = stepCtx({ conversation, state, env: fakeEnv({ provider }), config: { enabled: false } });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(result.call!.messages, project(conversation, state));
  assert.deepEqual(result.call!.hints, { cache: { affinity: "thetis:abc" } }, "no beforeRound");
  assert.deepEqual(stateOf(result.harness), state);
});

test("a fence without storage, and a kernel without models, are not errors", async () => {
  const provider = fakeProvider(summaryEvents());
  const env = fakeEnv({ provider, store: () => { throw new Error("no storage in this fence"); }, models: async () => { throw new Error("no models"); } });
  const { ctx } = stepCtx({ conversation: conversationOf(10), env });
  const result = await compact(ctx);
  assert.equal(stateOf(result.harness).cut, 8, "the configured window of 1000 applied");
});

test("the window comes from the descriptor when it is under the configured ceiling and configuration does not name the model", async () => {
  const provider = fakeProvider(summaryEvents());
  const env = fakeEnv({ provider, models: { model: "vendor/model", models: [{ id: "vendor/model", contextLength: 100_000 }] } });
  const { ctx } = stepCtx({ conversation: conversationOf(10), env, config: { window: 1_000_000 } });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 0, "1000 of 100k is nowhere near the trigger");
  assert.equal(stateOf(result.harness).cut, 0);
});

test("a descriptor larger than the configured window is capped to it: the configuration page's number is the one compaction works to", async () => {
  const provider = fakeProvider(summaryEvents());
  const env = fakeEnv({ provider, models: { model: "vendor/model", models: [{ id: "vendor/model", contextLength: 1_000_000 }] } });
  const { ctx } = stepCtx({ conversation: conversationOf(10), env, config: { window: 1000 } });
  const result = await compact(ctx);
  assert.equal(provider.sent.length, 1, "1000 tokens of a 1000-token ceiling is over the trigger, whatever the model reports");
  assert.ok(stateOf(result.harness).cut > 0);
});

test("a dangling tool call in the conversation is never summarized over", async () => {
  const provider = fakeProvider(summaryEvents());
  const conversation = [...conversationOf(9), { ...conversationOf(1)[0], role: "assistant" as const, toolCalls: [{ id: "c1", name: "greet", args: {} }] }];
  const { ctx } = stepCtx({ conversation, env: fakeEnv({ provider }) });
  await compact(ctx);
  assert.equal(provider.sent.length, 0);
});

// ---- the round hook ---------------------------------------------------------------------------------------

function hookArgs(over: Partial<RoundHookArgs> & { state?: CompactionState } = {}): { args: RoundHookArgs; events: import("@thetis/runtime/contracts").TurnEvent[] } {
  const events: import("@thetis/runtime/contracts").TurnEvent[] = [];
  const conversation = over.conversation ?? conversationOf(10);
  const { state, ...rest } = over;
  const args: RoundHookArgs = {
    conversation,
    call: { model: "vendor/model", system: "You are Thetis.", messages: project(conversation, state ?? freshState()), tools: [], params: {}, hints: { cache: {} } },
    harness: { "@thetis/prompt-cache": { turns: 3 }, ...(state ? { [NAME]: state } : {}) },
    round: 2,
    usage: { prompt_tokens: 700 },
    priced: 8,
    turn: { id: "t1" },
    emit: (e) => events.push(e),
    ...rest,
  };
  return { args, events };
}

test("beforeRound measures usage plus what was appended since, compacts, and answers with the projection and harness", async () => {
  const provider = fakeProvider(summaryEvents());
  const { args, events } = hookArgs(); // 700 + 2 × 100 = 900 ≥ 750
  const before = JSON.stringify({ conversation: args.conversation, call: args.call, harness: args.harness });
  const result = await beforeRound(args, toolEnv(fakeEnv({ provider })));
  assert.equal(JSON.stringify({ conversation: args.conversation, call: args.call, harness: args.harness }), before, "the live variables are not mutated in place");
  assert.equal(provider.sent.length, 1);
  assert.deepEqual(provider.sent[0].call.messages.slice(0, 8), args.conversation.slice(0, 8));
  const state = stateOf(result!.harness);
  assert.equal(state.cut, 8);
  assert.equal(state.last!.round, 2);
  assert.equal(state.last!.tokensBefore, 900);
  assert.deepEqual(result!.call!.messages, [note(state), ...args.conversation.slice(8)]);
  assert.deepEqual(result!.harness!["@thetis/prompt-cache"], { turns: 3 });
  assert.deepEqual(phases(events), ["planning", "summarizing", "finished"]);
});

test("beforeRound answers nothing when there is nothing to do", async () => {
  const provider = fakeProvider(summaryEvents());
  const { args, events } = hookArgs({ usage: { prompt_tokens: 100 } });
  assert.equal(await beforeRound(args, toolEnv(fakeEnv({ provider }))), undefined);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(events, []);
});

test("beforeRound refuses to thrash: a compaction fewer than 3 rounds ago in this turn is a counted skip", async () => {
  const provider = fakeProvider(summaryEvents());
  const state = summarized(6, { last: { ...summarized(6).last!, turn: "t1", round: 1 } });
  const { args, events } = hookArgs({ state, round: 2, usage: { prompt_tokens: 900 }, priced: 5 });
  const result = await beforeRound(args, toolEnv(fakeEnv({ provider })));
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(phases(events), ["skipped"]);
  assert.match(String(dataOf(events[0]).detail), /compacted 1 round ago; refusing to thrash/);
  const next = stateOf(result!.harness);
  assert.equal(next.failures, 1);
  assert.equal(next.cut, 6);
  assert.deepEqual(result!.call!.messages, project(args.conversation, next));

  const later = hookArgs({ state, round: 4, usage: { prompt_tokens: 900 }, priced: 5 });
  await beforeRound(later.args, toolEnv(fakeEnv({ provider })));
  assert.equal(provider.sent.length, 1, "three rounds later it may compact again");
});

test("beforeRound never throws", async () => {
  const { args } = hookArgs();
  const broken = { ...toolEnv(fakeEnv()), kernel: undefined as never, config: 42 as never };
  const quiet = console.error;
  const lines: string[] = [];
  console.error = (line: string) => lines.push(String(line));
  try {
    assert.equal(await beforeRound(args, broken), undefined);
    assert.equal(await beforeRound({ ...args, call: undefined as never }, toolEnv(fakeEnv())), undefined);
  } finally {
    console.error = quiet;
  }
  assert.ok(lines.length >= 1 && lines.every((l) => l.startsWith("compaction:")));
});
