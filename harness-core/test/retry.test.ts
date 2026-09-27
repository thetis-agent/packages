import { contentText, textContent } from "@thetis/runtime/lib/content";
// The round retry, the marks a stopped turn leaves, the resume that reads them, the drain at a round
// boundary, and the resumer service. Every provider here is scripted; nothing reaches a network. The waits
// are the shipped ones divided by about four hundred.
import { test, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Message, PackageStepContext, ProviderCall, ProviderEvent, ServiceEnv, ToolSpec, TurnEvent, UiCommandEnv } from "@thetis/runtime/contracts";
import {
  backoffMs, callModel, classify, kindFromMessage, marksOf, OUTPUT_LIMIT_NOTE, pick, resumeOnce, resumeTurn, resumerConfig, RETRY_DEFAULTS, retryConfig, uiRetryNow, withLongerLimit,
} from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "thetis-retry-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const FAST = { modelStallMs: 5_000, toolStallMs: 5_000, retryAttempts: 3, retryBaseMs: 5, retryMaxMs: 20, retryBudgetMs: 2_000 };

type Script = (round: number, call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => Promise<void>;

interface Over {
  input?: Message[];
  conversation?: Message[];
  tools?: ToolSpec[];
  params?: Record<string, unknown>;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  invoke?: (name: string, args: Record<string, unknown>) => Promise<string>;
  turns?: { yielding: () => Promise<unknown> };
}

/** A turn over a scripted provider. `calls` is every request as it was when sent, copied. */
function turn(script: Script, over: Over = {}) {
  const events: TurnEvent[] = [];
  const calls: ProviderCall[] = [];
  const invoked: string[] = [];
  let round = 0;
  const home = mkdtempSync(join(root, "turn-"));
  const ctx = {
    emit: (e: TurnEvent) => events.push(e),
    signal: over.signal ?? new AbortController().signal,
    session: { id: "s1", user: "alice" },
    turn: { id: "t1", input: over.input ?? [{ role: "user", content: textContent("go") }] },
    conversation: over.conversation ?? [{ role: "user", content: textContent("go") }],
    call: { model: "m", messages: [], tools: over.tools ?? [], params: over.params ?? {} },
    harness: {},
    packages: { has: () => false, get: () => undefined, list: () => [] },
    config: { ...FAST, ...(over.config ?? {}) },
    env: {
      cwd: home,
      root: "/root",
      store: "/store",
      shared: "/shared",
      storage: (): never => {
        throw new Error("no storage in this test");
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      readFile: async (): Promise<string> => {
        throw new Error("no such file");
      },
      writeFile: async () => {},
      invokeTool: async (ref: ToolSpec, args: Record<string, unknown>) => {
        invoked.push(`${ref.name}:${JSON.stringify(args)}`);
        return over.invoke ? over.invoke(ref.name, args) : `ran ${ref.name}`;
      },
      kernel: {
        providers: {
          call: (call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => {
            calls.push(JSON.parse(JSON.stringify(call)));
            return script(++round, call, onEvent, signal);
          },
        },
        config: { effective: async () => ({}) },
        ...(over.turns ? { turns: over.turns } : {}),
      },
    },
  } as unknown as PackageStepContext;
  return { ctx, events, calls, invoked, home };
}

const tool = (name: string): ToolSpec => ({ name, description: "", parameters: {}, package: "@a/p", export: name });
const cut = (onEvent: (e: ProviderEvent) => void, extra: Record<string, unknown> = {}) =>
  onEvent({ type: "error", message: "the connection closed before the reply finished, part-way through it: no finish reason was sent", retryable: true, kind: "connection", ...extra } as ProviderEvent);

type RetryData = { phase: string; round: number; attempt: number; of: number; kind: string; reason: string; inMs?: number; until?: string; dropped?: { text: number; tools: number } };
const retries = (events: TurnEvent[]): RetryData[] => events.filter((e) => e.type === "extension" && e.name === "harness-core.retry").map((e) => (e as unknown as { data: RetryData }).data);
const errorsOf = (events: TurnEvent[]) => events.filter((e) => e.type === "error") as (TurnEvent & Record<string, unknown>)[];
const own = (m: Message | undefined) => m?.extensions?.["@thetis/harness-core"];

// ---- 1. a cut round is sent again, the same request byte for byte ----

test("a round cut part-way is thrown away and sent again unchanged; the retried reply is the reply", async () => {
  const { ctx, events, calls } = turn(async (round, _call, onEvent) => {
    if (round === 1) {
      onEvent({ type: "text", delta: "half a rep" });
      return cut(onEvent);
    }
    onEvent({ type: "text", delta: "the whole reply" });
  });
  const out = await callModel(ctx);
  assert.deepEqual(out.conversation!.map((m) => [m.role, contentText(m.content)]), [["user", "go"], ["assistant", "the whole reply"]], "one assistant message, holding the second attempt's text");
  assert.equal(own(out.conversation![1]), undefined, "a finished reply carries no mark");
  assert.deepEqual(retries(events).map((r) => r.phase), ["waiting", "sending", "recovered"]);
  const waiting = retries(events)[0];
  assert.deepEqual([waiting.round, waiting.attempt, waiting.of, waiting.kind], [1, 1, 3, "connection"]);
  assert.deepEqual(waiting.dropped, { text: "half a rep".length, tools: 0 }, "the page is told how much was thrown away");
  assert.ok(typeof waiting.inMs === "number" && waiting.until && !Number.isNaN(Date.parse(waiting.until)));
  assert.match(waiting.reason, /part-way through it/);
  assert.equal(errorsOf(events).length, 0, "a recovered round is no failure");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[1]), JSON.stringify(calls[0]), "the retry is the identical request, so the prompt cache serves it");
  assert.ok(events.findIndex((e) => e.type === "extension" && (e as unknown as { data: RetryData }).data.phase === "recovered") < events.findIndex((e) => e.type === "message"), "recovered comes with the first sign of the new reply");
});

// ---- 2. finished rounds are never redone ----

test("a cut in round 3 after two tool rounds runs no tool twice and resends round 3 exactly", async () => {
  const { ctx, calls, invoked } = turn(async (round, _call, onEvent) => {
    if (round === 1) return onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: { n: 1 } } });
    if (round === 2) return onEvent({ type: "tool_call", call: { id: "c2", name: "t", args: { n: 2 } } });
    if (round === 3) {
      onEvent({ type: "extension", name: "tool_call.progress", data: { index: 0, name: "write", chars: 31_000 } });
      return cut(onEvent);
    }
    onEvent({ type: "text", delta: "done" });
  }, { tools: [tool("t")] });
  const out = await callModel(ctx);
  assert.deepEqual(invoked, ['t:{"n":1}', 't:{"n":2}'], "each tool ran exactly once");
  assert.equal(calls.length, 4, "rounds 1 and 2 were sent once each; round 3 twice");
  assert.equal(JSON.stringify(calls[3]), JSON.stringify(calls[2]), "the retried round 3 is byte for byte the cut one");
  assert.equal(calls[2].messages.length, 5, "and it carries the whole finished prefix");
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
});

