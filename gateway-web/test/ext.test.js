import { test } from "node:test";
import assert from "node:assert/strict";
import { createExt, notifySessionCreated } from "../assets/lib/ext.js";
import { store } from "../assets/lib/store.js";

test("local creation hooks are awaited and global session lists never invoke them", async () => {
  const ext = createExt({ package: "@review/projects" });
  const called = [];
  let complete;
  const stop = ext.sessions.onCreate(async (id) => {
    called.push(id);
    await new Promise((resolve) => { complete = resolve; });
  });
  try {
    store.set({ sessions: [{ id: "s_elsewhere" }] });
    assert.deepEqual(called, []);
    let ready = false;
    const created = notifySessionCreated("s_here").then(() => { ready = true; });
    await Promise.resolve();
    assert.deepEqual(called, ["s_here"]);
    assert.equal(ready, false);
    complete();
    await created;
    assert.equal(ready, true);
  } finally { stop(); }
  await notifySessionCreated("s_later");
  assert.deepEqual(called, ["s_here"]);
});

test("a creation setup failure rejects before the conversation can be used", async () => {
  const ext = createExt({ package: "@review/projects" });
  const stop = ext.sessions.onCreate(async () => { throw new Error("assignment failed"); });
  try {
    await assert.rejects(notifySessionCreated("s_a"), /assignment failed/);
  } finally { stop(); }
});
