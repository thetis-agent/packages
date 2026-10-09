// The Sheets section with a fake ext over the shell's fake DOM: the rows the chosen project shows, the badge
// under All, the open row marked, ＋ making a sheet in the chosen project and opening its tab in rename, a
// click opening a tab, the row menu (projects, Download CSV through the raw seam), Delete asking first, and
// the model's own-revision echoes. The model is the real one over a fake `request` and `subscribe`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "../../gateway-web/test/dom-fixture.js";
import { clear, el, icon } from "../../gateway-web/assets/lib/dom.js";
import { createModel } from "../ui/model.js";
import { mountSidebar } from "../ui/sidebar.js";

const kept = new Map();
globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};

const ROWS = [
  { id: "sh_00000001", title: "Nova budget", project: "p_00000001", projectName: "Nova", projectMissing: false, tabs: 2, cells: 40, updatedAt: "2026-10-08T10:00:00Z", rev: 3 },
  { id: "sh_00000002", title: "Loose", project: null, projectName: null, projectMissing: false, tabs: 1, cells: 0, updatedAt: "2026-10-08T09:00:00Z", rev: 1 },
  { id: "sh_00000003", title: "Orion plan", project: "p_00000002", projectName: "Orion", projectMissing: false, tabs: 1, cells: 9, updatedAt: "2026-10-08T08:00:00Z", rev: 1 },
  { id: "sh_00000004", title: "Orphan", project: "p_00000009", projectName: null, projectMissing: true, tabs: 1, cells: 1, updatedAt: "2026-10-08T07:00:00Z", rev: 1 },
];
const PROJECTS = [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }];

function fakeExt({ raw = true } = {}) {
  const requests = [];
  const opened = [];
  const closed = [];
  const streams = [];
  let confirmAnswer = true;
  let nextRev = 10;
  const ext = {
    dom: { el, icon, clear },
    ui: { menu: (at, items) => { ext.lastMenu = items; ext.lastAnchor = at; }, confirm: async () => confirmAnswer },
    toast: (text, opts) => { ext.toasts.push([text, opts]); },
    toasts: [],
    open: { tab: async (...a) => { opened.push(a); return true; } },
    close: { tab: (...a) => closed.push(a) },
    subscribe: (verb, handlers) => { streams.push({ verb, ...handlers }); return () => {}; },
    request: async (verb, opts) => {
      requests.push({ verb, ...opts });
      if (verb === "list") return { data: { sheets: ROWS, projects: PROJECTS } };
      if (verb === "create") return { data: { sheet: { id: "sh_00000009", title: opts.args.title, project: opts.args.project, projectName: null, projectMissing: false, tabs: 1, cells: 0, updatedAt: "2026-10-08T11:00:00Z", rev: 1 } } };
      if (verb === "save") return { data: { rev: nextRev++ } };
      if (verb === "assign") return { data: { id: opts.args.id, project: opts.args.project, rev: nextRev++ } };
      return { data: { removed: opts.args.id } };
    },
    ...(raw ? { raw: { url: (verb, args) => `api/ext/@thetis/sheets/${verb}/raw?args=${encodeURIComponent(JSON.stringify(args))}`, put: async () => ({ data: {} }) } } : {}),
  };
  return { ext, requests, opened, closed, streams, answer: (v) => { confirmAnswer = v; } };
}

function tools() {
  const t = { count: null, actions: [], setCount: (n) => { t.count = n; }, setActions: (...nodes) => { t.actions = nodes; }, expand: () => {} };
  return t;
}

const titles = (body) => body.querySelectorAll(".sht-row").map((r) => r.querySelector(".sht-row-title").textContent);
const tick = () => new Promise((r) => setTimeout(r, 0));

test("under All every sheet shows with its project badge; a chosen project shows its own, the global ones and the orphans", async () => {
  const { ext } = fakeExt();
  const model = createModel(ext);
  await model.refresh();
  const body = new FakeNode("div");
  const t = tools();
  const unmount = mountSidebar(ext, model, body, t);
  assert.deepEqual(titles(body), ["Nova budget", "Loose", "Orion plan", "Orphan"]);
  assert.equal(t.count, 4);
  assert.equal(body.querySelector('[data-sheet="sh_00000001"] > .sht-row-open > .sht-row-badge').textContent, "Nova");
  assert.equal(body.querySelector('[data-sheet="sh_00000002"] > .sht-row-open > .sht-row-badge'), null, "a global sheet has no badge");
  kept.set("thetis.project", "p_00000001");
  await model.refresh();
  assert.deepEqual(titles(body), ["Nova budget", "Loose", "Orphan"], "Orion's stays out; the global and the orphan stay in");
  assert.equal(body.querySelector('[data-sheet="sh_00000001"] > .sht-row-open > .sht-row-badge'), null, "no badge inside a project");
  assert.equal(t.count, 3);
  model.setActive("sh_00000002");
  assert.ok(body.querySelector('[data-sheet="sh_00000002"]').classList.contains("is-active"));
  unmount();
  model.stop();
  kept.clear();
});