test("the tools of a cut round are counted in what was dropped", async () => {
  const { ctx, events } = turn(async (round, _call, onEvent) => {
    if (round === 1) {
      onEvent({ type: "extension", name: "tool_call.progress", data: { index: 0, name: "write", chars: 31_000 } });
      return cut(onEvent);
    }
    onEvent({ type: "text", delta: "ok" });
  });
  await callModel(ctx);
  assert.deepEqual(retries(events)[0].dropped, { text: 0, tools: 31_000 });
});

// ---- 3. retries run out ----

test("a round cut every time is sent retryAttempts more times, then ends with one labelled error and the cut text marked partial", async () => {
  const { ctx, events, calls, home } = turn(async (_round, _call, onEvent) => {
    onEvent({ type: "text", delta: "again cut" });
    cut(onEvent);
  });
  const out = await callModel(ctx);
  assert.equal(calls.length, 1 + FAST.retryAttempts);
  const phases = retries(events).map((r) => r.phase);
  assert.deepEqual(phases, ["waiting", "sending", "recovered", "waiting", "sending", "recovered", "waiting", "sending", "recovered", "exhausted"]);
  assert.deepEqual(retries(events).filter((r) => r.phase === "waiting").map((r) => r.attempt), [1, 2, 3]);
  const errors = errorsOf(events);
  assert.equal(errors.length, 1);
  assert.deepEqual([errors[0].code, errors[0].retryable, errors[0].kind], ["provider", true, "connection"], "a later Retry could help, and the page says why it failed");
  assert.match(String(errors[0].message), /^provider error: the connection closed/);
  assert.equal(contentText(out.conversation!.at(-1)!.content), "again cut", "the last attempt's text is kept");
  assert.deepEqual(own(out.conversation!.at(-1)), { partial: true }, "and marked as cut");
  const ledger = JSON.parse((await import("node:fs")).readFileSync(join(home, "harness-core/context/s1.json"), "utf8"));
  assert.equal(ledger.usage[0].status, "failed");
  assert.equal(ledger.usage[0].calls, 1 + FAST.retryAttempts, "every attempt is a call in the ledger");
});

