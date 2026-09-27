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

test("ext.open.place reaches another package's place by its id, its own first, or a full key", async () => {
  const registry = await import("../assets/lib/registry.js");
  const { bindShell, entryKey } = await import("../assets/lib/ext.js");
  registry.declare({ package: "@thetis/ui-marketplace", places: [{ id: "marketplace", label: "Extensions" }] });
  registry.declare({ package: "@review/own", places: [{ id: "notes", label: "Notes" }] });
  assert.equal(entryKey("places", "@thetis/compaction", "marketplace"), "@thetis/ui-marketplace#marketplace", "compaction's link to the marketplace");
  assert.equal(entryKey("places", "@review/own", "notes"), "@review/own#notes");
  assert.equal(entryKey("places", "@review/own", "@thetis/ui-marketplace#marketplace"), "@thetis/ui-marketplace#marketplace");
  assert.equal(entryKey("places", "@review/own", "nowhere"), "@review/own#nowhere", "nothing by that id: the package's own key, which opens nothing");
  const opened = [];
  bindShell({ openPlace: (key, params) => opened.push([key, params]) });
  createExt({ package: "@thetis/compaction" }).open.place("marketplace", { name: "@thetis/compaction" });
  assert.deepEqual(opened, [["@thetis/ui-marketplace#marketplace", { name: "@thetis/compaction" }]]);
});
