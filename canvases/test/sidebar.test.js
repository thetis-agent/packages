// The Canvases section with a fake ext over the shell's fake DOM: the rows the chosen project shows, the
// badge under All, the open row marked, ＋ making a canvas in the chosen project and opening its tab, a
// click opening a tab, and Delete asking first. The model is the real one over a fake `request`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "../../gateway-web/test/dom-fixture.js";
import { clear, el, icon } from "../../gateway-web/assets/lib/dom.js";
import { createModel } from "../ui/model.js";
import { mountSidebar } from "../ui/sidebar.js";

const kept = new Map();
globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
globalThis.window.addEventListener ??= () => {};

const ROWS = [
  { id: "c_00000001", title: "Nova flow", project: "p_00000001", projectName: "Nova", projectMissing: false, boards: 2, updatedAt: "2026-09-27T10:00:00Z", rev: 3 },
  { id: "c_00000002", title: "Loose", project: null, projectName: null, projectMissing: false, boards: 0, updatedAt: "2026-09-27T09:00:00Z", rev: 1 },
  { id: "c_00000003", title: "Orion thing", project: "p_00000002", projectName: "Orion", projectMissing: false, boards: 1, updatedAt: "2026-09-27T08:00:00Z", rev: 1 },
  { id: "c_00000004", title: "Orphan", project: "p_00000009", projectName: null, projectMissing: true, boards: 1, updatedAt: "2026-09-27T07:00:00Z", rev: 1 },
];

function fakeExt() {
  const requests = [];
  const opened = [];
  const closed = [];
  let confirmAnswer = true;
  const ext = {
    dom: { el, icon, clear },
    ui: { menu: (at, items) => { ext.lastMenu = items; }, confirm: async () => confirmAnswer },
    toast: () => {},
    open: { tab: async (...a) => { opened.push(a); return true; } },
    close: { tab: (...a) => closed.push(a) },
    subscribe: () => () => {},
    request: async (verb, opts) => {
      requests.push({ verb, ...opts });
      if (verb === "list") return { data: { canvases: ROWS, projects: [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }] } };
      if (verb === "create") return { data: { canvas: { id: "c_00000009", title: opts.args.title, project: opts.args.project, updatedAt: "2026-09-27T11:00:00Z", rev: 1 } } };
      return { data: { removed: opts.args.id } };
    },
  };
  return { ext, requests, opened, closed, answer: (v) => { confirmAnswer = v; } };
}

function tools() {
  const t = { count: null, actions: [], setCount: (n) => { t.count = n; }, setActions: (...nodes) => { t.actions = nodes; }, expand: () => {} };
  return t;
}

const titles = (body) => body.querySelectorAll(".cv-row").map((r) => r.querySelector(".cv-row-title").textContent);
const tick = () => new Promise((r) => setTimeout(r, 0));

test("under All every canvas shows with its project badge; a chosen project shows its own, the global ones and the orphans", async () => {
  const { ext } = fakeExt();
  const model = createModel(ext);
  await model.refresh();
  const body = new FakeNode("div");
  const t = tools();
  const unmount = mountSidebar(ext, model, body, t);
  assert.deepEqual(titles(body), ["Nova flow", "Loose", "Orion thing", "Orphan"]);
  assert.equal(t.count, 4);
  assert.equal(body.querySelector('[data-canvas="c_00000001"] > .cv-row-open > .cv-row-badge').textContent, "Nova");
  assert.equal(body.querySelector('[data-canvas="c_00000002"] > .cv-row-open > .cv-row-badge'), null, "a global canvas has no badge");
  kept.set("thetis.project", "p_00000001");
  // The section reads the chosen project on every draw; the model's poll (after `start`) or a storage event
  // makes it draw when the key changes, and so does any list refresh.
  await model.refresh();
  assert.deepEqual(titles(body), ["Nova flow", "Loose", "Orphan"], "Orion's stays out; the global and the orphan stay in");
  assert.equal(body.querySelector('[data-canvas="c_00000001"] > .cv-row-open > .cv-row-badge'), null, "no badge inside a project");
  assert.equal(t.count, 3);
  model.setActive("c_00000002");
  assert.ok(body.querySelector('[data-canvas="c_00000002"]').classList.contains("is-active"));
  unmount();
  model.stop();
  kept.clear();
});

test("＋ makes a canvas in the chosen project and opens its tab in rename mode; a row click opens the tab", async () => {
  const { ext, requests, opened } = fakeExt();
  const model = createModel(ext);
  await model.refresh();
  kept.set("thetis.project", "p_00000002");
  const body = new FakeNode("div");
  const t = tools();
  mountSidebar(ext, model, body, t);
  assert.equal(t.actions.length, 1, "the ＋ is in the section's actions");
  t.actions[0].click();
  await tick();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "create").args, { title: "Untitled canvas", project: "p_00000002" });
  assert.deepEqual(opened.at(-1), ["canvas", "c_00000009", { id: "c_00000009", rename: true }]);
  assert.ok(titles(body).includes("Untitled canvas"), "the new row is listed at once");
  body.querySelector('[data-canvas="c_00000003"] > .cv-row-open').click();
  assert.deepEqual(opened.at(-1), ["canvas", "c_00000003", { id: "c_00000003" }]);
  model.stop();
  kept.clear();
});

test("Delete asks first, and only a yes removes the canvas and closes its tab", async () => {
  const { ext, requests, closed, answer } = fakeExt();
  const model = createModel(ext);
  await model.refresh();
  const body = new FakeNode("div");
  mountSidebar(ext, model, body, tools());
  const more = body.querySelector('[data-canvas="c_00000002"] > .cv-row-more');
  more.click();
  const del = ext.lastMenu.find((i) => i?.label === "Delete");
  assert.ok(del?.danger);
  assert.ok(ext.lastMenu.some((i) => i?.label === "Move to Nova") && ext.lastMenu.some((i) => i?.label === "Move to Orion"), "a global canvas can go to either project");
  assert.ok(!ext.lastMenu.some((i) => i?.label === "Make global"));
  answer(false);
  del.run();
  await tick();
  await tick();
  assert.equal(requests.filter((r) => r.verb === "remove").length, 0, "no: nothing removed");
  answer(true);
  del.run();
  await tick();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "remove").args, { id: "c_00000002" });
  assert.deepEqual(closed, [["canvas", "c_00000002"]]);
  model.stop();
});
