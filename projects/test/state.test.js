import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../ui/state.js";

const projects = [{ id: "p_11111111", name: "A", conversations: 0 }, { id: "p_22222222", name: "B", conversations: 0 }];

function page({ readList, assign } = {}) {
  let onList = () => {};
  let onCreate = async () => {};
  const calls = [];
  const ext = {
    conversation: { current: null },
    sessions: {
      list: () => [],
      filter: () => {},
      watch: (fn) => { onList = fn; },
      onCreate: (fn) => { onCreate = fn; return () => {}; },
    },
    request: async (verb, options) => {
      if (verb === "list") return readList ? readList() : { data: { projects: structuredClone(projects), assignments: {} } };
      calls.push(options.args);
      await assign?.(options.args);
      return {};
    },
    toast: () => {},
  };
  return { state: createState(ext), calls, list: (list) => onList(list), create: (id) => onCreate(id) };
}

test("only the page creating a conversation assigns its project, before creation finishes", async () => {
  let release;
  const assigned = new Promise((resolve) => { release = resolve; });
  const first = page({ assign: () => assigned });
  const other = page();
  await first.state.refresh();
  await other.state.refresh();
  first.state.choose(projects[0].id);
  other.state.choose(projects[1].id);
  const fresh = [{ id: "s_1234", createdAt: new Date().toISOString(), archived: false }];
  first.list(fresh);
  other.list(fresh);
  assert.deepEqual(other.calls, [], "a session broadcast to an idle tab must not change its project");
  assert.deepEqual(first.calls, [], "the list alone is not evidence of local creation");
  let completed = false;
  const created = first.create("s_1234").then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.calls, [{ session: "s_1234", project: projects[0].id }]);
  assert.equal(completed, false, "the shell must wait for assignment before opening or sending");
  release();
  await created;
  assert.equal(completed, true);
});

test("creation waits for the initial project list and keeps the choice made at creation", async (t) => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => projects[0].id, setItem: () => {}, removeItem: () => {} };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  let resolveList;
  const loaded = new Promise((resolve) => { resolveList = resolve; });
  const own = page({ readList: () => loaded });
  const refresh = own.state.refresh();
  const created = own.create("s_5678");
  assert.deepEqual(own.calls, []);
  resolveList({ data: { projects: structuredClone(projects), assignments: {} } });
  await Promise.all([refresh, created]);
  assert.deepEqual(own.calls, [{ session: "s_5678", project: projects[0].id }]);
});

test("creation without a chosen project needs no project request", { timeout: 1000 }, async () => {
  const own = page({ readList: () => new Promise(() => {}) });
  await own.create("s_9");
  assert.deepEqual(own.calls, []);
});

test("an assignment refusal reaches the shell and reverts the optimistic map", async () => {
  const own = page({ assign: async () => { throw new Error("project was deleted"); } });
  await own.state.refresh();
  own.state.choose(projects[0].id);
  await assert.rejects(own.create("s_9"), /project was deleted/);
  assert.equal(own.state.assignments.s_9, undefined);
  assert.equal(own.state.projects[0].conversations, 0);
});

test("a list captured before creation cannot replace a successful project assignment", async () => {
  let reads = 0;
  let resolveList;
  const initial = { data: { projects: structuredClone(projects), assignments: {} } };
  const own = page({ readList: async () => ++reads === 1 ? structuredClone(initial) : new Promise((resolve) => { resolveList = resolve; }) });
  await own.state.refresh();
  own.state.choose(projects[0].id);
  const refreshing = own.state.refresh();
  await own.create("s_9");
  resolveList(initial);
  await refreshing;
  assert.equal(own.state.assignments.s_9, projects[0].id);
  assert.equal(own.state.projects[0].conversations, 1);
});
