import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, ToolSpec, TurnEvent } from "@thetis/contracts";
import { attachTools, callModel, recordCall, systemPrompt, turnContext, turnContextLine, TURN_CONTEXT, withoutTurnContext, type LastCall } from "../src/index.js";

const greet = {
  name: "@thetis/greet",
  version: "1.0.0",
  type: "tool",
  description: "Says hello",
  thetis: { type: "tool", tools: [{ name: "greet", description: "hi", export: "greet" }] },
} as unknown as PackageInfo;

/** A turn as the fence hands it to a step, after `callModel`: the reply is already in `call.messages`. */
function ctxWith(over: Partial<PackageStepContext> = {}): PackageStepContext {
  return {
    emit: () => {},
    signal: new AbortController().signal,
    session: { id: "s1", user: "alice" },
    turn: { id: "t1", input: [{ role: "user", content: "hi" }] },
    conversation: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    call: {
      model: "vendor/model",
      system: "You are Thetis.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      tools: [
        { name: "greet", description: "hi", parameters: {}, package: "@thetis/greet", export: "greet" },
        { name: "exec", description: "run", parameters: {}, package: "@thetis/tool-exec", export: "exec" },
      ],
      params: {},
    },
    harness: { "@thetis/harness-core": { notes: "keep me" }, "@thetis/prompt-cache": { turns: 3 } },
    packages: { has: (n) => n === greet.name, get: (n) => (n === greet.name ? greet : undefined), list: () => [greet] },
    env: {
      cwd: "/home/alice",
      root: "/root",
      store: "/store",
      shared: "/shared",
      storage: (): never => {
        throw new Error("no storage in this test");
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      readFile: async () => {
        throw new Error("no such file");
      },
      writeFile: async () => {},
      invokeTool: async () => {
        throw new Error("no tools in this test");
      },
      kernel: {} as never,
    },
    config: {},
    ...over,
  };
}

test("recordCall keeps what the provider received, and only in this package's own harness key", async () => {
  const ctx = ctxWith();
  const before = JSON.stringify(ctx);
  const result = await recordCall(ctx);
  assert.deepEqual(Object.keys(result), ["harness"], "call and conversation are not returned: the prefix the cache saw stays as it is");
  assert.equal(before, JSON.stringify(ctx), "the context is not mutated in place");

  const own = result.harness!["@thetis/harness-core"] as { notes: string; lastCall: LastCall };
  assert.equal(own.notes, "keep me", "the other fields of the key survive");
  assert.deepEqual(result.harness!["@thetis/prompt-cache"], { turns: 3 }, "another package's key is untouched");
  const { at, ...rest } = own.lastCall;
  assert.deepEqual(rest, { model: "vendor/model", system: "You are Thetis.", systemChars: 15, tools: ["greet", "exec"], messages: 2 });
  assert.equal(new Date(at).toISOString(), at, "the time is ISO");
});

test("recordCall copes with no system prompt and no state of its own yet", async () => {
  const ctx = ctxWith({ call: { model: "m", messages: [], tools: [], params: {} }, harness: {} });
  const result = await recordCall(ctx);
  const own = result.harness!["@thetis/harness-core"] as { lastCall: LastCall };
  assert.equal(own.lastCall.system, "");
  assert.equal(own.lastCall.systemChars, 0);
  assert.deepEqual(own.lastCall.tools, []);
  assert.equal(own.lastCall.messages, 0);
});

test("attachTools adds each installed tool once, after whatever is already attached", async () => {
  const ctx = ctxWith({ call: { model: "m", messages: [], tools: [{ name: "first", description: "", parameters: {}, package: "@x/y", export: "first" }], params: {} } });
  const once = await attachTools(ctx);
  assert.deepEqual(once.call!.tools.map((t) => t.name), ["first", "greet"]);
  const twice = await attachTools({ ...ctx, call: once.call! });
  assert.deepEqual(twice.call!.tools.map((t) => t.name), ["first", "greet"], "the first package with a name wins; nothing is attached twice");
});

