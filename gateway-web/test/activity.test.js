// What a stall and a nudge do to a conversation's row. The rule the assertions are here to hold: a stall
// never makes a row stop saying "working", because the work has not stopped -- it has only gone quiet, and
// the row has to say which of those it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyActivity } from "../assets/lib/activity.js";
import { store } from "../assets/lib/store.js";

const SESSION = "s_activity_test";

/** A row in the middle of a tool call, which is where a stall finds it. */
function working() {
  store.setActivity(SESSION, null);
  applyActivity(SESSION, { type: "turn.start" }, new Date().toISOString());
  applyActivity(SESSION, { type: "tool.call", call: { id: "c1", name: "shell" } });
  return store.activityOf(SESSION);
}

test("a stalled tool keeps the row working and says what has gone quiet", () => {
  assert.deepEqual([working().state, store.activityOf(SESSION).step], ["working", "shell"]);
  applyActivity(SESSION, { type: "stall", what: { kind: "tool", id: "c1", name: "shell" }, ms: 120_000 });
  const row = store.activityOf(SESSION);
  assert.equal(row.state, "working", "a stall is not a stop and not a failure");
  assert.equal(row.step, "shell · quiet");
  assert.equal(row.tool, true);
});

test("a continue says the waiting goes on; a cancel leaves the row to what follows it", () => {
  working();
  applyActivity(SESSION, { type: "stall", what: { kind: "tool", id: "c1", name: "shell" }, ms: 120_000 });
  applyActivity(SESSION, { type: "nudge", what: { kind: "tool", id: "c1", name: "shell" }, ms: 121_000, decision: "continue", by: "model", why: "a build takes minutes" });
  assert.equal(store.activityOf(SESSION).step, "shell · still waiting");
  assert.equal(store.activityOf(SESSION).state, "working");

  applyActivity(SESSION, { type: "nudge", what: { kind: "tool", id: "c1", name: "shell" }, ms: 240_000, decision: "cancel", by: "rule", why: "nobody could be asked" });
  assert.equal(store.activityOf(SESSION).step, "shell · still waiting", "the cancel changes nothing here: the tool result that follows does");
  applyActivity(SESSION, { type: "tool.result", id: "c1", name: "shell", result: "error: cancelled" });
  assert.equal(store.activityOf(SESSION).step, "Thinking");
});

test("a model that has gone quiet is named as such, and a finished row is not revived by a late event", () => {
  working();
  applyActivity(SESSION, { type: "stall", what: { kind: "model", id: "t1#2", name: "vendor/model" }, ms: 60_000 });
  assert.equal(store.activityOf(SESSION).step, "Waiting on the model");
  assert.equal(store.activityOf(SESSION).tool, false);
  applyActivity(SESSION, { type: "nudge", what: { kind: "model", id: "t1#2", name: "vendor/model" }, ms: 61_000, decision: "continue", by: "model", why: "it is thinking" });
  assert.equal(store.activityOf(SESSION).step, "Still waiting on the model");

  store.setActivity(SESSION, null);
  applyActivity(SESSION, { type: "stall", what: { kind: "tool", id: "c1", name: "shell" }, ms: 1 });
  assert.equal(store.activityOf(SESSION), null, "a stall for a conversation with no live turn starts nothing");
  applyActivity(SESSION, { type: "nudge", what: { kind: "tool", id: "c1", name: "shell" }, ms: 1, decision: "continue", by: "model", why: "" });
  assert.equal(store.activityOf(SESSION), null);
});
