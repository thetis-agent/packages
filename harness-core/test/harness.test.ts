import { test } from "node:test";
import assert from "node:assert/strict";
import type { PackageInfo, PackageStepContext } from "@thetis/contracts";
import { attachTools, recordCall, systemPrompt, turnContext, turnContextLine, TURN_CONTEXT, type LastCall } from "../src/index.js";

const greet = {
  name: "@thetis/greet",
  version: "1.0.0",
  type: "tool",
  description: "Says hello",
  thetis: { type: "tool", tools: [{ name: "greet", description: "hi", export: "greet" }] },
} as unknown as PackageInfo;

/** A turn as the fence hands it to a step, after the built-in call: the reply is already in `call.messages`. */
function ctxWith(over: Partial<PackageStepContext> = {}): PackageStepContext {
  return {
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

test("systemPrompt appends to the system prompt, points at list_packages and does not list the packages itself", async () => {
  const ctx = ctxWith({ harness: { notes: "remember the cat" } });
  const result = await systemPrompt(ctx);
  assert.deepEqual(Object.keys(result), ["call"]);
  assert.ok(result.call!.system!.startsWith("You are Thetis.\n\n"), "what was there stays first");
  assert.match(result.call!.system!, /call list_packages/);
  assert.doesNotMatch(result.call!.system!, /@thetis\/greet@1\.0\.0/, "the package list is a tool's answer, not prompt text");
  assert.match(result.call!.system!, /## Session notes\nremember the cat/);
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
