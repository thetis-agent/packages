import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, KEY } from "../index.js";
import { normalise, normaliseAll } from "../lib/claims.js";
import { observe } from "../lib/observe.js";

const ctx = (over = {}) => ({
  turn: { id: "t_1", input: [] },
  conversation: [{ role: "user", content: "q" }],
  call: { model: "bench/r1/arm/t-1/0", system: "guide", messages: [], tools: [{ name: "exec" }], params: {} },
  harness: {},
  packages: { list: () => [{ name: "@thetis/harness-core", version: "0.1.0" }], has: () => false, get: () => undefined },
  ...over,
});

test("a well formed claim keeps every field the bench can use", () => {
  const claim = normalise("@a/x", {
    direct: ["cap.a"],
    offered: ["cap.b"],
    arm: "l1",
    reach: "catalogue",
    ranked: ["cap.b", "cap.a"],
    scores: { "cap.b": 0.9 },
    budgetBytes: 4096,
    droppedForBudget: ["cap.c"],
  });
  assert.deepEqual(claim, {
    package: "@a/x",
    direct: ["cap.a"],
    offered: ["cap.b"],
    arm: "l1",
    reach: "catalogue",
    ranked: ["cap.b", "cap.a"],
    scores: { "cap.b": 0.9 },
    budgetBytes: 4096,
    droppedForBudget: ["cap.c"],
  });
});

test("a malformed claim is dropped, not thrown, so one bad package cannot fail the turn", () => {
  assert.equal(normalise("@a/x", null), null);
  assert.equal(normalise("@a/x", "nonsense"), null);
  assert.deepEqual(normaliseAll({ "@a/x": null, "@a/y": { direct: ["cap.a"] } }), {
    "@a/y": { package: "@a/y", direct: ["cap.a"], offered: [] },
  });
});

test("junk inside a claim is filtered rather than trusted", () => {
  const claim = normalise("@a/x", { direct: ["ok", 7, null], offered: "not a list", reach: "teleport" });
  assert.deepEqual(claim.direct, ["ok"]);
  assert.deepEqual(claim.offered, []);
  assert.equal(claim.reach, undefined, "a reachability the contract does not define is not recorded");
});

test("the probe observes the call as the fence sees it in the bench phase", () => {
  const seen = observe(ctx());
  assert.equal(seen.model, "bench/r1/arm/t-1/0");
  assert.equal(seen.systemBytes, 5);
  assert.deepEqual(seen.tools, ["exec"]);
  assert.deepEqual(seen.packages, ["@thetis/harness-core@0.1.0"]);
  assert.equal(seen.conversation, 1);
});

test("collect appends a turn and keeps what earlier turns recorded", async () => {
  const first = await collect(ctx());
  assert.equal(first.harness[KEY].turns.length, 1);
  const second = await collect(ctx({ harness: first.harness, turn: { id: "t_2", input: [] } }));
  assert.deepEqual(second.harness[KEY].turns.map((t) => t.turn), ["t_1", "t_2"]);
});

test("collect preserves other packages' harness keys, which the kernel would otherwise replace", async () => {
  const out = await collect(ctx({ harness: { "@thetis/prompt-cache": { turns: 3 } } }));
  assert.deepEqual(out.harness["@thetis/prompt-cache"], { turns: 3 });
});

test("collect normalises the claims a package left for it", async () => {
  const out = await collect(ctx({ harness: { [KEY]: { claims: { "@a/x": { direct: ["cap.a"], junk: 1 } } } } }));
  assert.deepEqual(out.harness[KEY].claims, { "@a/x": { package: "@a/x", direct: ["cap.a"], offered: [] } });
});