test("systemPrompt appends the guide and nothing of the person's: no package list, no notes, no session id", async () => {
  const ctx = ctxWith({ harness: { notes: "remember the cat" } });
  const result = await systemPrompt(ctx);
  assert.deepEqual(Object.keys(result), ["call"]);
  assert.ok(result.call!.system!.startsWith("You are Thetis.\n\n"), "what was there stays first");
  assert.doesNotMatch(result.call!.system!, /@thetis\/greet@1\.0\.0/, "the package list is a tool's answer, not prompt text");
  assert.doesNotMatch(result.call!.system!, /remember the cat|Session notes|standing notes/, "harness.notes and THETIS.md are not prompt text");
  assert.match(result.call!.system!, /## Working style/);
  assert.doesNotMatch(result.call!.system!, /subagent\. Your final reply/, "a top-level session gets no subagent line");
  assert.doesNotMatch(result.call!.system!, /s1/, "the session id is not in the prompt, so a child's prompt can match its parent's");
});

test("systemPrompt adds one line for a subagent and nothing else changes", async () => {
  const parent = await systemPrompt(ctxWith({ harness: {} }));
  const child = await systemPrompt(ctxWith({ harness: {}, session: { id: "s2", user: "alice", parent: "s1" } }));
  const line = "\n- You are a subagent. Your final reply goes to the agent that spawned you, not to a person: make it complete, with paths, quoted output, and what you could not find.";
  assert.ok(child.call!.system!.includes(line));
  assert.equal(child.call!.system!.replace(line, ""), parent.call!.system, "apart from that line the two prompts are byte-identical");
});

test("turnContext ends the turn's input with a dated line, once, and leaves the rest of the conversation alone", async () => {
  const ctx = ctxWith({ config: { timeZone: "Europe/Berlin" } });
  const once = await turnContext(ctx);
  assert.deepEqual(Object.keys(once!), ["conversation"]);
  const [first, reply] = once!.conversation!;
  assert.match(first.content, /^hi\n\n\[Turn context: [A-Z][a-z]+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Berlin\]$/);
  assert.deepEqual(reply, ctx.conversation[1], "the messages after the input are untouched");
  assert.equal(await turnContext({ ...ctx, conversation: once!.conversation! }), undefined, "an input that already carries the line is left alone");
  assert.equal(await turnContext({ ...ctx, config: { turnContext: false } }), undefined, "switched off, the step returns nothing");
  assert.ok(TURN_CONTEXT.test(first.content));
});

test("turnContextLine writes the weekday, the date, the time and the zone, and a bad zone falls back to UTC", () => {
  assert.equal(turnContextLine(new Date("2026-09-21T18:40:00Z"), "Europe/Berlin"), "[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]");
  assert.equal(turnContextLine(new Date("2026-09-21T00:05:00Z"), "UTC"), "[Turn context: Monday 2026-09-21 00:05 UTC]");
});

test("withoutTurnContext takes the line off the end and nothing else", () => {
  assert.equal(withoutTurnContext("hi\n\n[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]"), "hi");
  assert.equal(withoutTurnContext("[Turn context: x] first\n\nthen"), "[Turn context: x] first\n\nthen", "only a suffix is the line");
  assert.equal(withoutTurnContext("plain"), "plain");
});

// ---- callModel: the loop, over a fake provider, a fake tool runner and a fake package list ----

type Script = (round: number, call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => Promise<void>;
interface Invoked {
  ref: Pick<ToolSpec, "package" | "export" | "name">;
  args: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** The loop's context: the provider answers per round from `script`, and `invokeTool` records what it ran. */
function loopCtx(script: Script, over: { tools?: ToolSpec[]; hints?: Record<string, unknown>; invoke?: (call: Invoked, signal?: AbortSignal) => Promise<string | object>; packages?: PackageInfo[]; signal?: AbortSignal } = {}) {
  const events: TurnEvent[] = [];
  const invoked: Invoked[] = [];
  const configs: string[] = [];
  let round = 0;
  const hidden = { name: "@a/p", version: "1", type: "tool", description: "", root: "", thetis: { type: "tool", tools: [{ name: "hidden_tool", description: "Hidden.", parameters: { type: "object", properties: {} }, export: "run" }] } } as unknown as PackageInfo;
  const list = over.packages ?? [hidden];
  const ctx = ctxWith({
    conversation: [{ role: "user", content: "go" }],
    call: { model: "m", messages: [], tools: over.tools ?? [], params: {}, ...(over.hints ? { hints: over.hints } : {}) },
    harness: {},
    packages: { has: (n) => list.some((p) => p.name === n), get: (n) => list.find((p) => p.name === n), list: () => list },
    emit: (e) => events.push(e),
    signal: over.signal ?? new AbortController().signal,
  });
  ctx.env = {
    ...ctx.env,
    invokeTool: async (ref, args, opts) => {
      const call = { ref: { package: ref.package, export: ref.export, name: ref.name }, args, config: opts.config };
      invoked.push(call);
      return over.invoke ? over.invoke(call, opts.signal) : `ran ${ref.name}`;
    },
    kernel: {
      providers: { call: (call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => script(++round, call, onEvent, signal) },
      config: { effective: async (name: string) => (configs.push(name), { for: name }) },
    } as never,
  };
  return { ctx, events, invoked, configs };
}

const toolResults = (conversation: Message[] | undefined) => (conversation ?? []).filter((m) => m.role === "tool").map((m) => [m.name, m.content]);

test("callModel: a call to a tool the call withheld is resolved against the installed packages and run under its own package; an unknown name stays refused", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "hidden_tool", args: { a: 1 } } });
    else if (round === 2) onEvent({ type: "tool_call", call: { id: "c2", name: "never_declared", args: {} } });
    else onEvent({ type: "text", delta: "done" });
  };
  const { ctx, events, invoked, configs } = loopCtx(script, { hints: { withheld: ["hidden_tool"] } });
  const out = await callModel(ctx);
  assert.deepEqual(invoked, [{ ref: { package: "@a/p", export: "run", name: "hidden_tool" }, args: { a: 1 }, config: { for: "@a/p" } }], "the withheld tool ran under its own package with that package's effective configuration");
  assert.deepEqual(configs, ["@a/p"]);
  assert.deepEqual(toolResults(out.conversation), [["hidden_tool", "ran hidden_tool"], ["never_declared", "error: unknown tool: never_declared"]]);
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  assert.equal(out.conversation!.at(-1)!.content, "done");
  assert.deepEqual(out.call!.messages, out.conversation, "the call started from the conversation and grew with it");
  assert.deepEqual(events.map((e) => e.type), ["tool.call", "message", "tool.result", "tool.call", "message", "tool.result", "text", "message"]);
  assert.ok(!events.some((e) => e.type === "error"), "an unknown tool is the model's problem, not the turn's");
});

