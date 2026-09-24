// The engine against a fake kernel: no socket, no queue, one run at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTINUE_MESSAGE, DEFAULT_NUDGE, decide, executeRun, retry } from "../lib/engine.js";
import { newRun } from "../lib/runs.js";
import { normalise } from "../lib/definition.js";
import { fakeKernel, makeEnv, reply, text, toolCall } from "./helpers.js";

const def = (steps, extra = {}) => normalise({ id: "wf_1a2b3c4d", name: "Test", version: 1, start: Object.keys(steps)[0], steps, ...extra });

async function go(t, definition, script, { input = "https://notion.so/bug-a", cap = 40, tools = {}, run } = {}) {
  const kernel = fakeKernel(script);
  const f = await makeEnv({ kernel, tools });
  t.after(f.done);
  run = run ?? newRun({ definition, input, number: 1, costCapUsd: cap, id: "r_0000000001" });
  const saves = [];
  const deps = { kernel, env: f.env, save: (r) => saves.push(structuredClone(r)), touch: () => {}, user: "alice", graceMs: 2000, transientWaitMs: 1 };
  await executeRun(run, definition, deps);
  return { run, kernel, env: f.env, home: f.home, invoked: f.invoked, saves, deps };
}

test("a full run: tool, parse, prompt on a new conversation, the same conversation on another model, parse, branch, loop, done", async (t) => {
  const definition = def(
    {
      lookup: { type: "tool", package: "@thetis/notion", export: "fetch", name: "notion_fetch", args: { url: "{{input}}" }, next: "meta" },
      meta: { type: "parse", from: "lookup", fields: { title: "^Title: (.+)$" }, next: "plan" },
      plan: { type: "prompt", model: "fable", conversation: "new", title: "Fix: {{meta.title}}", prompt: "Plan the fix for {{input}}.", budget: { toolCalls: 50 }, next: "impl" },
      impl: { type: "prompt", model: "opus", conversation: "plan", prompt: "Implement the plan. End with RESULT: PASS or RESULT: FAIL.", budget: { toolCalls: 50 }, next: "verdict" },
      verdict: { type: "parse", from: "impl", fields: { result: "^RESULT: (\\w+)" }, next: "route" },
      route: { type: "branch", on: "{{verdict.result}}", cases: { PASS: "finish", FAIL: "again" } },
      again: { type: "loop", target: "impl", max: 1, exhausted: "stuck" },
      finish: { type: "done", summary: "Fixed {{meta.title}}: {{verdict.result}} after {{again.count}} retry" },
      stuck: { type: "needs", reason: "still failing" },
    },
    { project: "p_624f67bc" },
  );
  let impls = 0;
  const script = (call) => {
    if (call.model === "fable") return [toolCall("read_path", { path: "src/game.ts" }), ...reply("The plan.", { prompt_tokens: 5000, cost: 1.25 })];
    impls++;
    return [
      toolCall("shell", { cmd: "dotnet test" }),
      ...reply(impls === 1 ? "Tried.\nRESULT: FAIL" : "Fixed it.\nRESULT: PASS", { prompt_tokens: 9000 * impls, cost: 2 }),
    ];
  };
  const { run, kernel, env, invoked } = await go(t, definition, script, {
    tools: { notion_fetch: (args) => ({ type: "tool-result", content: text(`Title: Bug A\nURL: ${args.url}`) }) },
  });

  assert.equal(run.state, "done", run.reason);
  assert.equal(run.reason, "Fixed Bug A: PASS after 1 retry");
  assert.deepEqual(invoked[0].args, { url: "https://notion.so/bug-a" });
  assert.equal(invoked[0].opts.session.user, "alice");
  assert.deepEqual(invoked[0].opts.config, { package: "@thetis/notion" });

  // One conversation, three turns: the plan on fable, the implementation twice on opus.
  assert.deepEqual(kernel.sends.map((s) => s.model), ["fable", "opus", "opus"]);
  assert.equal(new Set(kernel.sends.map((s) => s.session)).size, 1);
  assert.equal(kernel.sends[0].input, "Fix: Bug A\n\nPlan the fix for https://notion.so/bug-a.");
  assert.deepEqual(run.conversations, [kernel.sends[0].session]);
  assert.deepEqual(run.titles, { [kernel.sends[0].session]: "Fix: Bug A" }, "the title is kept for the page to name the conversation");
  const assignments = JSON.parse(await env.readFile("projects/sessions.json"));
  assert.deepEqual(assignments, { [kernel.sends[0].session]: "p_624f67bc" });

  assert.equal(run.vars.meta.title, "Bug A");
  assert.equal(run.vars.meta.matched, "true");
  assert.equal(run.vars.meta.source, "lookup");
  assert.equal(run.vars.plan.text, "The plan.");
  assert.equal(run.vars.plan.tokens, 5000);
  assert.equal(run.vars.impl.text, "Fixed it.\nRESULT: PASS");
  assert.equal(run.vars.impl.conversation, kernel.sends[0].session);
  assert.equal(run.vars.verdict.result, "PASS");
  assert.equal(run.vars.again.count, 1);
  assert.equal(run.vars.route.value, "PASS");

  assert.deepEqual(
    run.history.map((h) => `${h.step}:${h.status}`),
    ["lookup:done", "meta:done", "plan:done", "impl:done", "verdict:done", "route:done", "again:done", "impl:done", "verdict:done", "route:done", "finish:done"],
  );
  const plan = run.history[2];
  assert.equal(plan.model, "fable");
  assert.equal(plan.toolCalls, 1);
  assert.equal(plan.cost, 1.25);
  assert.deepEqual(plan.activity, ['read_path: {"path":"src/game.ts"}']);
  // usage events and the message's copy of the same usage are counted once
  assert.equal(run.cost, 5.25);
});

