// The page's commands: the list with project names, one sheet whole, a save of the person's ops on a fresh
// read (merged when the page's base was stale, and logged as the person's), create, remove, assign, the
// raw export (CSV, TSV, the whole workbook as JSON) and the raw import (a new sheet, a new tab).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetCreate, sheetRead, sheetWrite, uiAssign, uiCreate, uiExport, uiGet, uiImport, uiList, uiRemove, uiSave } from "../index.js";
import { readSheet } from "../lib/store.js";
import { idIn, makeEnv, unzipText } from "./helpers.js";

const PROJECTS = [{ id: "p_00000001", name: "Nova" }];

const text = (body) => (Buffer.isBuffer(body) ? body.toString("utf8") : String(body));

test("list names projects and marks a sheet whose project is gone; get answers the whole workbook", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS });
  assert.deepEqual(await uiList({}, env), { data: { sheets: [], projects: [{ id: "p_00000001", name: "Nova" }] } });
  const a = idIn(await sheetCreate({ title: "A", project: "p_00000001", tabs: ["One", "Two"], rows: [[1, 2], [3]] }, env));
  const b = idIn(await sheetCreate({ title: "B", project: "none" }, env));
  await env.writeFile(`sheets/${b}/sheet.json`, JSON.stringify({ ...(await readSheet(env, b)), project: "p_00000009" }));
  const { data } = await uiList({}, env);
  const rowA = data.sheets.find((s) => s.id === a);
  assert.deepEqual({ ...rowA, updatedAt: "" }, { id: a, title: "A", project: "p_00000001", projectName: "Nova", projectMissing: false, tabs: 2, cells: 3, updatedAt: "", rev: 1 });
  const rowB = data.sheets.find((s) => s.id === b);
  assert.equal(rowB.projectMissing, true);
  assert.equal(rowB.projectName, null);
  assert.deepEqual((await uiList({ project: "p_00000001" }, env)).data.sheets.map((s) => s.id), [a]);
  assert.deepEqual((await uiList({ project: "none" }, env)).data.sheets, []);
  assert.equal((await uiList({ project: "all" }, env)).data.sheets.length, 2);
  const got = (await uiGet({ id: a }, env)).data.sheet;
  assert.equal(got.id, a);
  assert.deepEqual(got.tabs[0].cells, { A1: 1, B1: 2, A2: 3 });
  assert.equal(got.rev, 1);
  await assert.rejects(uiGet({ id: "sh_00000000" }, env), /No sheet sh_00000000/);
  await assert.rejects(uiGet({ id: "x" }, env), /A sheet id looks like sh_1a2b3c4d/);
  await done();
});

test("save applies the person's ops under the lock, answers the revision, says merged when the base was stale, and logs them as the person's", async () => {
  const { env, done } = await makeEnv({ session: "s_page" });
  const id = idIn(await sheetCreate({ title: "S" }, env));
  const saved = (await uiSave({ id, ops: [{ op: "set", tab: "t1", cells: { A1: 5, A2: "=A1*3" } }], base: 1 }, env)).data;
  assert.deepEqual(saved, { rev: 2 });
  await sheetWrite({ sheet: id, cells: { B1: "agent" } }, env);
  const stale = (await uiSave({ id, ops: [{ op: "style", tab: "t1", range: "A1", style: { b: true } }, { op: "set", tab: "Sheet1", cells: { C1: "person" } }], base: 2 }, env)).data;
  assert.deepEqual(stale, { rev: 4, merged: true });
  const wb = await readSheet(env, id);
  assert.deepEqual(wb.tabs[0].cells, { A1: 5, A2: "=A1*3", B1: "agent", C1: "person" }, "the agent's cell between the two saves stays");
  assert.deepEqual(wb.tabs[0].styles.A1, { b: true });
  const last = wb.changes.at(-1);
  assert.equal(last.by, "person");
  assert.equal(last.session, "s_page");
  assert.equal(last.rev, 4);
  assert.match(await sheetRead({ sheet: id }, env), /Recent edits by the person:\n- just now: Sheet1!/);
  await assert.rejects(uiSave({ id, ops: [] }, env), /ops must be a non-empty list/);
  await assert.rejects(uiSave({ id, ops: [{ op: "explode" }] }, env), /./);
  assert.equal((await readSheet(env, id)).rev, 4, "a refused save writes nothing");
  await assert.rejects(uiSave({ id: "sh_00000000", ops: [{ op: "title", title: "x" }] }, env), /No sheet/);
  await done();
});

