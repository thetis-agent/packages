// The Maps section with a fake ext over the shell's fake DOM: the rows the space shows (a project's own, or
// under No project those with none and those whose project is gone), the list following the space, tabs
// opening in a map's space, ＋ making a map in the space, the row menu's moves, and a gateway without spaces
// showing every map. The model is the real one over a fake `request`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "../../gateway-web/test/dom-fixture.js";
import { clear, el, icon } from "../../gateway-web/assets/lib/dom.js";
import { createModel } from "../ui/model.js";
import { mountSidebar } from "../ui/sidebar.js";

const row = (id, title, project, extra = {}) => ({ id, title, project, projectName: null, projectMissing: false, rev: 1, updatedAt: "2026-10-30T10:00:00Z", rooms: 1, exits: 0, areas: 1, state: "draft", label: "draft", linked: 0, ...extra });
const ROWS = [
  row("m_00000001", "Nova docks", "p_00000001", { projectName: "Nova", updatedAt: "2026-10-30T10:00:00Z" }),
  row("m_00000002", "Loose", null, { updatedAt: "2026-10-30T09:00:00Z" }),
  row("m_00000003", "Orion keep", "p_00000002", { projectName: "Orion", updatedAt: "2026-10-30T08:00:00Z" }),
  row("m_00000004", "Orphan", "p_00000009", { projectMissing: true, updatedAt: "2026-10-30T07:00:00Z" }),
];
const PROJECTS = [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }];

/** The shell's space seam as gateway-web 0.20 gives it: `current`, `watch`, and `enter` telling watchers. */
function fakeSpace(current = null) {
  const fns = new Set();
  return {
    get current() {
      return current;
    },
    enter(id) {
      current = id;
      for (const fn of fns) fn(id);
    },
    watch(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    get watchers() {
      return fns.size;
    },
  };
}

function fakeExt(space) {
  const requests = [];
  const opened = [];
  const ext = {
    ...(space ? { space } : {}),
    dom: { el, icon, clear },
    ui: { menu: (at, items) => { ext.lastMenu = items; }, confirm: async () => true },
    toast: () => {},
    open: { tab: async (...a) => { opened.push(a); return true; } },
    close: { tab: () => {} },
    subscribe: () => () => {},
    request: async (verb, opts) => {
      requests.push({ verb, ...opts });
      if (verb === "list") return { data: { maps: ROWS.map((r) => ({ ...r })), projects: PROJECTS } };
      if (verb === "create") return { data: { map: row("m_00000009", opts.args.name, opts.args.project, { updatedAt: "2026-10-30T11:00:00Z" }) } };
      if (verb === "assign") return { data: { id: opts.args.map, project: opts.args.project, rev: 2 } };
      return { data: {} };
    },
  };
  return { ext, requests, opened };
}

function tools() {
  const t = { count: null, actions: [], setCount: (n) => { t.count = n; }, setActions: (...nodes) => { t.actions = nodes; } };
  return t;
}

const titles = (body) => body.querySelectorAll(".mm-row").map((r) => r.querySelector(".mm-row-title").textContent);
const tick = () => new Promise((r) => setTimeout(r, 0));

test("in a project space only its maps show, under No project those with none and the orphans; the list follows the space and tabs open in it", async () => {
  const space = fakeSpace("p_00000001");
  const { ext, opened } = fakeExt(space);
  const model = createModel(ext);
  model.start();
  assert.equal(space.watchers, 1, "the model watches the space");
  await model.refresh();
  const body = new FakeNode("div");
  const t = tools();
  mountSidebar(ext, model, body, t);
  assert.deepEqual(titles(body), ["Nova docks"], "the project's own only");
  assert.equal(t.count, 1);
  space.enter(null);
  assert.deepEqual(titles(body), ["Loose", "Orphan"], "No project: the one with none and the one whose project is gone");
  body.querySelector('[data-map="m_00000004"] > .mm-row-open').click();
  assert.deepEqual(opened.at(-1), ["map", "m_00000004", { id: "m_00000004" }, { space: null }], "an orphan's tab is in No project");
  space.enter("p_00000002");
  assert.deepEqual(titles(body), ["Orion keep"]);
  body.querySelector('[data-map="m_00000003"] > .mm-row-open').click();
  assert.deepEqual(opened.at(-1), ["map", "m_00000003", { id: "m_00000003" }, { space: "p_00000002" }]);
  model.stop();
  assert.equal(space.watchers, 0, "stop lets go of the space");
});

test("＋ makes a map in the space and opens its tab there; the menu moves a map to another project or out of one", async () => {
  const space = fakeSpace("p_00000002");
  const { ext, requests, opened } = fakeExt(space);
  const model = createModel(ext);
  await model.refresh();
  const body = new FakeNode("div");
  const t = tools();
  mountSidebar(ext, model, body, t);
  t.actions[0].click();
  await tick();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "create").args, { name: "Untitled map", project: "p_00000002" });
  assert.deepEqual(opened.at(-1), ["map", "m_00000009", { id: "m_00000009" }, { space: "p_00000002" }], "the tab opens in the space it was made in");
  assert.ok(titles(body).includes("Untitled map"), "the new row is listed at once");
  body.querySelector('[data-map="m_00000003"] > .mm-row-more').click();
  const labels = ext.lastMenu.filter((i) => i !== "-").map((i) => i.label);
  assert.ok(labels.includes("Move to Nova") && !labels.includes("Move to Orion"), "another project, not its own");
  ext.lastMenu.find((i) => i.label === "Move out of its project").run();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "assign").args, { map: "m_00000003", project: null });
  model.stop();
});

test("on a gateway without spaces every map shows, and ＋ makes one in no project", async () => {
  const { ext, requests, opened } = fakeExt();
  const model = createModel(ext);
  model.start();
  await model.refresh();
  const body = new FakeNode("div");
  const t = tools();
  mountSidebar(ext, model, body, t);
  assert.equal(model.spaced, false);
  assert.deepEqual(titles(body), ["Nova docks", "Loose", "Orion keep", "Orphan"]);
  t.actions[0].click();
  await tick();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "create").args, { name: "Untitled map", project: null });
  assert.deepEqual(opened.at(-1), ["map", "m_00000009", { id: "m_00000009" }, { space: null }]);
  model.stop();
});