test("retryAttempts 0 sends nothing again", async () => {
  const { ctx, events, calls } = turn(async (_r, _c, onEvent) => cut(onEvent), { config: { retryAttempts: 0 } });
  await callModel(ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(retries(events), [], "no retry was ever in play, so nothing is exhausted either");
  assert.equal(errorsOf(events)[0].retryable, true);
});

// ---- 4. what is never sent again ----

test("a request that is wrong in itself is not sent again: context, auth, credits, and unlabelled words", async () => {
  const cases: Record<string, unknown>[] = [
    { message: "openrouter 400: prompt is too long", retryable: false, kind: "context", status: 400 },
    { message: "openrouter 401: no auth", retryable: false, kind: "auth", status: 401 },
    { message: "openrouter 402: Insufficient credits", retryable: false, kind: "credits", status: 402 },
    { message: "no installed provider serves model x" },
    { message: "openrouter 404: no such model", retryable: false, kind: "other", status: 404 },
  ];
  for (const failure of cases) {
    const { ctx, events, calls } = turn(async (_r, _c, onEvent) => onEvent({ type: "error", ...failure } as ProviderEvent));
    await callModel(ctx);
    assert.equal(calls.length, 1, `${failure.message} was not sent again`);
    assert.deepEqual(retries(events), []);
    assert.equal(errorsOf(events)[0].retryable, false);
  }
});

test("an empty reply, bad tool JSON and a content filter stop are each sent again once, not more", async () => {
  const empty = turn(async () => {});
  await callModel(empty.ctx);
  assert.equal(empty.calls.length, 2, "an empty reply gets one more sample");
  assert.match(String(errorsOf(empty.events)[0].message), /empty reply/);
  assert.deepEqual(retries(empty.events).map((r) => [r.phase, r.of]), [["waiting", 1], ["sending", 1], ["exhausted", 1]]);

  const json = turn(async (_r, _c, onEvent) => onEvent({ type: "error", message: "OpenRouter tool arguments must be valid JSON", retryable: true, kind: "other" } as ProviderEvent));
  await callModel(json.ctx);
  assert.equal(json.calls.length, 2);

  const filter = turn(async (round, _c, onEvent) => (round === 1 ? onEvent({ type: "error", message: "the provider's content filter stopped the reply", retryable: false, kind: "filter" } as ProviderEvent) : onEvent({ type: "text", delta: "fine" })));
  const out = await callModel(filter.ctx);
  assert.equal(filter.calls.length, 2, "a filter stop is usually a false positive: one more try");
  assert.equal(contentText(out.conversation!.at(-1)!.content), "fine");
});

test("an output-limit stop is sent again once with the limit doubled and a note, for that attempt only", async () => {
  const { ctx, calls, events } = turn(async (round, _call, onEvent) => {
    if (round === 1) return onEvent({ type: "error", message: "the reply stopped at the output limit of 32768 tokens (max_tokens)", retryable: false, kind: "output-limit" } as ProviderEvent);
    if (round === 2) return onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
    onEvent({ type: "text", delta: "written in parts" });
  }, { tools: [tool("t")] });
  const out = await callModel(ctx);
  assert.equal(calls[0].params.max_tokens, undefined);
  assert.equal(calls[1].params.max_tokens, 65_536, "the limit the provider named, doubled");
  assert.equal(contentText(calls[1].messages.at(-1)!.content), OUTPUT_LIMIT_NOTE);
  assert.equal(calls[1].messages.length, calls[0].messages.length + 1);
  assert.equal(calls[2].params.max_tokens, undefined, "the next round goes back to the configured limit");
  assert.ok(!calls[2].messages.some((m) => contentText(m.content) === OUTPUT_LIMIT_NOTE), "and carries no note");
  assert.ok(!out.conversation!.some((m) => contentText(m.content) === OUTPUT_LIMIT_NOTE), "the note is never saved");
  assert.equal(errorsOf(events).length, 0);

  const twice = turn(async (_r, _c, onEvent) => onEvent({ type: "error", message: "the reply stopped at the output limit of 1000 tokens (max_tokens)", retryable: false, kind: "output-limit" } as ProviderEvent), { params: { max_tokens: 1000 } });
  await callModel(twice.ctx);
  assert.equal(twice.calls.length, 2, "once only");
  assert.deepEqual([errorsOf(twice.events)[0].kind, errorsOf(twice.events)[0].retryable], ["output-limit", false]);
});

test("withLongerLimit is bounded, and leaves a limit it does not know alone", () => {
  const call: ProviderCall = { model: "m", messages: [], tools: [], params: { max_tokens: 100_000 } };
  assert.equal(withLongerLimit(call, "").params.max_tokens, 128_000);
  assert.deepEqual(withLongerLimit({ ...call, params: {} }, "the model stopped").params, {}, "unknown: only the note");
  assert.equal(call.messages.length, 0, "the loop's own call is never changed");
});

// ---- 5. waits ----

test("a Retry-After is honoured, and one that does not fit the budget ends the retrying at once, saying so", async () => {
  const honoured = turn(async (round, _c, onEvent) => (round === 1 ? cut(onEvent, { kind: "rate-limit", retryAfterMs: 120 }) : onEvent({ type: "text", delta: "ok" })));
  const started = Date.now();
  await callModel(honoured.ctx);
  assert.ok(retries(honoured.events)[0].inMs! >= 120, "the wait is at least what the provider asked for");
  assert.ok(Date.now() - started >= 110, "and it was waited");

  const over = turn(async (_r, _c, onEvent) => cut(onEvent, { kind: "rate-limit", retryAfterMs: 60_000 }), { config: { retryBudgetMs: 1_000 } });
  const quick = Date.now();
  await callModel(over.ctx);
  assert.ok(Date.now() - quick < 1_000, "no wait was started that could not be finished");
  assert.equal(over.calls.length, 1);
  assert.deepEqual(retries(over.events).map((r) => r.phase), ["exhausted"]);
  assert.match(retries(over.events)[0].reason, /does not fit what is left of the retry budget/);
  assert.match(String(errorsOf(over.events)[0].message), /retry budget/);
});

test("backoff doubles from the base with a fifth of jitter, is capped, and never undercuts Retry-After", () => {
  const cfg = retryConfig({});
  assert.deepEqual(cfg, RETRY_DEFAULTS);
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(cfg, n, undefined, mid)), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(backoffMs(cfg, 1, undefined, () => 0), 1_600);
  assert.equal(backoffMs(cfg, 1, undefined, () => 1), 2_400);
  assert.equal(backoffMs(cfg, 1, 9_000, mid), 9_000);
  assert.equal(retryConfig({ retryAttempts: 0 }).retryAttempts, 0);
  assert.equal(retryConfig({ retryAttempts: -1, retryBaseMs: 0 }).retryAttempts, RETRY_DEFAULTS.retryAttempts);
  assert.equal(retryConfig({ retryBaseMs: 0 }).retryBaseMs, RETRY_DEFAULTS.retryBaseMs);
});