test("＋ makes an Untitled sheet in the chosen project and opens its tab in rename; a row click opens the tab", async () => {
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
  assert.deepEqual(requests.find((r) => r.verb === "create").args, { title: "Untitled sheet", project: "p_00000002" });
  assert.deepEqual(opened.at(-1), ["sheet", "sh_00000009", { id: "sh_00000009", rename: true }]);
  assert.ok(titles(body).includes("Untitled sheet"), "the new row is listed at once");
  body.querySelector('[data-sheet="sh_00000003"] > .sht-row-open').click();
  assert.deepEqual(opened.at(-1), ["sheet", "sh_00000003", { id: "sh_00000003" }]);
  model.stop();
  kept.clear();
});

test("the row menu moves between projects, offers the xlsx and CSV downloads through the raw seam, and Delete asks first", async () => {
  const { ext, requests, closed, answer } = fakeExt();
  const model = createModel(ext);
  await model.refresh();
  const body = new FakeNode("div");
  mountSidebar(ext, model, body, tools());
  body.querySelector('[data-sheet="sh_00000002"] > .sht-row-more').click();
  const labels = ext.lastMenu.filter((i) => i !== "-").map((i) => i.label);
  assert.deepEqual(labels, ["Rename", "Move to Nova", "Move to Orion", "Download .xlsx", "Download CSV", "Delete"], "a global sheet can go to either project");
  const xlsx = ext.lastMenu.find((i) => i?.label === "Download .xlsx");
  assert.equal(xlsx.disabled, false);
  assert.match(xlsx.hint, /Google Sheets/);
  const dl = ext.lastMenu.find((i) => i?.label === "Download CSV");
  assert.equal(dl.disabled, false);
  assert.equal(model.exportUrl("sh_00000002", null, "csv"), `api/ext/@thetis/sheets/export/raw?args=${encodeURIComponent(JSON.stringify({ id: "sh_00000002", format: "csv" }))}`);
  ext.lastMenu.find((i) => i?.label === "Move to Orion").run();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "assign").args, { id: "sh_00000002", project: "p_00000002" });
  const del = ext.lastMenu.find((i) => i?.label === "Delete");
  assert.ok(del?.danger);
  answer(false);
  del.run();
  await tick();
  await tick();
  assert.equal(requests.filter((r) => r.verb === "remove").length, 0, "no: nothing removed");
  answer(true);
  del.run();
  await tick();
  await tick();
  assert.deepEqual(requests.find((r) => r.verb === "remove").args, { id: "sh_00000002" });
  assert.deepEqual(closed, [["sheet", "sh_00000002"]]);
  model.stop();
});

test("without the raw seam the download is offered disabled, with the reason", async () => {
  const { ext } = fakeExt({ raw: false });
  const model = createModel(ext);
  await model.refresh();
  const body = new FakeNode("div");
  mountSidebar(ext, model, body, tools());
  body.querySelector('[data-sheet="sh_00000001"] > .sht-row-more').click();
  const dl = ext.lastMenu.find((i) => i?.label === "Download CSV");
  assert.equal(dl.disabled, true);
  assert.equal(ext.lastMenu.find((i) => i?.label === "Download .xlsx").disabled, true);
  assert.match(dl.hint, /cannot send files/);
  assert.ok(ext.lastMenu.some((i) => i?.label === "Make global"), "a project's sheet can be made global");
  model.stop();
});

test("the watch: a snapshot fills the list, a changed event updates a row and is told as own when this page wrote that revision", async (t) => {
  const { ext, streams } = fakeExt();
  const model = createModel(ext);
  model.start();
  t.after(() => model.stop()); // its poll keeps the process alive if an assertion fails first
  await tick();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].verb, "watch");
  const body = new FakeNode("div");
  mountSidebar(ext, model, body, tools());
  streams[0].onEvent({ ev: "snapshot", sheets: ROWS.slice(0, 2), projects: PROJECTS });
  assert.deepEqual(titles(body), ["Nova budget", "Loose"]);
  const heard = [];
  model.onSheet("sh_00000002", (e) => heard.push(e));
  const out = await model.save("sh_00000002", [{ op: "title", title: "Loose ends" }], 1);
  streams[0].onEvent({ ev: "changed", sheet: "sh_00000002", rev: out.rev, title: "Loose ends", project: null, updatedAt: "2026-10-08T12:00:00Z", tabs: 1, cells: 0, by: "person" });
  assert.equal(heard.at(-1).own, true, "the page's own revision");
  streams[0].onEvent({ ev: "changed", sheet: "sh_00000002", rev: out.rev + 1, title: "Loose ends", project: null, updatedAt: "2026-10-08T12:01:00Z", tabs: 1, cells: 3, by: "agent", session: "s_x" });
  assert.equal(heard.at(-1).own, false, "another writer's");
  assert.equal(heard.at(-1).by, "agent");
  assert.equal(titles(body)[0], "Loose ends", "the newest first");
  streams[0].onEvent({ ev: "removed", sheet: "sh_00000002" });
  assert.equal(heard.at(-1).kind, "removed");
  assert.deepEqual(titles(body), ["Nova budget"]);
  model.stop();
});