test("parse from a list reads whichever listed step finished last", async (t) => {
  const definition = def({
    impl: { type: "prompt", model: "opus", prompt: "Do it.", budget: { toolCalls: 9 }, next: "check" },
    check: { type: "parse", from: ["impl", "fix"], fields: { result: "RESULT: (\\w+)" }, next: "route" },
    route: { type: "branch", on: "{{check.result}}", cases: { FAIL: "fix", PASS: "finish" } },
    fix: { type: "prompt", model: "sonnet", conversation: "impl", prompt: "Fix what failed.", budget: { toolCalls: 9 }, next: "check" },
    finish: { type: "done", summary: "{{check.source}} said {{check.result}}" },
  });
  const script = (call) => reply(call.model === "opus" ? "RESULT: FAIL" : "RESULT: PASS");
  const { run, kernel } = await go(t, definition, script);
  assert.equal(run.state, "done", run.reason);
  assert.equal(run.reason, "fix said PASS");
  assert.deepEqual(kernel.sends.map((s) => s.model), ["opus", "sonnet"]);
  assert.equal(run.vars.check.text, "RESULT: PASS");
  assert.equal(run.vars.check.source, "fix");
});

test("a budget breach cancels and nudges; a second breach takes onBreach", async (t) => {
  const definition = def({
    work: { type: "prompt", model: "opus", prompt: "Explore.", budget: { toolCalls: 2 }, nudge: "Wrap up {{input}} now.", onBreach: "stuck", next: "finish" },
    finish: { type: "done", summary: "ok" },
    stuck: { type: "needs", reason: "Over budget: {{work.text}}" },
  });
  const script = (call) => [toolCall("grep"), toolCall("grep"), { type: "message", message: { role: "assistant", content: text(`partial ${call.n}`) } }, toolCall("grep"), { hang: true }];
  const { run, kernel } = await go(t, definition, script, { input: "bug" });
  assert.equal(run.state, "needs", run.reason);
  assert.equal(run.reason, "Over budget: partial 1");
  assert.equal(kernel.sends.length, 2);
  assert.equal(kernel.sends[1].input, "Wrap up bug now.");
  assert.equal(kernel.sends[1].model, "opus");
  assert.equal(kernel.sends[1].session, kernel.sends[0].session);
  assert.deepEqual(kernel.cancels, [kernel.sends[0].session, kernel.sends[0].session]);
  const entry = run.history.find((h) => h.step === "work");
  assert.equal(entry.breaches, 2);
  assert.equal(entry.toolCalls, 6);
});