// ---- 6. stop during a wait ----

test("a stop during the wait ends the turn at once; nothing more is sent and nothing is announced", async () => {
  const control = new AbortController();
  const { ctx, events, calls } = turn(async (_r, _c, onEvent) => {
    onEvent({ type: "text", delta: "cut" });
    cut(onEvent);
  }, { config: { retryBaseMs: 10_000, retryMaxMs: 10_000, retryBudgetMs: 60_000 }, signal: control.signal });
  setTimeout(() => control.abort(), 60);
  const started = Date.now();
  const out = await callModel(ctx);
  assert.ok(Date.now() - started < 1_000, "the wait gave way to the stop");
  assert.equal(calls.length, 1);
  assert.equal(errorsOf(events).length, 0, "a stop is the kernel's one cancelled error");
  assert.deepEqual(retries(events).map((r) => r.phase), ["waiting"]);
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user"], "the thrown-away half is not brought back");
});

// ---- 7. retry now ----

test("a retry-now request ends the wait early, and is used up by it", async () => {
  const { ctx, calls, home } = turn(async (round, _c, onEvent) => (round === 1 ? cut(onEvent) : onEvent({ type: "text", delta: "ok" })), {
    config: { retryBaseMs: 20_000, retryMaxMs: 20_000, retryBudgetMs: 60_000 },
  });
  // The page's command, as the gateway runs it: under its own env, writing into the same home.
  const writes: string[] = [];
  const env = {
    session: "s1",
    writeFile: async (path: string, content: string) => {
      writes.push(path);
      mkdirSync(join(home, "harness-core/retry"), { recursive: true });
      writeFileSync(join(home, path), content);
    },
  } as unknown as UiCommandEnv;
  // A request left over from before the wait is not one for it.
  mkdirSync(join(home, "harness-core/retry"), { recursive: true });
  writeFileSync(join(home, "harness-core/retry/s1.json"), "{}");
  setTimeout(() => void uiRetryNow({}, env), 100);
  const started = Date.now();
  await callModel(ctx);
  const took = Date.now() - started;
  assert.ok(took >= 90, `the stale request did not end the wait (${took}ms)`);
  assert.ok(took < 2_000, `the new one did (${took}ms)`);
  assert.equal(calls.length, 2);
  assert.deepEqual(writes, ["harness-core/retry/s1.json"]);
  assert.equal(existsSync(join(home, "harness-core/retry/s1.json")), false, "one click is one retry");
  await assert.rejects(uiRetryNow({ session: "../x" }, env), /invalid session id/);
});

