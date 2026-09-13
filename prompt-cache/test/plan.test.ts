import { test } from "node:test";
import assert from "node:assert/strict";
import { collapse, planBreakpoints, type Slot } from "../src/plan.js";

const slots = (roles: string[], unmarkable: number[] = []): Slot[] => roles.map((role, i) => ({ role, markable: !unmarkable.includes(i) }));

test("system and the final message are marked", () => {
  const plan = planBreakpoints(slots(["user", "assistant", "user"]), { hasSystem: true, anchorStride: 8, max: 4 });
  assert.equal(plan.system, true);
  assert.deepEqual(plan.messages, [2]);
});

test("never exceeds the budget", () => {
  const plan = planBreakpoints(slots(Array(61).fill("user")), { hasSystem: true, anchorStride: 2, max: 4 });
  assert.equal(plan.messages.length, 3, "system takes one of four");
  const two = planBreakpoints(slots(Array(61).fill("user")), { hasSystem: true, anchorStride: 2, max: 2 });
  assert.deepEqual(two.messages, [60], "the newest position wins when the budget is short");
});

test("anchors hold still while the conversation grows", () => {
  const first = planBreakpoints(slots(Array(20).fill("user")), { hasSystem: false, anchorStride: 8, max: 4 });
  const second = planBreakpoints(slots(Array(21).fill("user")), { hasSystem: false, anchorStride: 8, max: 4 });
  const shared = first.messages.filter((i) => second.messages.includes(i));
  assert.deepEqual(first.messages, [8, 16, 19]);
  assert.deepEqual(second.messages, [8, 16, 20]);
  assert.ok(shared.length >= 2, "two anchors survive the turn");
});

test("consecutive tool results collapse to one position", () => {
  const roles = ["user", "assistant", "tool", "tool", "tool", "assistant", "tool", "user"];
  const c = collapse(slots(roles));
  assert.equal(c.positions, 6);
  assert.deepEqual(c.lastIndexOf, [0, 1, 4, 5, 6, 7]);
  // With stride 2 the anchor at position 4 is the tool message 6, and position 2 is the last of the tool run.
  const plan = planBreakpoints(slots(roles), { hasSystem: false, anchorStride: 2, max: 4 });
  assert.deepEqual(plan.messages, [4, 6, 7]);
});

test("an unmarkable message hands its mark to the previous markable one", () => {
  // An assistant message that only carries tool calls has no content to mark.
  const plan = planBreakpoints(slots(["user", "assistant", "tool", "assistant"], [3]), { hasSystem: false, anchorStride: 0, max: 4 });
  assert.deepEqual(plan.messages, [2]);
  const none = planBreakpoints(slots(["assistant"], [0]), { hasSystem: false, anchorStride: 0, max: 4 });
  assert.deepEqual(none.messages, []);
});

test("no anchors when the stride is zero", () => {
  const plan = planBreakpoints(slots(Array(30).fill("user")), { hasSystem: true, anchorStride: 0, max: 4 });
  assert.deepEqual(plan.messages, [29]);
});