test("the default nudge, and a nudged turn that finishes goes on", async (t) => {
  const definition = def({
    work: { type: "prompt", model: "opus", prompt: "Explore.", budget: { tokens: 100 }, next: "finish" },
    finish: { type: "done", summary: "{{work.text}}" },
  });
  const script = (call) => (call.n === 0 ? [{ type: "usage", usage: { prompt_tokens: 500, cost: 0.01 } }, { hang: true }] : reply("Done, unverified: x.", { prompt_tokens: 50, cost: 0.01 }));
  const { run, kernel } = await go(t, definition, script);
  assert.equal(run.state, "done", run.reason);
  assert.equal(kernel.sends[1].input, DEFAULT_NUDGE);
  assert.equal(run.reason, "Done, unverified: x.");
});

test("reaching the cost cap cancels the turn and ends the run as needs-you", async (t) => {
  const definition = def({
    work: { type: "prompt", model: "opus", prompt: "Spend.", budget: { toolCalls: 99 }, next: "finish" },
    finish: { type: "done", summary: "ok" },
  });
  const script = () => [{ type: "usage", usage: { prompt_tokens: 10, cost: 0.6 } }, { type: "usage", usage: { prompt_tokens: 10, cost: 0.6 } }, { hang: true }];
  const { run, kernel } = await go(t, definition, script, { cap: 1 });
  assert.equal(run.state, "needs");
  assert.equal(run.reason, "Cost cap of $1 reached");
  assert.equal(run.cost, 1.2);
  assert.equal(kernel.cancels.length, 1);
});

test("a parse miss sends the follow-up once to the same conversation and model, then parses again", async (t) => {
  const definition = def({
    work: { type: "prompt", model: "sonnet", prompt: "Verify.", budget: { toolCalls: 9 }, next: "check" },
    check: { type: "parse", from: "work", fields: { result: "^RESULT: (\\w+)$" }, followUp: "End with a RESULT line.", next: "finish" },
    finish: { type: "done", summary: "{{check.result}}" },
  });
  const script = (call) => reply(call.n === 0 ? "Looks fine to me." : "RESULT: PASS");
  const { run, kernel } = await go(t, definition, script);
  assert.equal(run.state, "done", run.reason);
  assert.equal(run.reason, "PASS");
  assert.equal(kernel.sends[1].input, "End with a RESULT line.");
  assert.equal(kernel.sends[1].model, "sonnet");
  assert.equal(kernel.sends[1].session, kernel.sends[0].session);
  assert.equal(run.vars.work.text, "RESULT: PASS");
  assert.equal(run.cost, 0.2);
});

test("a parse that still misses after the follow-up ends as needs-you", async (t) => {
  const definition = def({
    work: { type: "prompt", model: "sonnet", prompt: "Verify.", budget: { toolCalls: 9 }, next: "check" },
    check: { type: "parse", from: "work", fields: { result: "^RESULT: (\\w+)$" }, followUp: "RESULT line please.", next: "finish" },
    finish: { type: "done", summary: "" },
  });
  const { run, kernel } = await go(t, definition, () => reply("no"));
  assert.equal(run.state, "needs");
  assert.match(run.reason, /could not find result in the text of "work"/);
  assert.equal(kernel.sends.length, 2);
  assert.equal(run.vars.check.matched, "false");
});

test("an approval waits; approving queues the next step, and the run finishes", async (t) => {
  const definition = def({
    ask: { type: "approval", message: "Ship {{input}}?", next: "finish", onReject: "undo" },
    finish: { type: "done", summary: "shipped ({{ask.note}})" },
    undo: { type: "needs", reason: "rejected" },
  });
  const { run, deps } = await go(t, definition, () => [], { input: "v2" });
  assert.equal(run.state, "waiting");
  assert.equal(run.history.at(-1).note, "Ship v2?");
  decide(run, definition, "approved", "looks good");
  assert.equal(run.state, "queued");
  assert.equal(run.step, "finish");
  await executeRun(run, definition, deps);
  assert.equal(run.state, "done");
  assert.equal(run.reason, "shipped (looks good)");
  assert.deepEqual(run.vars.ask, { decision: "approved", note: "looks good" });
});