test("create, assign and remove", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS });
  const made = (await uiCreate({ title: "  New  ", project: "p_00000001" }, env)).data.sheet;
  assert.deepEqual({ ...made, id: "", updatedAt: "" }, { id: "", title: "New", project: "p_00000001", projectName: "Nova", projectMissing: false, tabs: 1, cells: 0, updatedAt: "", rev: 1 });
  assert.equal((await readSheet(env, made.id)).changes[0].by, "person");
  assert.equal((await uiCreate({}, env)).data.sheet.title, "Untitled sheet");
  await assert.rejects(uiCreate({ project: "p_00000009" }, env), /No project p_00000009/);
  await assert.rejects(uiCreate({ project: "nova" }, env), /project must be a project id, or null/);
  assert.deepEqual((await uiAssign({ id: made.id, project: null }, env)).data, { id: made.id, project: null, rev: 2 });
  assert.deepEqual((await uiAssign({ id: made.id, project: "p_00000001" }, env)).data, { id: made.id, project: "p_00000001", rev: 3 });
  await assert.rejects(uiAssign({ id: made.id, project: "p_00000009" }, env), /No project/);
  assert.deepEqual((await uiRemove({ id: made.id }, env)).data, { removed: made.id });
  assert.equal(await readSheet(env, made.id), null);
  await assert.rejects(uiRemove({ id: made.id }, env), /No sheet/);
  await done();
});

test("export: a tab as CSV with a byte-order mark and a safe file name, as TSV, the whole workbook as JSON and as xlsx", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Café / Q3", tabs: ["Costs", "Other"], rows: [["Item", "Cost"], ["Rent, flat", "$1,200"], ["Sum", "=B2*2"]] }, env));
  const csv = await uiExport({ id }, env, { method: "GET" });
  assert.equal(csv.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal(csv.headers["content-disposition"], `attachment; filename="Caf_ _ Q3 - Costs.csv"; filename*=UTF-8''Caf%C3%A9%20_%20Q3%20-%20Costs.csv`);
  assert.equal(csv.headers["content-length"], String(csv.body.length));
  assert.equal(text(csv.body), "﻿Item,Cost\r\n\"Rent, flat\",\"$1,200.00\"\r\nSum,2400\r\n");
  const tsv = await uiExport({ id, tab: "other", format: "tsv" }, env, { method: "GET" });
  assert.equal(tsv.headers["content-type"], "text/tab-separated-values; charset=utf-8");
  assert.match(tsv.headers["content-disposition"], /Other\.tsv"/);
  assert.equal(text(tsv.body), "﻿", "an empty tab downloads as nothing but the mark");
  const json = await uiExport({ id, format: "json" }, env, { method: "GET" });
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(JSON.parse(text(json.body)).id, id);
  await assert.rejects(uiExport({ id, tab: "Nope" }, env, { method: "GET" }), /No tab "Nope"/);
  const xlsx = await uiExport({ id, format: "xlsx" }, env, { method: "GET" });
  assert.equal(xlsx.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(xlsx.headers["content-disposition"], /filename="Caf_ _ Q3\.xlsx"/);
  assert.equal(xlsx.headers["content-length"], String(xlsx.body.length));
  const parts = unzipText(xlsx.body);
  assert.match(parts.get("xl/workbook.xml"), /<sheet name="Costs"[^>]*\/><sheet name="Other"/);
  assert.match(parts.get("xl/worksheets/sheet1.xml"), /<f>B2\*2<\/f><v>2400<\/v>/);
  await assert.rejects(uiExport({ id, format: "xls" }, env, { method: "GET" }), /format is xlsx, csv or tsv/);
  await done();
});

test("import: an upload as a new sheet in a project, or as a new tab of a sheet, logged as the person's", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS });
  const put = (args, body) => uiImport(args, env, { method: "PUT", body: Buffer.from(body, "utf8") });
  const made = await put({ title: "Upload", project: "p_00000001" }, "﻿Name;Score\nAda;3\nBo;4,5\n");
  assert.match(made.sheet, /^sh_[0-9a-f]{8}$/);
  assert.equal(made.tab, "t1");
  assert.equal(made.range, "A1:B3");
  let wb = await readSheet(env, made.sheet);
  assert.equal(wb.title, "Upload");
  assert.equal(wb.project, "p_00000001");
  assert.equal(wb.tabs[0].cells.A1, "Name", "the byte-order mark is dropped and the delimiter sniffed");
  assert.equal(wb.tabs[0].cells.B2, 3);
  assert.equal(wb.changes[0].by, "person");

  const tab = await put({ id: made.sheet, name: "More" }, "a\tb\n1\t2\n");
  assert.equal(tab.sheet, made.sheet);
  assert.equal(tab.range, "A1:B2");
  wb = await readSheet(env, made.sheet);
  assert.deepEqual(wb.tabs.map((t) => t.name), ["Sheet1", "More"]);
  assert.equal(wb.tabs.find((t) => t.id === tab.tab).cells.B2, 2);
  assert.equal(wb.rev, 2);
  const unnamed = await put({ id: made.sheet }, "x\n");
  assert.equal((await readSheet(env, made.sheet)).tabs.find((t) => t.id === unnamed.tab).name, "Imported");
  const plain = await put({}, "x,y\n");
  assert.equal((await readSheet(env, plain.sheet)).title, "Imported sheet");
  await assert.rejects(put({ id: made.sheet, name: "more" }, "a\n"), /already has a tab named "more"/);
  await assert.rejects(put({}, ""), /The upload is empty/);
  await assert.rejects(put({}, "\n\n"), /The file holds no rows/);
  await assert.rejects(put({ project: "p_00000009" }, "a\n"), /No project/);
  await assert.rejects(uiImport({}, env, { method: "GET" }), /import is an upload/);
  await done();
});