test("callModel: the same name with nothing withheld is refused; the hint is the only door", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "hidden_tool", args: {} } });
    else onEvent({ type: "text", delta: "ok" });
  };
  const { ctx, invoked } = loopCtx(script, { hints: {} });
  const out = await callModel(ctx);
  assert.deepEqual(invoked, []);
  assert.deepEqual(toolResults(out.conversation), [["hidden_tool", "error: unknown tool: hidden_tool"]]);
});

test("callModel: cancel mid-stream keeps the partial text, emits no error, and returns", async () => {
  const control = new AbortController();
  // The agent's `rpc` rejects with code `cancelled` the moment the signal aborts; the fake does the same.
  const script: Script = async (_round, _call, onEvent, signal) => {
    onEvent({ type: "text", delta: "one " });
    onEvent({ type: "text", delta: "two " });
    await new Promise<void>((_, fail) => {
      signal!.addEventListener("abort", () => fail(Object.assign(new Error("providers.call cancelled"), { code: "cancelled" })), { once: true });
      setTimeout(() => control.abort(), 10);
    });
  };
  const { ctx, events } = loopCtx(script, { signal: control.signal });
  const out = await callModel(ctx);
  assert.deepEqual(out.conversation, [
    { role: "user", content: "go" },
    { role: "assistant", content: "one two " },
  ]);
  assert.deepEqual(events.map((e) => e.type), ["text", "text"], "no error event: the kernel produces the one cancelled error");
});