test("rejecting an approval with no onReject cancels the run", async (t) => {
  const definition = def({ ask: { type: "approval", message: "Ship?", next: "finish" }, finish: { type: "done", summary: "" } });
  const { run } = await go(t, definition, () => []);
  decide(run, definition, "rejected", "not yet");
  assert.equal(run.state, "cancelled");
  assert.equal(run.reason, 'Rejected at "ask": not yet');
  assert.throws(() => decide(run, definition, "approved"), /not waiting/);
});

test("an error event fails the step and the run", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", budget: { toolCalls: 9 }, next: "finish" }, finish: { type: "done", summary: "" } });
  const { run } = await go(t, definition, () => [{ type: "error", message: "the model refused the request: context too long", code: "provider" }]);
  assert.equal(run.state, "failed");
  assert.match(run.reason, /Step "work" failed: the model refused the request: context too long/);
  assert.equal(run.history[0].status, "failed");
});

test("provider trouble continues the same conversation, keeping the step's budget; the third time fails", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", budget: { toolCalls: 3 }, next: "finish" }, finish: { type: "done", summary: "{{work.text}}" } });
  const timeout = { type: "error", message: "provider error: no response from openrouter within 180s", code: "provider" };
  const { run, kernel } = await go(t, definition, (call) => (call.n === 0 ? [toolCall("read"), toolCall("read"), timeout] : reply("Plan written.")));
  assert.equal(run.state, "done", run.reason);
  assert.equal(run.reason, "Plan written.");
  assert.equal(kernel.sends.length, 2);
  assert.equal(kernel.sends[1].session, kernel.sends[0].session);
  assert.equal(kernel.sends[1].input, CONTINUE_MESSAGE);
  assert.equal(run.history[0].breaches, 0);

  // The budget carries across the continuation: two calls before the trouble, two after, over a budget of three.
  const over = await go(t, definition, (call) => (call.n === 0 ? [toolCall("a"), toolCall("b"), timeout] : call.n === 1 ? [toolCall("c"), toolCall("d")] : reply("ok")));
  assert.equal(over.run.history[0].breaches, 1, "the carried count breached the budget");

  const down = await go(t, definition, () => [timeout]);
  assert.equal(down.run.state, "failed");
  assert.equal(down.kernel.sends.length, 3);
  assert.match(down.run.reason, /no response from openrouter/);
});

test("retrying a run at the prompt step it failed in continues that conversation", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", conversation: "new", next: "finish" }, finish: { type: "done", summary: "{{work.text}}" } });
  let down = true;
  const { run, kernel, deps } = await go(t, definition, () => (down ? [{ type: "error", message: "provider error: 503", code: "provider" }] : reply("Recovered.")));
  assert.equal(run.state, "failed");
  const conversation = run.history[0].conversation;
  const opened = kernel.creates ?? null;
  down = false;
  retry(run, definition);
  assert.equal(run.state, "queued");
  assert.equal(run.history[0].status, "running");
  await executeRun(run, definition, deps);
  assert.equal(run.state, "done", run.reason);
  assert.equal(run.reason, "Recovered.");
  assert.equal(kernel.sends.at(-1).session, conversation);
  assert.equal(kernel.sends.at(-1).input, CONTINUE_MESSAGE);
  assert.equal(run.conversations.length, 1, "no new conversation");
  assert.equal(run.resume, undefined);
  void opened;

  // From another step, or a step that never opened a conversation, a retry starts that step afresh.
  run.state = "failed";
  retry(run, definition, "work");
  assert.equal(run.resume, undefined);
});

test("a rejected send fails the run; a tool error takes onError or fails", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", budget: { toolCalls: 9 }, next: "finish" }, finish: { type: "done", summary: "" } });
  const { run } = await go(t, definition, () => [{ throw: "session is busy" }]);
  assert.equal(run.state, "failed");
  assert.match(run.reason, /session is busy/);

  const tooling = def({
    get: { type: "tool", package: "p", export: "e", name: "t", args: {}, next: "finish", onError: "fallback" },
    finish: { type: "done", summary: "" },
    fallback: { type: "needs", reason: "tool said {{get.error}}" },
  });
  const a = await go(t, tooling, () => [], { tools: { t: () => "error: no such page" } });
  assert.equal(a.run.state, "needs");
  assert.equal(a.run.reason, "tool said no such page");
  delete tooling.steps.get.onError;
  const b = await go(t, tooling, () => [], { tools: { t: () => { throw new Error("boom"); } } });
  assert.equal(b.run.state, "failed");
  assert.match(b.run.reason, /Tool step "get" \(t\) failed: boom/);
});

