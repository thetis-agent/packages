import { test } from "node:test";
import assert from "node:assert/strict";
import { nameRunConversations, toApply, toCheck } from "../ui/titles.js";

test("sessions missing a name or a model are asked about once; only what is missing is applied", () => {
  const checked = new Set(["s_seen"]);
  const sessions = [
    { id: "s_a", named: false },
    { id: "s_b", named: true, model: "mine" },
    { id: "s_c", named: true },
    { id: "s_seen", named: false },
    null,
  ];
  const ids = toCheck(sessions, checked);
  assert.deepEqual(ids, ["s_a", "s_c"]);
  const known = { s_a: { title: " Bug 1083 · verify ", model: "anthropic/claude-sonnet-5" }, s_c: { title: "not applied", model: "anthropic/claude-opus-4.8" } };
  assert.deepEqual(toApply(ids, sessions, known), [
    { id: "s_a", title: "Bug 1083 · verify", model: "anthropic/claude-sonnet-5" },
    { id: "s_c", model: "anthropic/claude-opus-4.8" },
  ]);
});

test("a run's conversations are named once, a person's choices are left alone, and the service is asked once per id", async () => {
  let list = [{ id: "s_plan", named: false }, { id: "s_mine", named: true, model: "x" }, { id: "s_chat", named: false }];
  let onList = () => {};
  let asks = 0;
  const posted = [];
  const ext = {
    sessions: { list: () => list, watch: (fn) => { onList = fn; } },
    request: async (_verb, { args }) => {
      assert.equal(args.op, "conversations");
      asks++;
      return { data: { s_plan: { title: "Bug 1083: Spots", model: "opus" }, s_mine: { title: "no", model: "no" }, s_verify: { title: "Bug 1083 · verify", model: "sonnet" } } };
    },
  };
  nameRunConversations(ext, { delayMs: 5, post: async (change) => { posted.push(change); } });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(posted, [{ id: "s_plan", title: "Bug 1083: Spots", model: "opus" }]);
  assert.equal(asks, 1);
  onList();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asks, 1, "nothing new: no second ask");
  list = [...list, { id: "s_verify", named: false }];
  onList();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asks, 2);
  assert.deepEqual(posted.at(-1), { id: "s_verify", title: "Bug 1083 · verify", model: "sonnet" });
});

test("a refused ask is retried on its own, without waiting for the list to change", async () => {
  let asks = 0;
  const posted = [];
  const ext = {
    sessions: { list: () => [{ id: "s_plan", named: false }], watch: () => {} },
    request: async () => { asks++; if (asks === 1) throw new Error("the workflow service is not running"); return { data: { s_plan: { title: "Bug 1: x" } } }; },
  };
  nameRunConversations(ext, { delayMs: 5, retryMs: 10, post: async (change) => { posted.push(change); } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(asks, 2);
  assert.deepEqual(posted, [{ id: "s_plan", title: "Bug 1: x" }]);
});
