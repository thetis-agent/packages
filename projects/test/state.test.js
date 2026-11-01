// The page's project state over a fake seam: it is the shell's space provider (of, name, changed), a
// conversation created here joins the space its draft was in, the old `thetis.project` key is entered once,
// and on a gateway without `ext.space` the old filter stands in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../ui/state.js";

const projects = [{ id: "p_11111111", name: "A", conversations: 0 }, { id: "p_22222222", name: "B", conversations: 0 }];
const [A, B] = projects.map((p) => p.id);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeSpace(current = null) {
  const space = {
    current,
    provider: null,
    entered: [],
    changes: 0,
    watchers: new Set(),
    provide(p) {
      this.provider = p;
      return () => {};
    },
    enter(id) {
      this.entered.push(id);
      if (id === this.current) return;
      this.current = id;
      for (const fn of this.watchers) fn(id);
    },
    watch(fn) {
      this.watchers.add(fn);
      return () => this.watchers.delete(fn);
    },
    changed() {
      this.changes += 1;
    },
  };
  return space;
}

function page({ readList, assign, space = fakeSpace(), sessions = [], legacy = false } = {}) {
  let onList = () => {};
  let onCreate = async () => {};
  let onEvent = () => {};
  let filter = null;
  const calls = [];
  const ext = {
    conversation: { current: null },
    ...(legacy ? {} : { space }),
    events: { watch: (fn) => { onEvent = fn; return () => {}; } },
    sessions: {
      list: () => sessions,
      filter: (fn) => { filter = fn; },
      watch: (fn) => { onList = fn; return () => {}; },
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
  return {
    state: createState(ext),
    space,
    calls,
    filter: () => filter,
    list: (list) => onList(list),
    create: (...args) => onCreate(...args),
    event: (message) => onEvent(message),
  };
}

function withStorage(t, values) {
  const previous = globalThis.localStorage;
  const data = new Map(Object.entries(values));
  globalThis.localStorage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  return data;
}

test("the provider answers of and name; a removed project is No project", async () => {
  const own = page({ readList: () => ({ data: { projects: structuredClone(projects), assignments: { s_a: A, s_gone: "p_99999999" } } }) });
  const { of, name } = own.space.provider;
  assert.equal(of("s_a"), undefined, "nothing is known before the first read");
  await own.state.refresh();
  assert.equal(of("s_a"), A);
  assert.equal(of("s_gone"), null, "assigned to a project that no longer exists");
  assert.equal(name(A), "A");
  assert.equal(name(null), "No project");
  assert.equal(name("p_99999999"), "No project");
  assert.ok(own.space.changes >= 1, "the shell is told after a read");
});

test("an id the map has not seen is undefined until one more read, then null", async () => {
  let reads = 0;
  let server = {};
  const own = page({ readList: () => { reads++; return { data: { projects: structuredClone(projects), assignments: { ...server } } }; } });
  await own.state.refresh();
  const { of } = own.space.provider;
  // A workflow's service assigns one conversation this page has never seen; another is in no project.
  server = { s_wf: A };
  assert.equal(of("s_wf"), undefined);
  assert.equal(of("s_none"), undefined);
  const before = reads;
  await new Promise((resolve) => setTimeout(resolve, 450));
  await tick();
  assert.equal(reads - before, 1, "one read for a burst of unseen ids");
  assert.equal(of("s_wf"), A);
  assert.equal(of("s_none"), null);
  of("s_none");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(reads - before, 1, "an id already checked never causes another read");
});

test("the conversations in the list at the first read are settled by it", async () => {
  const own = page({ sessions: [{ id: "s_1" }, { id: "s_2" }], readList: () => ({ data: { projects: structuredClone(projects), assignments: { s_1: B } } }) });
  await own.state.refresh();
  assert.equal(own.space.provider.of("s_1"), B);
  assert.equal(own.space.provider.of("s_2"), null);
  assert.equal(own.state.count(B), 1);
  assert.equal(own.state.count(null), 1);
});

test("onCreate assigns the draft's space, not the current one, before creation finishes", async () => {
  let release;
  const assigned = new Promise((resolve) => { release = resolve; });
  const own = page({ space: fakeSpace(B), assign: () => assigned });
  await own.state.refresh();
  let completed = false;
  const created = own.create("s_1234", { space: A }).then(() => { completed = true; });
  await tick();
  assert.deepEqual(own.calls, [{ session: "s_1234", project: A }]);
  assert.equal(own.space.provider.of("s_1234"), A, "the map is updated first so the row stays in the space");
  assert.equal(completed, false, "the shell waits for the assignment before opening or sending");
  release();
  await created;
  assert.equal(completed, true);
});

test("onCreate does not need the list: it assigns even when the list was never read", { timeout: 1000 }, async () => {
  const own = page({ readList: () => new Promise(() => {}) });
  void own.state.refresh();
  await own.create("s_5678", { space: A });
  assert.deepEqual(own.calls, [{ session: "s_5678", project: A }]);
});

test("a draft in no project assigns nothing, and the new conversation is in no project at once", { timeout: 1000 }, async () => {
  const own = page({ space: fakeSpace(A), readList: () => new Promise(() => {}) });
  await own.create("s_9", { space: null });
  assert.deepEqual(own.calls, []);
  assert.equal(own.space.provider.of("s_9"), null);
});

test("a list update from another tab never assigns anything", async () => {
  const own = page({ space: fakeSpace(A) });
  await own.state.refresh();
  own.list([{ id: "s_1234", createdAt: new Date().toISOString(), archived: false }]);
  assert.deepEqual(own.calls, []);
});

test("an assignment refusal reaches the shell and reverts the optimistic map", async () => {
  const own = page({ assign: async () => { throw new Error("project was deleted"); } });
  await own.state.refresh();
  await assert.rejects(own.create("s_9", { space: A }), /project was deleted/);
  assert.equal(own.state.assignments.s_9, undefined);
  assert.equal(own.state.projects[0].conversations, 0);
});

test("a list captured before creation cannot replace a successful project assignment", async () => {
  let reads = 0;
  let resolveList;
  const initial = { data: { projects: structuredClone(projects), assignments: {} } };
  const own = page({ readList: async () => ++reads === 1 ? structuredClone(initial) : new Promise((resolve) => { resolveList = resolve; }) });
  await own.state.refresh();
  const refreshing = own.state.refresh();
  await own.create("s_9", { space: A });
  resolveList(initial);
  await refreshing;
  assert.equal(own.state.assignments.s_9, A);
  assert.equal(own.state.projects[0].conversations, 1);
});

test("moving a conversation tells the shell, which follows it", async () => {
  const own = page();
  await own.state.refresh();
  const before = own.space.changes;
  await own.state.assign("s_1", B);
  assert.equal(own.space.provider.of("s_1"), B);
  assert.ok(own.space.changes >= before + 1);
  await own.state.assign("s_1", null);
  assert.equal(own.space.provider.of("s_1"), null);
});

test("entering goes through the shell; a current space naming a deleted project falls back to none", async () => {
  const own = page({ space: fakeSpace("p_99999999") });
  await own.state.refresh();
  assert.deepEqual(own.space.entered, [null]);
  own.state.enter(A);
  assert.equal(own.state.chosen, A);
  own.state.enter("p_33333333");
  assert.equal(own.state.chosen, null, "an unknown project is not entered");
});

test("the old thetis.project key is entered once and removed; a space already set wins", (t) => {
  const data = withStorage(t, { "thetis.project": A });
  const own = page();
  assert.deepEqual(own.space.entered, [A]);
  assert.equal(data.has("thetis.project"), false);
  data.set("thetis.project", B);
  data.set("thetis.space", A);
  const other = page();
  assert.deepEqual(other.space.entered, []);
  assert.equal(data.has("thetis.project"), false);
});

test("turns of root conversations count as working in their space", async () => {
  const own = page({ readList: () => ({ data: { projects: structuredClone(projects), assignments: { s_1: A } } }) });
  await own.state.refresh();
  let told = 0;
  own.state.watch(() => told++);
  own.event({ session: "s_1", event: { type: "turn.start" } });
  own.event({ session: "s_child", parent: "s_1", event: { type: "turn.start" } });
  assert.equal(own.state.working(A), 1);
  assert.equal(told, 1, "a subagent's turn is not counted");
  own.event({ session: "s_1", event: { type: "turn.end" } });
  assert.equal(own.state.working(A), 0);
  own.list([{ id: "s_1", status: "running" }]);
  assert.equal(own.state.working(A), 1, "a turn already running when the page opened shows from the list");
});

test("an older gateway: the filter stands in for the space, and onCreate uses the remembered project", async (t) => {
  const data = withStorage(t, { "thetis.project": A });
  const own = page({ legacy: true });
  await own.state.refresh();
  assert.equal(own.state.chosen, A);
  assert.equal(data.get("thetis.project"), A, "the old key stays: it is the old gateway's only memory");
  await own.create("s_1");
  assert.deepEqual(own.calls, [{ session: "s_1", project: A }]);
  const filter = own.filter();
  assert.equal(filter({ id: "s_1" }), true);
  own.state.enter(null);
  assert.equal(data.has("thetis.project"), false);
  assert.equal(own.filter()({ id: "s_1" }), false);
});