// ---- the classification ----

test("classify: the provider's labels first, the words for a provider that labels nothing", () => {
  assert.deepEqual(classify({ message: "x", retryable: true, kind: "overloaded", retryAfterMs: 5 }), { plan: "full", kind: "overloaded", retryable: true, retryAfterMs: 5 });
  assert.equal(classify({ message: "x", retryable: false, kind: "connection" }).plan, "none", "a provider that says no is believed");
  assert.equal(classify({ message: "TypeError: fetch failed" }).plan, "full");
  assert.equal(classify({ message: "socket hang up" }).kind, "connection");
  assert.equal(classify({ message: "openrouter 529: Overloaded" }).kind, "overloaded");
  assert.equal(classify({ message: "the provider gave up" }).plan, "none");
  assert.equal(classify({ message: "whatever", retryable: true }).plan, "once");
  assert.equal(classify({ message: "the reply stopped at the output limit of 10 tokens (max_tokens)" }).plan, "longer");
  assert.equal(kindFromMessage("openrouter 402: out of credits"), "credits");
  assert.equal(kindFromMessage("no response from openrouter within 180s"), "timeout");
});

// ---- 8. a resume drops a cut reply ----

const partialReply: Message = { role: "assistant", content: textContent("Good, I now know the file struct"), extensions: { "@thetis/harness-core": { partial: true } } };

