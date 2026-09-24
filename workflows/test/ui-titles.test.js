import { test } from "node:test";
import assert from "node:assert/strict";
import { nameRunConversations, toCheck, toName } from "../ui/titles.js";

test("only unnamed sessions not yet checked are asked about, and only titled ones are named", () => {
  const checked = new Set(["s_seen"]);
  const ids = toCheck([{ id: "s_a", named: false }, { id: "s_b", named: true }, { id: "s_seen", named: false }, null], checked);
  assert.deepEqual(ids, ["s_a"]);
  assert.deepEqual(toName(["s_a", "s_x"], { s_a: " Bug 1083 · verify ", s_x: "" }), [{ id: "s_a", title: "Bug 1083 · verify" }]);
});

test("a run's conversations are named once, a person's name is left alone, and the service is asked once per id", async () => {
  let list = [{ id: "s_plan", named: false }, { id: "s_mine", named: true }, { id: "s_chat", named: false }];
  let onList = () => {};
  let asks = 0;
  const posted = [];
  const ext = {
    sessions: { list: () => list, watch: (fn) => { onList = fn; } },
    request: async () => { asks++; return { data: { s_plan: "Bug 1083: Spots", s_mine: "should not apply", s_verify: "Bug 1083 · verify" } }; },
  };
  nameRunConversations(ext, { delayMs: 5, post: async (id, title) => { posted.push([id, title]); } });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(posted, [["s_plan", "Bug 1083: Spots"]]);
  assert.equal(asks, 1);
  onList(); // a list change with nothing new: no second ask
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asks, 1);
  list = [...list, { id: "s_verify", named: false }]; // the run opens another conversation
  onList();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asks, 2);
  assert.deepEqual(posted.at(-1), ["s_verify", "Bug 1083 · verify"]);
});

test("a refused ask is retried on its own, without waiting for the list to change", async () => {
  let asks = 0;
  const posted = [];
  const ext = {
    sessions: { list: () => [{ id: "s_plan", named: false }], watch: () => {} },
    request: async () => { asks++; if (asks === 1) throw new Error("the workflow service is not running"); return { data: { s_plan: "Bug 1: x" } }; },
  };
  nameRunConversations(ext, { delayMs: 5, retryMs: 10, post: async (id, title) => { posted.push([id, title]); } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(asks, 2);
  assert.deepEqual(posted, [["s_plan", "Bug 1: x"]]);
});