test("retry queues an ended run again from its step, keeping its vars", async (t) => {
  const definition = def({ a: { type: "needs", reason: "stop" } });
  const { run } = await go(t, definition, () => []);
  run.vars.keep = { x: 1 };
  retry(run, definition);
  assert.equal(run.state, "queued");
  assert.equal(run.step, "a");
  assert.deepEqual(run.vars.keep, { x: 1 });
  assert.throws(() => retry(run, definition), /only an ended run can be retried/);
  run.state = "failed";
  assert.throws(() => retry(run, definition, "zz"), /no step "zz"/);
});

// ---- resume ----

function leftRunning(definition, conversation) {
  const run = newRun({ definition, input: "x", number: 1, costCapUsd: 40, id: "r_00000000aa" });
  run.state = "running";
  run.step = "work";
  run.conversations = [conversation];
  run.history.push({ step: "work", type: "prompt", status: "running", startedAt: new Date().toISOString(), model: "opus", conversation, toolCalls: 3, tokens: 100, cost: 0.5, ms: 0, breaches: 0, activity: [] });
  run.cost = 0.5;
  return run;
}

test("resume: an idle conversation whose last message is an assistant reply counts as finished", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", budget: { toolCalls: 9 }, next: "finish" }, finish: { type: "done", summary: "{{work.text}}" } });
  const kernel = fakeKernel(() => reply("should not be sent"));
  const f = await makeEnv({ kernel });
  t.after(f.done);
  kernel.sessions._set("s_prev01", { conversation: [{ role: "user", content: text("x") }, { role: "assistant", content: text("All done.") }] });
  const run = leftRunning(definition, "s_prev01");
  await executeRun(run, definition, { kernel, env: f.env, save: () => {}, resume: true });
  assert.equal(run.state, "done");
  assert.equal(run.reason, "All done.");
  assert.equal(kernel.sends.length, 0);
  assert.equal(run.history.length, 2);
  assert.equal(run.history[0].status, "done");
});

test("resume: otherwise the running turn is cancelled and the continue message is sent once", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", budget: { toolCalls: 9 }, next: "finish" }, finish: { type: "done", summary: "{{work.text}}" } });
  const kernel = fakeKernel(() => reply("Picked it back up."));
  const f = await makeEnv({ kernel });
  t.after(f.done);
  kernel.sessions._set("s_prev02", { status: "running", conversation: [{ role: "user", content: text("x") }] });
  const inspect = kernel.sessions.inspect;
  let asked = 0;
  kernel.sessions.inspect = async (id) => {
    const rec = await inspect(id);
    if (asked++ > 0) rec.status = "idle"; // the cancel lands
    return rec;
  };
  const run = leftRunning(definition, "s_prev02");
  await executeRun(run, definition, { kernel, env: f.env, save: () => {}, resume: true });
  assert.equal(run.state, "done", run.reason);
  assert.deepEqual(kernel.cancels, ["s_prev02"]);
  assert.equal(kernel.sends.length, 1);
  assert.equal(kernel.sends[0].input, CONTINUE_MESSAGE);
  assert.equal(kernel.sends[0].session, "s_prev02");
  assert.equal(run.reason, "Picked it back up.");
  assert.equal(run.history[0].toolCalls, 3); // the step's counts carry on
  assert.equal(run.cost, 0.6);
});

test("aborting the signal stops the run where it is without changing its state", async (t) => {
  const definition = def({ work: { type: "prompt", model: "opus", prompt: "x", budget: { toolCalls: 9 }, next: "finish" }, finish: { type: "done", summary: "" } });
  const kernel = fakeKernel(() => [{ hang: true }]);
  const f = await makeEnv({ kernel });
  t.after(f.done);
  const run = newRun({ definition, input: "x", number: 1, costCapUsd: 40 });
  const controller = new AbortController();
  const done = executeRun(run, definition, { kernel, env: f.env, save: () => {}, signal: controller.signal });
  while (!kernel.sends.length) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await done;
  assert.equal(run.state, "running");
  assert.equal(run.history[0].status, "running");
});
