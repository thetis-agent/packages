// The nudge: what a turn does when something in it goes quiet, and the guarantee that it can never end up
// stuck. The numbers here are the shipped ones divided by about a thousand, so a stall that takes two
// minutes in production takes forty milliseconds in this file and the shapes are the same.
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, ToolSpec, TurnEvent } from "@thetis/contracts";
import { callModel, cancelledToolResult, fmtMs, NUDGE_DEFAULTS, nudgeConfig, readDecision } from "../src/index.js";

const contextHome = mkdtempSync(join(tmpdir(), "thetis-context-test-"));
after(() => rmSync(contextHome, { recursive: true, force: true }));

/** The shipped numbers, scaled down. Everything in this file that waits, waits in tens of milliseconds. */
const FAST = { modelStallMs: 40, toolStallMs: 40, stallBackoff: 2, stallMaxMs: 400, nudgeMs: 40, nudgeAttempts: 2 };

type Answer = (n: number, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => Promise<void>;
type Script = (round: number, call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => Promise<void>;

/** The nudge answers with the `decide` tool call, the way it is meant to. */
const decides = (decision: "continue" | "cancel", why = "because"): Answer => async (n, onEvent) => {
  onEvent({ type: "tool_call", call: { id: `d${n}`, name: "decide", args: { decision, why } } });
};

/** The nudge is asked and never answers: the shape that must still end in a decision. */
const never: Answer = () => new Promise<void>(() => {});

/** The nudge is asked and the provider refuses. */
const errors = (message: string): Answer => async (_n, onEvent) => {
  onEvent({ type: "error", message });
};

/** The nudge answers, but with prose rather than the tool. */
const says = (text: string): Answer => async (_n, onEvent) => {
  onEvent({ type: "text", delta: text });
};

const tool = (name: string): ToolSpec => ({ name, description: "", parameters: {}, package: "@a/p", export: name });

interface Setup {
  script: Script;
  nudge?: Answer;
  invoke?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string | object>;
  effective?: () => Promise<Record<string, unknown>>;
  tools?: ToolSpec[];
  config?: Record<string, unknown>;
  conversation?: Message[];
  signal?: AbortSignal;
}

/** A turn whose provider, tools and nudge are all scripted, and a record of every event it emitted. */
function harness(setup: Setup) {
  const events: TurnEvent[] = [];
  const nudgeCalls: ProviderCall[] = [];
  let round = 0;
  let asked = 0;
  const ctx = {
    emit: (e: TurnEvent) => events.push(e),
    signal: setup.signal ?? new AbortController().signal,
    session: { id: "s1", user: "alice" },
    turn: { id: "t1", input: [{ role: "user", content: "go" }] },
    conversation: setup.conversation ?? [{ role: "user", content: "build the thing\n\n[Turn context: Monday 2026-09-22 10:00 UTC]" }],
    call: { model: "vendor/model", messages: [], tools: setup.tools ?? [], params: {} },
    harness: {},
    packages: { has: () => false, get: () => undefined, list: (): PackageInfo[] => [] },
    config: { ...FAST, ...(setup.config ?? {}) },
    env: {
      cwd: mkdtempSync(join(contextHome, "turn-")),
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
      invokeTool: async (_ref: unknown, args: Record<string, unknown>, opts: { signal?: AbortSignal }) => (setup.invoke ? setup.invoke(args, opts.signal) : "ran"),
      kernel: {
        providers: {
          call: (call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => {
            // A nudge is recognised by the one tool it offers, which is how the real thing looks on the wire.
            if (call.tools.some((t) => t.name === "decide")) {
              nudgeCalls.push(call);
              return (setup.nudge ?? decides("continue"))(++asked, onEvent, signal);
            }
            return setup.script(++round, call, onEvent, signal);
          },
        },
        config: { effective: setup.effective ?? (async () => ({})) },
      },
    },
  } as unknown as PackageStepContext;
  return { ctx, events, nudgeCalls, asked: () => asked };
}

const kinds = (events: TurnEvent[]) => events.filter((e) => e.type !== "context.updated").map((e) => e.type);
const firstOf = <T extends TurnEvent["type"]>(events: TurnEvent[], type: T) => events.find((e) => e.type === type) as Extract<TurnEvent, { type: T }> | undefined;
const allOf = <T extends TurnEvent["type"]>(events: TurnEvent[], type: T) => events.filter((e) => e.type === type) as Extract<TurnEvent, { type: T }>[];

/** Runs the step and fails loudly rather than hanging, because a hang is the bug this file is about. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`the turn had not ended after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---- the configuration ----

test("the numbers come from the configuration, and nothing in it can switch a bound off", () => {
  assert.deepEqual(nudgeConfig({}), { ...NUDGE_DEFAULTS, nudgeModel: undefined });
  const set = nudgeConfig({ modelStallMs: 5_000, toolStallMs: 10_000, stallBackoff: 3, stallMaxMs: 60_000, nudgeMs: 4_000, nudgeAttempts: 5, nudgeModel: " small/fast " });
  assert.deepEqual(set, { modelStallMs: 5_000, toolStallMs: 10_000, stallBackoff: 3, stallMaxMs: 60_000, nudgeMs: 4_000, nudgeAttempts: 5, nudgeModel: "small/fast" });
  // Zero, negative and nonsense all fall back to the default rather than meaning "never ask".
  const off = nudgeConfig({ modelStallMs: 0, toolStallMs: -1, nudgeMs: Infinity, nudgeAttempts: 0, stallBackoff: 0, nudgeModel: "   " });
  assert.equal(off.modelStallMs, NUDGE_DEFAULTS.modelStallMs);
  assert.equal(off.toolStallMs, NUDGE_DEFAULTS.toolStallMs);
  assert.equal(off.nudgeMs, NUDGE_DEFAULTS.nudgeMs);
  assert.equal(off.nudgeAttempts, NUDGE_DEFAULTS.nudgeAttempts, "at least one attempt is always made");
  assert.equal(off.stallBackoff, NUDGE_DEFAULTS.stallBackoff);
  assert.equal(off.nudgeModel, undefined);
  assert.equal(nudgeConfig({ stallBackoff: 0.5 }).stallBackoff, 1, "the allowance may stop growing; it may not shrink");
  assert.equal(nudgeConfig({ nudgeAttempts: 1.9 }).nudgeAttempts, 1, "attempts are whole");
});

test("readDecision takes the tool call first, falls back to the written word, and refuses to guess", () => {
  const call = (args: Record<string, unknown>) => [{ id: "d1", name: "decide", args }];
  assert.deepEqual(readDecision("", call({ decision: "continue", why: "a build takes minutes" })), { decision: "continue", by: "model", why: "a build takes minutes" });
  assert.deepEqual(readDecision("", call({ decision: "CANCEL", why: "" })), { decision: "cancel", by: "model", why: "the model said cancel and gave no reason" });
  assert.equal(readDecision("", call({ decision: "maybe", why: "x" })), undefined, "a decision that is neither word is no decision");
  assert.equal(readDecision("", []), undefined);
  assert.equal(readDecision("I am not sure what to do here.", []), undefined, "prose with neither word decides nothing");
  assert.equal(readDecision("continue", [])?.decision, "continue");
  assert.equal(readDecision("I would cancel rather than continue", [])?.decision, "cancel", "the first of the two words wins, which errs towards cancelling");
  assert.equal(readDecision("cancellation", [])?.decision, undefined, "a word inside another word is not an answer");
});

test("fmtMs and the cancelled result are worded for whoever reads them", () => {
  assert.equal(fmtMs(0), "0s");
  assert.equal(fmtMs(45_000), "45s");
  assert.equal(fmtMs(252_000), "4m 12s");
  assert.equal(fmtMs(3_700_000), "1h 1m");
  const text = cancelledToolResult("shell", 252_000, { ms: 240_000, by: "model", why: "a file read cannot take four minutes" });
  assert.match(text, /^error: `shell` was cancelled after running for 4m 12s\./);
  assert.match(text, /did not fail and it did not refuse/, "the model must not read this as the tool failing");
  assert.match(text, /a file read cannot take four minutes/, "the reason travels to the model, not only to the page");
  assert.match(text, /may still be running outside this turn/, "and it is told the work was left running");
  assert.match(text, /Do not issue the same call again unchanged/, "the point of telling it at all: so it chooses differently");
  assert.match(cancelledToolResult("t", 1, { ms: 1, by: "rule", why: "nobody could be asked" }), /the question could not be answered, so the rule cancelled it/);
});

// ---- a tool that goes quiet ----

test("a quiet tool is asked about while it keeps running, and a continue lets it finish normally", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "build", args: { cmd: "npm run build" } } });
    else onEvent({ type: "text", delta: "built" });
  };
  let finished = false;
  const { ctx, events, nudgeCalls } = harness({
    script,
    tools: [tool("build")],
    nudge: decides("continue", "a build takes minutes"),
    invoke: () => new Promise((done) => setTimeout(() => ((finished = true), done("build ok")), 260)),
  });
  const out = await within(3_000, callModel(ctx));

  const stalls = allOf(events, "stall");
  const nudges = allOf(events, "nudge");
  assert.ok(stalls.length >= 2, `the silence is asked about again after a continue (saw ${stalls.length})`);
  assert.equal(nudges.length, stalls.length, "every stall reached a decision");
  assert.deepEqual(stalls[0].what, { kind: "tool", id: "c1", name: "build" });
  assert.ok(stalls[0].ms >= FAST.toolStallMs, "the event says how long it had been quiet");
  for (const n of nudges) assert.deepEqual([n.decision, n.by], ["continue", "model"]);
  assert.equal(nudges[0].why, "a build takes minutes");
  assert.ok(stalls[1].ms > stalls[0].ms, "the allowance grew: the second question came after a longer silence than the first");

  assert.equal(finished, true, "the tool was never touched; it ran to the end");
  assert.deepEqual(
    out.conversation!.filter((m) => m.role === "tool").map((m) => m.content),
    ["build ok"],
    "a continued tool returns its own result, with nothing of the nudge in it",
  );
  assert.equal(out.conversation!.at(-1)!.content, "built");
  assert.ok(!events.some((e) => e.type === "error"));
  // The question is asked about the work, not with the work: the turn's own conversation is never resent.
  assert.ok(nudgeCalls.length >= 2);
  for (const c of nudgeCalls) {
    assert.equal(c.messages.length, 1, "one message: the situation. The turn's prompt may be a million tokens.");
    assert.deepEqual(c.tools.map((t) => t.name), ["decide"]);
    assert.match(c.messages[0].content, /The tool `build` has been running for/);
    assert.match(c.messages[0].content, /npm run build/, "what it was called with, so the decision can be an informed one");
    assert.match(c.messages[0].content, /The turn was asked to: build the thing$/m, "and what the person wanted, without the turn context line");
  }
  assert.match(nudgeCalls[1].messages[0].content, /already been continued once/);
});

test("a tool the model cancels comes back as a tool result that says so, and the turn carries on", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: { cmd: "sleep 99999" } } });
    else onEvent({ type: "text", delta: "I will try a smaller command." });
  };
  let stopped = false;
  const { ctx, events } = harness({
    script,
    tools: [tool("shell")],
    nudge: decides("cancel", "sleep 99999 will never finish"),
    invoke: (_args, signal) =>
      new Promise((_done, fail) => {
        signal?.addEventListener("abort", () => ((stopped = true), fail(Object.assign(new Error("stopped"), { code: "cancelled" }))), { once: true });
      }),
  });
  const out = await within(3_000, callModel(ctx));

  assert.equal(stopped, true, "the cancel reached the tool's own signal");
  const nudge = firstOf(events, "nudge")!;
  assert.deepEqual([nudge.decision, nudge.by, nudge.what.kind, nudge.what.name], ["cancel", "model", "tool", "shell"]);
  assert.equal(nudge.why, "sleep 99999 will never finish");

  const result = out.conversation!.find((m) => m.role === "tool")!;
  assert.equal(result.toolCallId, "c1");
  assert.match(result.content, /^error: `shell` was cancelled after running for /);
  assert.match(result.content, /sleep 99999 will never finish/);
  assert.match(result.content, /Do not issue the same call again unchanged/);
  assert.deepEqual(firstOf(events, "tool.result")!.result, result.content, "the page sees exactly what the model sees");

  assert.equal(out.conversation!.at(-1)!.content, "I will try a smaller command.", "the loop went on: one tool was cancelled, not the turn");
  assert.ok(!events.some((e) => e.type === "error"), "a cancelled tool is not a failed turn");
});

test("a nudge nobody answers cancels by rule, and says in the event and to the model that that is what happened", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: {} } });
    else onEvent({ type: "text", delta: "understood" });
  };
  const { ctx, events, asked } = harness({ script, tools: [tool("shell")], nudge: never, invoke: () => new Promise(() => {}) });
  const out = await within(3_000, callModel(ctx));

  assert.equal(asked(), FAST.nudgeAttempts, "the question got its attempts and no more");
  const nudge = firstOf(events, "nudge")!;
  assert.equal(nudge.decision, "cancel");
  assert.equal(nudge.by, "rule");
  assert.match(nudge.why, /nobody could be asked whether to keep waiting/);
  assert.match(nudge.why, /no answer within 0s|no answer within/, "and what went wrong with the asking");
  assert.match(nudge.why, /an unanswered question cancels rather than waits/, "the rule itself, in words a person can read");
  assert.match(out.conversation!.find((m) => m.role === "tool")!.content, /the question could not be answered, so the rule cancelled it/);
  assert.equal(out.conversation!.at(-1)!.content, "understood");
});

test("a nudge that fails every time is the same unanswerable case, and the failure is named", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: {} } });
    else onEvent({ type: "text", delta: "ok" });
  };
  const { ctx, events, asked } = harness({ script, tools: [tool("shell")], nudge: errors("openrouter 402: out of credit"), invoke: () => new Promise(() => {}) });
  await within(3_000, callModel(ctx));
  assert.equal(asked(), FAST.nudgeAttempts);
  const nudge = firstOf(events, "nudge")!;
  assert.deepEqual([nudge.decision, nudge.by], ["cancel", "rule"]);
  assert.match(nudge.why, /out of credit/, "the person is told why nobody could be asked, not just that nobody was");
});

test("an answer that decides nothing is retried once and then cancels by rule", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: {} } });
    else onEvent({ type: "text", delta: "ok" });
  };
  const { ctx, events, asked } = harness({ script, tools: [tool("shell")], nudge: says("It is hard to say either way."), invoke: () => new Promise(() => {}) });
  await within(3_000, callModel(ctx));
  assert.equal(asked(), FAST.nudgeAttempts);
  assert.match(firstOf(events, "nudge")!.why, /named neither continue nor cancel/);
});

test("the word in the prose is taken when the tool was not called", async () => {
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: {} } });
    else onEvent({ type: "text", delta: "ok" });
  };
  let n = 0;
  const { ctx, events } = harness({
    script,
    tools: [tool("shell")],
    nudge: says("cancel, that path does not exist"),
    invoke: () => new Promise((done) => (n += 1, setTimeout(() => done("late"), 5_000))),
  });
  await within(3_000, callModel(ctx));
  assert.equal(n, 1);
  const nudge = firstOf(events, "nudge")!;
  assert.deepEqual([nudge.decision, nudge.by], ["cancel", "model"]);
  assert.match(nudge.why, /that path does not exist/);
});

test("nothing a watcher does can throw: the page going away neither kills the process nor latches the asking", async () => {
  // `emit` throwing is the one way the asking itself can fail, and it fails from inside a timer, where an
  // exception is not a failed turn but a dead process. It must also not leave the watch mid-question for
  // ever, which would be the unbounded wait coming back through the one door this mechanism leaves open.
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: {} } });
    else onEvent({ type: "text", delta: "understood" });
  };
  // Only the watcher's own events throw: the rest of the loop's emitting is not what is under test here.
  const deaf = (h: ReturnType<typeof harness>) => {
    const record = h.ctx.emit;
    h.ctx.emit = (e) => {
      record(e);
      if (e.type === "stall" || e.type === "nudge") throw new Error("the page went away");
    };
    return h;
  };

  // The decision still lands and still acts, with nobody listening to any of it.
  const cancelling = deaf(harness({ script, tools: [tool("shell")], nudge: decides("cancel", "it will not finish"), invoke: () => new Promise(() => {}) }));
  const stopped = await within(3_000, callModel(cancelling.ctx));
  assert.match(stopped.conversation!.find((m) => m.role === "tool")!.content, /was cancelled after running for/);
  assert.equal(stopped.conversation!.at(-1)!.content, "understood");

  // And the asking is not stuck after one throw: the second question is put, and the tool that does
  // finish is left to finish, which is what a continue means.
  let done = false;
  const continuing = deaf(harness({ script, tools: [tool("shell")], nudge: decides("continue", "it is working"), invoke: () => new Promise((r) => setTimeout(() => ((done = true), r("built")), 220)) }));
  const out = await within(3_000, callModel(continuing.ctx));
  assert.ok(allOf(continuing.events, "stall").length >= 2, "a second question was put after the first throw");
  assert.equal(done, true);
  assert.deepEqual(out.conversation!.filter((m) => m.role === "tool").map((m) => m.content), ["built"]);
});

// ---- a model stream that goes quiet ----

test("a stream that opens and says nothing is asked about, and a cancel ends the turn keeping every tool round already done", async () => {
  const script: Script = async (round, _call, onEvent, signal) => {
    if (round === 1) {
      onEvent({ type: "tool_call", call: { id: "c1", name: "read", args: {} } });
      return;
    }
    onEvent({ type: "text", delta: "here is what I fou" });
    // ...and then nothing at all, for ever, until somebody decides otherwise.
    await new Promise<void>((_, fail) => signal?.addEventListener("abort", () => fail(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true }));
  };
  const { ctx, events } = harness({ script, tools: [tool("read")], nudge: decides("cancel", "it has sent nothing since the first few words"), invoke: async () => "the file" });
  const out = await within(3_000, callModel(ctx));

  const stall = firstOf(events, "stall")!;
  assert.equal(stall.what.kind, "model");
  assert.equal(stall.what.name, "vendor/model", "a model stall names the model");
  assert.equal(stall.what.id, "t1#2", "and which round of which turn it was");
  const nudge = firstOf(events, "nudge")!;
  assert.deepEqual([nudge.decision, nudge.by], ["cancel", "model"]);

  const error = firstOf(events, "error")!;
  assert.equal(error.code, "provider");
  assert.match(error.message, /the model call was cancelled after .* of silence/);
  assert.match(error.message, /it has sent nothing since the first few words/);

  assert.deepEqual(out.conversation!.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(out.conversation![2].content, "the file", "the tool round that was already done is kept");
  assert.equal(out.conversation!.at(-1)!.content, "here is what I fou", "and so are the words that did arrive");
});

test("a model call that never produces anything at all, with a provider that cannot be asked either, still ends", async () => {
  // The shape of the incident this was built for: the request is sent, the socket is open, and nothing ever
  // comes back -- so the question about it cannot be answered either, because it goes to the same place.
  const { ctx, events } = harness({ script: () => new Promise(() => {}), nudge: never });
  const out = await within(3_000, callModel(ctx));
  const nudge = firstOf(events, "nudge")!;
  assert.deepEqual([nudge.decision, nudge.by, nudge.what.kind], ["cancel", "rule", "model"]);
  assert.match(firstOf(events, "error")!.message, /the model call was cancelled after .* of silence/);
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user"], "nothing was invented; the turn simply ends with what it had");
});

// ---- the person's own cancel keeps working throughout ----

test("the person's stop wins over a nudge in flight: the turn stops at once and no decision is announced", async () => {
  const control = new AbortController();
  const script: Script = async (round, _call, onEvent) => {
    if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name: "shell", args: {} } });
    else onEvent({ type: "text", delta: "ok" });
  };
  const { ctx, events } = harness({ script, tools: [tool("shell")], nudge: never, invoke: () => new Promise(() => {}), signal: control.signal });
  // Stop the turn once the question has been asked but before the attempts run out.
  setTimeout(() => control.abort(), FAST.toolStallMs + 20);
  const out = await within(3_000, callModel(ctx));

  assert.ok(events.some((e) => e.type === "stall"), "the stall was announced before the person stopped it");
  assert.ok(!events.some((e) => e.type === "nudge"), "a decision about work the person already stopped is not worth announcing");
  assert.ok(!events.some((e) => e.type === "error"), "a stop is the kernel's one cancelled error, not this step's");
  assert.equal(out.conversation!.at(-1)!.content, "error: the turn was stopped before this tool ran");
});

// ---- the guarantee ----
//
// One fixture per wait a turn can make, each one arranged so that the wait never returns, and the same
// three assertions for all of them: it ended, it kept what it had, and it said why. Nothing here asserts
// how long it took or what was decided; the claim is only that there is no way in.

interface NeverEnds {
  what: string;
  setup: Setup;
  /** What must survive in the conversation: the turn is never thrown away whole. */
  keeps: string;
}

const round1 = (name: string): Script => async (round, _call, onEvent) => {
  if (round === 1) onEvent({ type: "tool_call", call: { id: "c1", name, args: {} } });
  else onEvent({ type: "text", delta: "I will try something else." });
};

const GUARANTEE: NeverEnds[] = [
  {
    what: "the model call never returns and the question about it is never answered",
    setup: { script: () => new Promise(() => {}), nudge: never },
    keeps: "the person's message",
  },
  {
    what: "the model call never returns and the question errors every time",
    setup: { script: () => new Promise(() => {}), nudge: errors("the provider is unreachable") },
    keeps: "the person's message",
  },
  {
    what: "the stream opens, sends a few words, and then goes silent for ever",
    setup: {
      script: async (round, _call, onEvent) => {
        if (round === 1) return onEvent({ type: "tool_call", call: { id: "c1", name: "t", args: {} } });
        onEvent({ type: "text", delta: "partly written" });
        return new Promise<void>(() => {});
      },
      tools: [tool("t")],
      invoke: async () => "a real result",
      nudge: never,
    },
    keeps: "a real result",
  },
  {
    what: "a tool never returns and never honours its signal",
    setup: { script: round1("t"), tools: [tool("t")], invoke: () => new Promise(() => {}), nudge: never },
    keeps: "I will try something else.",
  },
  {
    what: "a tool never returns and the question about it is never answered",
    setup: { script: round1("t"), tools: [tool("t")], invoke: () => new Promise(() => {}), nudge: never },
    keeps: "I will try something else.",
  },
  {
    what: "a tool never returns and every attempt at the question fails",
    setup: { script: round1("t"), tools: [tool("t")], invoke: () => new Promise(() => {}), nudge: errors("no provider serves the nudge model") },
    keeps: "I will try something else.",
  },
  {
    what: "a tool never returns and the question is answered with prose that decides nothing",
    setup: { script: round1("t"), tools: [tool("t")], invoke: () => new Promise(() => {}), nudge: says("hmm") },
    keeps: "I will try something else.",
  },
  {
    what: "reading a tool package's configuration never returns",
    setup: { script: round1("t"), tools: [tool("t")], effective: () => new Promise(() => {}), nudge: never },
    keeps: "I will try something else.",
  },
  {
    what: "nothing in the turn ever returns: not the model, not the tool, not the question",
    setup: { script: () => new Promise(() => {}), tools: [tool("t")], invoke: () => new Promise(() => {}), effective: () => new Promise(() => {}), nudge: never },
    keeps: "the person's message",
  },
];

for (const fixture of GUARANTEE) {
  test(`the guarantee: ${fixture.what} -- the turn still ends`, async () => {
    const { ctx, events } = harness(fixture.setup);
    const out = await within(5_000, callModel(ctx));

    // 1. It ended. Reaching this line is the assertion; `within` fails the test otherwise.
    assert.ok(out.conversation, "a step result came back");

    // 2. It kept what it had. Nothing a turn did is thrown away because a later wait went quiet.
    const record = JSON.stringify(out.conversation);
    if (fixture.keeps === "the person's message") assert.match(record, /build the thing/);
    else assert.ok(record.includes(fixture.keeps), `${fixture.keeps} is still in the conversation`);

    // 3. It said why, somewhere a person and the model can both read.
    const nudge = firstOf(events, "nudge");
    assert.ok(nudge, "a stall reached a decision");
    assert.ok(nudge.why.trim().length > 0, "and the decision came with a reason");
    const said = firstOf(events, "error")?.message ?? out.conversation!.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
    assert.match(said, /cancelled/, "and the turn says out loud what was cancelled and why");

    // 4. Every wait in it was bounded, and each bound ended in a decision somebody or some rule made.
    for (const stall of allOf(events, "stall")) {
      const answer = allOf(events, "nudge").find((n) => n.what.id === stall.what.id);
      assert.ok(answer, `the stall of ${stall.what.name} was decided, not left open`);
    }
    // 5. And the conversation is still one a provider will accept: every tool call has an answer.
    for (const m of out.conversation!) {
      for (const tc of m.toolCalls ?? []) {
        assert.ok(out.conversation!.some((x) => x.role === "tool" && x.toolCallId === tc.id), `the call ${tc.id} was answered, so the next turn is not refused`);
      }
    }
  });
}
