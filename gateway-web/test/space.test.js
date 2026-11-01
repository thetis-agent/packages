// The space the person is in (lib/space.js) and the seams a package reaches it through: `ext.space`,
// `ext.sessions.group`, `ext.conversation.start` and the space `onCreate` hooks receive.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./dom-fixture.js";

const kept = new Map();
globalThis.localStorage = {
  getItem: (key) => kept.get(key) ?? null,
  setItem: (key, value) => kept.set(key, String(value)),
  removeItem: (key) => kept.delete(key),
};

const { groups, resetSpace, space } = await import("../assets/lib/space.js");
const { bindShell, createExt, notifySessionCreated } = await import("../assets/lib/ext.js");

function fresh() {
  kept.clear();
  resetSpace();
}

test("with no provider there is one space, null, whatever was remembered; a provider makes the remembered one current", () => {
  fresh();
  kept.set("thetis.space", "p_1");
  resetSpace();
  assert.equal(space.current, null, "nothing can name p_1 yet, so nothing is in it");
  assert.equal(space.of("s_a"), null);
  assert.equal(space.name(null), "");
  const seen = [];
  space.watch((at) => seen.push(at));
  const stop = space.provide({ of: () => "p_1", name: (id) => (id ? "One" : "No project") });
  assert.equal(space.current, "p_1");
  assert.deepEqual(seen, ["p_1"], "the provider's arrival moved the current space, and watchers heard it");
  assert.equal(space.name("p_1"), "One");
  stop();
  assert.equal(space.current, null);
  assert.deepEqual(seen, ["p_1", null]);
});

test("enter switches, persists and tells the watchers once; the same space again is a no-op", () => {
  fresh();
  space.provide({ of: () => null, name: () => "" });
  const seen = [];
  const stop = space.watch((at) => seen.push(at));
  space.enter("p_2");
  space.enter("p_2");
  assert.equal(space.current, "p_2");
  assert.equal(kept.get("thetis.space"), "p_2");
  space.enter(null);
  assert.equal(kept.has("thetis.space"), false, "No project is the absence of the key");
  assert.deepEqual(seen, ["p_2", null]);
  stop();
  space.enter("p_3");
  assert.deepEqual(seen, ["p_2", null], "a stopped watcher hears nothing");
});

test("of answers undefined while the provider does not know, a throw is undefined too, and a second provider is refused", () => {
  fresh();
  const map = { s_a: "p_1", s_b: null };
  space.provide({ of: (id) => (id in map ? map[id] : undefined), name: () => "" });
  assert.equal(space.of("s_a"), "p_1");
  assert.equal(space.of("s_b"), null);
  assert.equal(space.of("s_new"), undefined);
  const errors = [];
  const was = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const stop = space.provide({ of: () => "p_9" });
    assert.equal(typeof stop, "function");
    stop();
    assert.equal(space.of("s_a"), "p_1", "the first provider stays, and the refused one's stop does nothing");
    assert.equal(errors.length, 1);
  } finally {
    console.error = was;
  }
  let changes = 0;
  space.onChanged(() => { changes += 1; });
  space.changed();
  assert.equal(changes, 1);
});

test("ext.space reaches the one space; ext.sessions.group claims a folder by package and id, replaced by the same id", () => {
  fresh();
  const ext = createExt({ package: "@t/projects" });
  const stop = ext.space.provide({ of: () => null, name: () => "No project" });
  ext.space.enter("p_1");
  assert.equal(ext.space.current, "p_1");
  assert.equal(createExt({ package: "@t/canvases" }).space.current, "p_1", "every package reads the same space");
  stop();
  assert.equal(ext.space.current, null);

  const flows = createExt({ package: "@t/workflows" });
  let told = 0;
  groups.watch(() => { told += 1; });
  flows.sessions.group("runs", { label: "Workflow runs", test: (s) => s.id === "s_run" });
  flows.sessions.group("runs", { label: "Workflow runs", test: (s) => s.id === "s_run2", order: 5 });
  assert.equal(groups.list().length, 1, "the same id replaces");
  assert.equal(groups.list()[0].key, "@t/workflows#runs");
  assert.equal(groups.list()[0].test({ id: "s_run2" }), true);
  assert.equal(told, 2);
  assert.throws(() => flows.sessions.group("bad", { label: "Bad" }), /test\(session\)/);
});

test("onCreate hooks receive the draft's space; ext.conversation.start reaches the shell with space and text", async () => {
  fresh();
  const ext = createExt({ package: "@t/projects" });
  const got = [];
  const stop = ext.sessions.onCreate(async (id, info) => { got.push([id, info]); });
  try {
    await notifySessionCreated("s_a", { space: "p_1" });
    await notifySessionCreated("s_b");
  } finally { stop(); }
  assert.deepEqual(got, [["s_a", { space: "p_1" }], ["s_b", { space: null }]]);

  const started = [];
  bindShell({ startConversation: (spec) => started.push(spec) });
  ext.conversation.start({ space: "p_2", text: "Fix this" });
  ext.conversation.start();
  assert.deepEqual(started, [{ space: "p_2", text: "Fix this" }, { space: undefined, text: undefined }]);
});