test("resume: on a turn with no input a trailing cut reply is dropped, and nothing is added", async () => {
  const conversation: Message[] = [{ role: "user", content: textContent("go") }, { role: "assistant", content: textContent(""), toolCalls: [{ id: "c1", name: "t", args: {} }] }, { role: "tool", content: textContent("ok"), toolCallId: "c1", name: "t" }, partialReply];
  const { ctx } = turn(async () => {}, { input: [], conversation });
  const out = await resumeTurn(ctx);
  assert.deepEqual(out?.conversation, conversation.slice(0, -1), "the request now ends in the tool results: no prefill");
  // The loop then continues from there and appends the new reply, with no user message added.
  const next = turn(async (_r, call, onEvent) => {
    assert.equal(call.messages.at(-1)!.role, "tool");
    onEvent({ type: "text", delta: "Good, I now know the file structure." });
  }, { input: [], conversation: out!.conversation as Message[] });
  const done = await callModel(next.ctx);
  assert.deepEqual(done.conversation!.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(done.conversation!.filter((m) => m.role === "user").length, 1);
});

test("resume: a turn with input, a finished reply and a reply with tool calls are left alone", async () => {
  const withInput = turn(async () => {}, { conversation: [{ role: "user", content: textContent("go") }, partialReply] });
  assert.equal(await resumeTurn(withInput.ctx), undefined, "a turn with input is not a resume");
  const finished = turn(async () => {}, { input: [], conversation: [{ role: "user", content: textContent("go") }, { role: "assistant", content: textContent("Done.") }] });
  assert.equal(await resumeTurn(finished.ctx), undefined, "no ledger, no mark: a finished reply is not resumed away");
});

test("resume: an unmarked trailing reply from an older record is dropped only when the previous turn did not complete", async () => {
  const conversation: Message[] = [{ role: "user", content: textContent("go") }, { role: "assistant", content: textContent("Append my section at the end.") }];
  for (const [status, dropped] of [["failed", true], ["cancelled", true], ["running", true], ["complete", false]] as const) {
    const { ctx, home } = turn(async () => {}, { input: [], conversation });
    mkdirSync(join(home, "harness-core/context"), { recursive: true });
    writeFileSync(join(home, "harness-core/context/s1.json"), JSON.stringify({ usage: [{ id: "t0", firstMessage: 0, at: "x", calls: 1, status, usage: {} }] }));
    const out = await resumeTurn(ctx);
    assert.equal(out?.conversation?.length === 1, dropped, `previous turn ${status}`);
  }
});

// ---- 9. a resume runs the tools that never ran ----

test("resume: results marked notRun are replaced by running those tools before the first model call; other results stay", async () => {
  const conversation: Message[] = [
    { role: "user", content: textContent("go") },
    { role: "assistant", content: textContent(""), toolCalls: [{ id: "a", name: "t", args: { n: 1 } }, { id: "b", name: "t", args: { n: 2 } }, { id: "c", name: "t", args: { n: 3 } }] },
    { role: "tool", content: textContent("error: the turn was interrupted: the fence died"), toolCallId: "a", name: "t" },
    { role: "tool", content: textContent("error: the turn was stopped before this tool ran"), toolCallId: "b", name: "t", extensions: { "@thetis/harness-core": { notRun: true } } },
    { role: "tool", content: textContent("error: the turn was stopped before this tool ran"), toolCallId: "c", name: "t", extensions: { "@thetis/harness-core": { notRun: true } } },
  ];
  let sawAtCall: string[] = [];
  const { ctx, invoked } = turn(async (_r, call, onEvent) => {
    sawAtCall = [...invoked];
    assert.deepEqual(call.messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, contentText(m.content)]), [
      ["a", "error: the turn was interrupted: the fence died"],
      ["b", "ran t"],
      ["c", "ran t"],
    ], "the request carries the kept result and the two new ones, in the order they were asked");
    onEvent({ type: "text", delta: "all three answered" });
  }, { input: [], conversation, tools: [tool("t")] });
  const out = await callModel(ctx);
  assert.deepEqual(sawAtCall, ['t:{"n":2}', 't:{"n":3}'], "the tools that never ran ran first; the one a dead step may have run did not");
  assert.ok(!out.conversation!.some((m) => marksOf(m).notRun), "no notRun result is left");
  assert.equal(contentText(out.conversation!.at(-1)!.content), "all three answered");
});