test("callModel: a cancel between tool calls closes the ones that never ran and records the one that did", async () => {
  const control = new AbortController();
  const script: Script = async (_round, _call, onEvent) => {
    onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
    onEvent({ type: "tool_call", call: { id: "c2", name: "t", args: {} } });
  };
  const spec = { name: "t", description: "", parameters: {}, package: "@a/p", export: "t" };
  const { ctx, events, invoked } = loopCtx(script, { tools: [spec], signal: control.signal, invoke: async () => "first ran" });
  // The stop lands as the first result is recorded: after the tool, before the next one.
  const record = ctx.emit;
  ctx.emit = (e) => (record(e), e.type === "tool.result" ? control.abort() : undefined);
  const out = await callModel(ctx);
  assert.equal(invoked.length, 1, "the second tool call was not started");
  assert.deepEqual(toolResults(out.conversation), [["t", "first ran"], ["t", "error: the turn was stopped before this tool ran"]]);
  assert.ok(!events.some((e) => e.type === "error"));
});

test("callModel: a cancel during a tool that ignores its signal returns at once, with the call closed as stopped", async () => {
  const control = new AbortController();
  const script: Script = async (_round, _call, onEvent) => {
    onEvent({ type: "text", delta: "running " });
    onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
  };
  const spec = { name: "t", description: "", parameters: {}, package: "@a/p", export: "t" };
  let finished = false;
  const { ctx, events, invoked } = loopCtx(script, { tools: [spec], signal: control.signal, invoke: () => new Promise((res) => setTimeout(() => (finished = true, res("late")), 200)) });
  setTimeout(() => control.abort(), 10);
  const started = Date.now();
  const out = await callModel(ctx);
  assert.ok(Date.now() - started < 150, "the step did not wait for the tool");
  assert.equal(invoked.length, 1);
  assert.equal(finished, false, "the tool is still running; its outcome is dropped");
  assert.deepEqual(out.conversation!.slice(1), [
    { role: "assistant", content: "running ", toolCalls: [{ id: "c1", name: "t", args: {} }] },
    { role: "tool", content: "error: the turn was stopped before this tool ran", toolCallId: "c1", name: "t" },
  ]);
  assert.ok(!events.some((e) => e.type === "error" || e.type === "tool.result"));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(finished, true);
});

test("callModel: a tool call id an earlier turn already answered is still closed when this turn's call never ran", async () => {
  const control = new AbortController();
  const script: Script = async (_round, _call, onEvent) => onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
  const spec = { name: "t", description: "", parameters: {}, package: "@a/p", export: "t" };
  const { ctx } = loopCtx(script, { tools: [spec], signal: control.signal, invoke: () => new Promise(() => {}) });
  ctx.conversation = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", args: {} }] },
    { role: "tool", content: "done", toolCallId: "c1", name: "t" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "go" },
  ];
  setTimeout(() => control.abort(), 10);
  const out = await callModel(ctx);
  assert.deepEqual(out.conversation!.slice(-2).map((m) => [m.role, m.content]), [["assistant", ""], ["tool", "error: the turn was stopped before this tool ran"]]);
});

test("callModel: a provider failure keeps the tool call and its result, keeps the partial text, drops the tool call that came with the failure, and emits one provider error", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: { n: 1 } } });
    else {
      onEvent({ type: "text", delta: "partial" });
      onEvent({ type: "tool_call", call: { id: "c2", name: "t", args: { n: 2 } } });
      onEvent({ type: "error", message: "the provider gave up" });
    }
  };
  const spec = { name: "t", description: "", parameters: {}, package: "@a/p", export: "t" };
  const { ctx, events } = loopCtx(script, { tools: [spec], invoke: async (c) => ({ got: c.args }) });
  const out = await callModel(ctx);
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(out.conversation![2].content, JSON.stringify({ got: { n: 1 } }), "an object result is JSON");
  assert.deepEqual(out.conversation![3], { role: "assistant", content: "partial" }, "the text streamed before the failure is kept; the tool call that came with it is not");
  const errors = events.filter((e) => e.type === "error");
  assert.deepEqual(errors, [{ type: "error", message: "provider error: the provider gave up", code: "provider" }]);
  assert.equal(out.call!.messages.length, 3, "the call carries what the provider accepted: the request, the reply, the tool result");
});

