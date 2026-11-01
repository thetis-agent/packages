// The "Workflow runs" group: claimed on a gateway with `ext.sessions.group`, its test holds the run
// conversations the service names, the service is asked again only when the list shows a new conversation,
// and the group is claimed again when the set grew. An older gateway gets nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldRunConversations, unseen } from "../ui/folder.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("unseen: the list's ids this page has not seen", () => {
  assert.deepEqual(unseen([{ id: "s_a" }, null, { id: "s_b" }, { id: 3 }], new Set(["s_a"])), ["s_b"]);
  assert.deepEqual(unseen(undefined, new Set()), []);
});

test("the group's test claims the run conversations; a new row asks again, and growth claims the group again", async () => {
  let list = [{ id: "s_plan" }, { id: "s_chat" }];
  let onList = () => {};
  let asks = 0;
  let ids = ["s_plan", "s_gone"];
  const claims = [];
  const ext = {
    sessions: { list: () => list, watch: (fn) => { onList = fn; }, group: (id, spec) => claims.push({ id, ...spec }) },
    request: async (_verb, { args }) => {
      assert.equal(args.op, "runConversations");
      asks++;
      return { data: { ids } };
    },
  };
  foldRunConversations(ext, { delayMs: 5 });
  assert.equal(claims.length, 1, "claimed at once, empty");
  assert.equal(claims[0].id, "runs");
  assert.equal(claims[0].label, "Workflow runs");
  await wait(30);
  assert.equal(asks, 1);
  assert.equal(claims.length, 2, "the set grew: claimed again");
  const test_ = claims.at(-1).test;
  assert.equal(test_({ id: "s_plan" }), true);
  assert.equal(test_({ id: "s_chat" }), false, "a person's conversation stays in the list");
  onList();
  await wait(30);
  assert.equal(asks, 1, "nothing new in the list: no second ask");
  list = [...list, { id: "s_verify" }];
  ids = ["s_plan", "s_gone", "s_verify"];
  onList();
  await wait(30);
  assert.equal(asks, 2);
  assert.equal(claims.length, 3);
  assert.equal(claims.at(-1).test({ id: "s_verify" }), true);
  list = [...list, { id: "s_mine" }];
  onList();
  await wait(30);
  assert.equal(asks, 3);
  assert.equal(claims.length, 3, "the set did not grow: not claimed again");
});

test("an older gateway without ext.sessions.group gets nothing, and the service is not asked", async () => {
  let asks = 0;
  const ext = { sessions: { list: () => [{ id: "s_a" }], watch: () => {} }, request: async () => { asks++; return { data: { ids: [] } }; } };
  assert.equal(foldRunConversations(ext, { delayMs: 1 }), null);
  await wait(10);
  assert.equal(asks, 0);
});

test("a refused ask (an older service) is retried, then given up", async () => {
  let asks = 0;
  const ext = { sessions: { list: () => [{ id: "s_a" }], watch: () => {}, group: () => {} }, request: async () => { asks++; throw new Error("unknown op"); } };
  foldRunConversations(ext, { delayMs: 1, retryMs: 2 });
  await wait(120);
  assert.equal(asks, 6, "the first ask and five retries");
});