test("notRun results are left alone on a turn with input", async () => {
  const conversation: Message[] = [
    { role: "user", content: textContent("go") },
    { role: "assistant", content: textContent(""), toolCalls: [{ id: "b", name: "t", args: {} }] },
    { role: "tool", content: textContent("error: the turn was stopped before this tool ran"), toolCallId: "b", name: "t", extensions: { "@thetis/harness-core": { notRun: true } } },
    { role: "user", content: textContent("never mind that, do this") },
  ];
  const { ctx, invoked } = turn(async (_r, _c, onEvent) => onEvent({ type: "text", delta: "ok" }), { conversation, tools: [tool("t")] });
  await callModel(ctx);
  assert.deepEqual(invoked, []);
});

// ---- the drain ----

test("a pending drain stops the turn at the next round boundary, clean, with a yield event; the first round is never asked", async () => {
  let asked = 0;
  const { ctx, events, calls } = turn(async (round, _c, onEvent) => {
    if (round === 1) return onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
    onEvent({ type: "text", delta: "never sent" });
  }, { tools: [tool("t")], turns: { yielding: async () => (++asked, { why: "restart" }) } });
  const out = await callModel(ctx);
  assert.equal(asked, 1, "asked once, at the top of round 2");
  assert.equal(calls.length, 1, "round 2 was not sent");
  assert.deepEqual(events.filter((e) => (e.type as string) === "yield"), [{ type: "yield", why: "restart" }]);
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user", "assistant", "tool"], "everything done is kept, and every tool call has its result");
  assert.ok(!out.conversation!.some((m) => marksOf(m).partial || marksOf(m).notRun), "nothing partial, nothing dangling");
  assert.equal(errorsOf(events).length, 0);
});

test("no drain, a kernel without the question, and a question that fails all mean go on", async () => {
  for (const turns of [{ yielding: async () => false }, { yielding: async () => { throw new Error("no such method"); } }, undefined]) {
    const { ctx, calls } = turn(async (round, _c, onEvent) => (round === 1 ? onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } }) : onEvent({ type: "text", delta: "done" })), { tools: [tool("t")], ...(turns ? { turns } : {}) });
    const out = await callModel(ctx);
    assert.equal(calls.length, 2);
    assert.equal(contentText(out.conversation!.at(-1)!.content), "done");
  }
});

// ---- the resumer ----

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("the resumer picks root conversations cut by a restart, an apply, a crash or a drain, recently, and only once", () => {
  const cfg = resumerConfig({});
  const rows = [
    { id: "restart", interrupted: { why: "restart", at: ago(1_000) } },
    { id: "reload", interrupted: { why: "reload", at: ago(2_000) } },
    { id: "crash", interrupted: { why: "crash", at: ago(3_000) } },
    { id: "yield", interrupted: { why: "yield", at: ago(500) } },
    { id: "provider", interrupted: { why: "provider", at: ago(1_000) } },
    { id: "failed", interrupted: { why: "failed", at: ago(1_000) } },
    { id: "child", parent: "restart", interrupted: { why: "restart", at: ago(1_000) } },
    { id: "again", interrupted: { why: "restart", at: ago(1_000), resumes: 1 } },
    { id: "old", interrupted: { why: "restart", at: ago(cfg.resumeMaxAgeMs + 1) } },
    { id: "running", running: true, interrupted: { why: "restart", at: ago(1_000) } },
    { id: "plain" },
    "garbage",
  ];
  assert.deepEqual(pick(rows, cfg, Date.now()), ["yield", "restart", "reload", "crash"], "newest cut first");
  assert.deepEqual(resumerConfig({ autoResume: false, resumeMaxAgeMs: -5 }), { autoResume: false, resumeMaxAgeMs: 1_800_000 });
});