test("callModel: a provider the kernel cannot reach is a provider failure too; a tool that throws a coded error is still its own result", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
    else throw new Error("no provider serves m");
  };
  const spec = { name: "t", description: "", parameters: {}, package: "@a/p", export: "t" };
  const { ctx, events } = loopCtx(script, { tools: [spec], invoke: async () => "ok" });
  const out = await callModel(ctx);
  assert.deepEqual(toolResults(out.conversation), [["t", "ok"]]);
  assert.deepEqual(events.filter((e) => e.type === "error"), [{ type: "error", message: "provider error: no provider serves m", code: "provider" }]);
  const coded = loopCtx(async (round, _c, onEvent) => (round === 1 ? onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } }) : onEvent({ type: "text", delta: "on" })), { tools: [spec], invoke: async () => { throw Object.assign(new Error("x"), { code: "other" }); } });
  const failed = await callModel(coded.ctx);
  assert.deepEqual(toolResults(failed.conversation), [["t", "error: x"]], "only code cancelled stops the loop; any other coded error is the tool's result");
  assert.equal(failed.conversation!.at(-1)!.content, "on");
});

test("callModel: a tool that throws yields error: <message>, emitted as its result, and the loop continues", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
    else onEvent({ type: "text", delta: "after" });
  };
  const spec = { name: "t", description: "", parameters: {}, package: "@a/p", export: "t" };
  const { ctx, events } = loopCtx(script, { tools: [spec], invoke: async () => { throw new Error("boom"); } });
  const out = await callModel(ctx);
  assert.deepEqual(toolResults(out.conversation), [["t", "error: boom"]]);
  assert.deepEqual(events.find((e) => e.type === "tool.result"), { type: "tool.result", id: "c1", name: "t", result: "error: boom" });
  assert.equal(out.conversation!.at(-1)!.content, "after");
});

test("callModel: reasoning is forwarded as its own event and is in no message", async () => {
  const script: Script = async (_round, _call, onEvent) => {
    onEvent({ type: "reasoning", delta: "let me " });
    onEvent({ type: "reasoning", delta: "think" });
    onEvent({ type: "text", delta: "the answer" });
  };
  const { ctx, events } = loopCtx(script);
  const out = await callModel(ctx);
  assert.deepEqual(events.map((e) => e.type), ["reasoning", "reasoning", "text", "message"], "each chunk is relayed as it arrives, in order");
  assert.deepEqual(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta), ["let me ", "think"]);
  assert.equal(out.conversation!.at(-1)!.content, "the answer", "the thinking is not part of the reply");
  assert.ok(!JSON.stringify(out.conversation).includes("think"), "and nothing of it is kept in the conversation");
});

test("callModel: usage rides on the message event and is emitted on its own; a call with messages already shaped is sent as it is", async () => {
  const script: Script = async (_round, call, onEvent) => {
    onEvent({ type: "text", delta: `saw ${call.messages.length}` });
    onEvent({ type: "usage", usage: { input: 3, output: 1 } });
  };
  const { ctx, events } = loopCtx(script);
  ctx.call.messages = [{ role: "system", content: "shaped" }, { role: "user", content: "go" }];
  const out = await callModel(ctx);
  assert.equal(out.conversation!.at(-1)!.content, "saw 2");
  assert.deepEqual(out.call!.messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.deepEqual(events.map((e) => e.type), ["text", "usage", "message"]);
  assert.deepEqual((events.at(-1) as { usage?: unknown }).usage, { input: 3, output: 1 });
});
