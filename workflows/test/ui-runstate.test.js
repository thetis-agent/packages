import assert from "node:assert/strict";
import { test } from "node:test";
import { costShare, entryMs, nodeStatuses, pathTaken, retryChoices, runLabel, visitCounts } from "../ui/runstate.js";
import { ago, duration, inputCount, inputRuns, money, positive, sortIssues } from "../ui/format.js";
import { sample } from "./ui-fixture.js";

const h = (step, status = "done", extra = {}) => ({ step, type: "x", status, ...extra });

test("node statuses: history decides, the current step takes the run's state, the rest are not reached", () => {
  const def = sample();
  const run = { state: "running", step: "verify", history: [h("lookup"), h("plan"), h("impl"), h("parse"), h("branch"), h("verify", "running")] };
  const st = nodeStatuses(run, def);
  assert.equal(st.lookup, "done");
  assert.equal(st.verify, "running");
  assert.equal(st.loop, "idle");
  assert.equal(st.done, "idle");
  assert.equal(nodeStatuses({ ...run, state: "waiting" }, def).verify, "waiting");
  const needs = nodeStatuses({ state: "needs", step: "impl", history: [h("lookup"), h("plan"), h("impl", "failed")] }, def);
  assert.equal(needs.impl, "failed");
  const breach = nodeStatuses({ state: "needs", step: "impl", history: [h("lookup"), h("plan"), h("impl", "running")] }, def);
  assert.equal(breach.impl, "needs");
  const skipped = nodeStatuses({ state: "done", step: "done", history: [h("lookup", "skipped"), h("done")] }, def);
  assert.equal(skipped.lookup, "skipped");
  assert.equal(skipped.done, "done");
  const cancelled = nodeStatuses({ state: "cancelled", step: "plan", history: [h("lookup"), h("plan", "running")] }, def);
  assert.equal(cancelled.plan, "cancelled");
});

test("the path taken is the consecutive pairs of the history, loops included", () => {
  const run = { state: "running", step: "impl", history: [h("impl"), h("parse"), h("branch"), h("verify"), h("loop"), h("impl", "running")] };
  const path = pathTaken(run);
  assert.ok(path.has("loop>impl"));
  assert.ok(path.has("impl>parse"));
  assert.ok(!path.has("parse>impl"));
  assert.equal(visitCounts(run).impl, 2);
  const queued = pathTaken({ step: "plan", history: [h("lookup")] });
  assert.ok(queued.has("lookup>plan"), "a run between steps still shows where it is going");
});

test("retry offers the stopped step first; cost share is clamped; durations run on for a live step", () => {
  const def = sample();
  assert.equal(retryChoices({ step: "impl" }, def)[0], "impl");
  assert.equal(retryChoices({ step: "gone" }, def)[0], "lookup");
  assert.equal(costShare({ cost: 10, costCapUsd: 40 }), 0.25);
  assert.equal(costShare({ cost: 50, costCapUsd: 40 }), 1);
  assert.equal(costShare({ cost: 1 }), null);
  assert.equal(entryMs({ ms: 5 }), 5);
  assert.equal(entryMs({ status: "running", startedAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-01T00:01:00Z")), 60000);
  assert.equal(entryMs({ status: "done", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:30Z" }), 30000);
  assert.equal(entryMs({ status: "done", startedAt: "2026-01-01T00:00:00Z" }), null);
  assert.equal(entryMs({}), null);
  assert.equal(runLabel("needs"), "needs you");
});

test("format helpers", () => {
  assert.equal(money(13.614), "$13.61");
  assert.equal(money(0.004), "$0.004");
  assert.equal(money(undefined), "$0.00");
  assert.equal(duration(540000), "9 min");
  assert.equal(duration(45000), "45 s");
  assert.equal(duration(3900000), "1 h 5 min");
  assert.equal(ago(new Date(Date.now() - 5 * 60000).toISOString()), "5 min ago");
  assert.equal(inputRuns("lines", "a\n\n  \nb\n"), 2);
  assert.equal(inputRuns("text", "  "), 0);
  assert.equal(inputCount("lines", "a\nb"), "2 lines, 2 runs");
  assert.equal(inputCount("text", "x"), "1 run");
  assert.equal(inputCount("lines", ""), "Nothing to queue yet");
  assert.equal(positive("250k"), 250000);
  assert.equal(positive("1.5M"), 1500000);
  assert.equal(positive("0"), undefined);
  assert.equal(positive("abc"), undefined);
  assert.equal(positive(""), undefined);
});

test("sortIssues puts errors first and marks each step with its worst level", () => {
  const s = sortIssues([
    { step: "a", level: "warn", message: "w1" },
    { level: "error", message: "e0" },
    { step: "a", level: "error", message: "e1" },
    { step: "b", level: "warn", message: "w2" },
    { nonsense: true },
  ]);
  assert.equal(s.errors, 2);
  assert.equal(s.warns, 2);
  assert.deepEqual(s.list.map((i) => i.message), ["e0", "e1", "w1", "w2"]);
  assert.deepEqual(s.byStep, { a: "error", b: "warn" });
});