test("the resumer sends a turn with no input, two at a time and spaced, and skips what is busy or already resumed", async () => {
  const sent: { id: string; at: number }[] = [];
  let running = 0;
  let most = 0;
  const records: Record<string, unknown> = {
    a: { status: "idle", interrupted: { why: "restart", at: ago(1_000) } },
    b: { status: "idle", interrupted: { why: "restart", at: ago(2_000) } },
    c: { status: "idle", interrupted: { why: "restart", at: ago(3_000) } },
    busy: { status: "idle", interrupted: { why: "restart", at: ago(4_000) } },
    gone: { status: "idle" }, // somebody resumed it between the list and the send
    broken: { status: "idle", interrupted: { why: "crash", at: ago(5_000) } },
  };
  const logs: string[] = [];
  const env = {
    log: (line: string) => logs.push(line),
    kernel: {
      sessions: {
        list: async () => Object.keys(records).map((id) => ({ id, interrupted: { why: "restart", at: ago(1_000 + Object.keys(records).indexOf(id)) } })),
        inspect: async (id: string) => records[id],
        send: async (id: string, input: unknown[], _onEvent: unknown) => {
          assert.deepEqual(input, [], "a resume adds nothing to the conversation");
          if (id === "busy") throw Object.assign(new Error(`session ${id} already has a turn in progress`), { code: "busy" });
          if (id === "broken") throw new Error("the fence went away");
          sent.push({ id, at: Date.now() });
          running++;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 60));
          running--;
        },
      },
    },
  } as unknown as ServiceEnv;
  const run = await resumeOnce(env, resumerConfig({}), { gapMs: 20 });
  assert.deepEqual(run.resumed.sort(), ["a", "b", "c"]);
  assert.deepEqual(run.skipped.sort(), ["busy", "gone"]);
  assert.deepEqual(run.failed.map((f) => f.id), ["broken"]);
  assert.equal(most, 2, "never more than two at once");
  const starts = sent.map((s) => s.at).sort((x, y) => x - y);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 15, "starts are spaced");
  assert.ok(logs.some((l) => /could not continue broken/.test(l)));
});

test("the resumer does nothing when it is switched off, and never throws when the list fails", async () => {
  const { resumer } = await import("../src/index.js");
  const off = await resumer({ config: { autoResume: false }, log: () => {}, kernel: {} } as unknown as ServiceEnv);
  assert.deepEqual(off, {});
  const run = await resumeOnce({ log: () => {}, kernel: { sessions: { list: async () => { throw new Error("no kernel"); } } } } as unknown as ServiceEnv, resumerConfig({}));
  assert.deepEqual(run, { resumed: [], skipped: [], failed: [] });
});

test("a provider request cancelled under a turn nobody stopped is a dropped line, and the round is sent again", async () => {
  // The provider's fence closing for an apply rejects the kernel call as cancelled; the person did not stop anything.
  const { ctx, events, calls } = turn(async (round, _c, onEvent) => {
    if (round === 1) throw Object.assign(new Error("fence request provider.call cancelled"), { code: "cancelled" });
    onEvent({ type: "text", delta: "back" });
  });
  const out = await callModel(ctx);
  assert.equal(calls.length, 2);
  assert.equal(retries(events)[0].kind, "connection");
  assert.equal(contentText(out.conversation!.at(-1)!.content), "back");
  assert.equal(errorsOf(events).length, 0);
});
