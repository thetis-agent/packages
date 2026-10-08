// The files of a sheet: the id rule, paths under the sheet's directory, a create and a mutate with the
// revision and the change log, the lock (two writers at once both land, a dead holder's lock is taken over,
// a held one makes the next writer wait and then refuse), atomic writes that leave no temporary file, the
// listing and the removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import { applyOps, emptyWorkbook } from "../ui/core/workbook.js";
import { capRanges, createSheet, isSheetId, listSheets, mutate, newId, readSheet, removeSheet, sheetPath, withLock } from "../lib/store.js";
import { makeEnv } from "./helpers.js";

const fresh = (title = "Budget", id = newId()) => emptyWorkbook({ id, title, project: null, createdBy: "s_1", now: new Date() });

test("ids: sh_ and eight lowercase hex characters; a path outside the rule is refused in a sentence", async () => {
  for (let i = 0; i < 20; i++) assert.ok(isSheetId(newId()));
  for (const bad of ["sh_1A2B3C4D", "c_1a2b3c4d", "sh_1a2b3c4", "sh_1a2b3c4d5", "", null]) assert.ok(!isSheetId(bad), String(bad));
  const { env, done } = await makeEnv();
  assert.equal(sheetPath(env, "sh_00000001"), resolve(env.cwd, "sheets", "sh_00000001", "sheet.json"));
  assert.throws(() => sheetPath(env, "../x"), /is not a sheet id; one looks like sh_1a2b3c4d/);
  await done();
});

test("create writes revision 1 with its first Change, pretty, atomically; mutate bumps the revision and logs who changed what", async () => {
  const { env, done } = await makeEnv();
  const made = await createSheet(env, fresh("Budget", "sh_00000001"), { by: "agent", session: "s_1" });
  assert.equal(made.rev, 1);
  assert.equal(made.changes.length, 1);
  assert.deepEqual({ ...made.changes[0], at: "" }, { rev: 1, by: "agent", session: "s_1", at: "", ranges: [], what: "created the sheet" });
  const dir = resolve(env.cwd, "sheets", "sh_00000001");
  assert.deepEqual(readdirSync(dir), ["sheet.json"], "no temporary file and no lock left behind");
  assert.match(readFileSync(resolve(dir, "sheet.json"), "utf8"), /^\{\n {2}"v": 1,/);
  const next = await mutate(env, "sh_00000001", (wb) => applyOps(wb, [{ op: "set", tab: "t1", cells: { A1: 1, B2: "=A1*2" } }]), { by: "person", session: "page" });
  assert.equal(next.rev, 2);
  const last = next.changes.at(-1);
  assert.equal(last.rev, 2);
  assert.equal(last.by, "person");
  assert.equal(last.session, "page");
  assert.ok(last.ranges.length >= 1);
  assert.equal(last.ranges[0].tab, "t1");
  assert.deepEqual(await readSheet(env, "sh_00000001"), next);
  assert.deepEqual(readdirSync(dir), ["sheet.json"]);
  await assert.rejects(mutate(env, "sh_00000001", () => { throw new Error("No, a sentence."); }), /No, a sentence/);
  assert.equal((await readSheet(env, "sh_00000001")).rev, 2, "a refused change writes nothing");
  assert.deepEqual(readdirSync(dir), ["sheet.json"], "and lets go of the lock");
  await assert.rejects(mutate(env, "sh_0000000f", (wb) => ({ workbook: wb })), /No sheet sh_0000000f/);
  await done();
});

test("the change log keeps forty, and a change of many ranges keeps one bounding box per tab", async () => {
  const { env, done } = await makeEnv();
  await createSheet(env, fresh("Log", "sh_00000002"), { by: "agent" });
  for (let i = 0; i < 45; i++) await mutate(env, "sh_00000002", (wb) => applyOps(wb, [{ op: "set", tab: "t1", cells: { A1: i } }]));
  const wb = await readSheet(env, "sh_00000002");
  assert.equal(wb.rev, 46);
  assert.equal(wb.changes.length, 40);
  assert.equal(wb.changes[0].rev, 7);
  const many = Array.from({ length: 25 }, (_, i) => ({ tab: "t1", range: `A${i * 2 + 1}` }));
  assert.deepEqual(capRanges([...many, { tab: "t2", range: "C3:D4" }]), [{ tab: "t1", range: "A1:A49" }, { tab: "t2", range: "C3:D4" }]);
  assert.deepEqual(capRanges([{ tab: "t1", range: "B2:A1" }]), [{ tab: "t1", range: "A1:B2" }]);
  await done();
});

test("two writers at once: both changes land, one after the other", async () => {
  const { env, done } = await makeEnv();
  await createSheet(env, fresh("Race", "sh_00000003"), { by: "agent" });
  const slow = (cells) => async (wb) => {
    await new Promise((r) => setTimeout(r, 60));
    return applyOps(wb, [{ op: "set", tab: "t1", cells }]);
  };
  const [a, b] = await Promise.all([
    mutate(env, "sh_00000003", slow({ A1: "agent" }), { by: "agent" }),
    mutate(env, "sh_00000003", slow({ B1: "person" }), { by: "person" }),
  ]);
  assert.deepEqual([a.rev, b.rev].sort(), [2, 3]);
  const wb = await readSheet(env, "sh_00000003");
  assert.equal(wb.rev, 3);
  assert.equal(wb.tabs[0].cells.A1, "agent");
  assert.equal(wb.tabs[0].cells.B1, "person");
  assert.deepEqual(wb.changes.slice(1).map((c) => c.by).sort(), ["agent", "person"]);
  await done();
});

test("a lock older than ten seconds is taken over; a live one makes the writer wait, then refuse", async () => {
  const { env, done } = await makeEnv();
  await createSheet(env, fresh("Lock", "sh_00000004"), { by: "agent" });
  const lock = resolve(env.cwd, "sheets", "sh_00000004", ".lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const taken = await mutate(env, "sh_00000004", (wb) => applyOps(wb, [{ op: "set", tab: "t1", cells: { A1: 1 } }]));
  assert.equal(taken.rev, 2);
  assert.deepEqual(readdirSync(resolve(env.cwd, "sheets", "sh_00000004")), ["sheet.json"]);

  let order = [];
  const held = withLock(env, "sh_00000004", async () => {
    order.push("held");
    await new Promise((r) => setTimeout(r, 150));
    order.push("released");
  });
  await new Promise((r) => setTimeout(r, 20));
  await mutate(env, "sh_00000004", (wb) => {
    order.push("second");
    return applyOps(wb, [{ op: "set", tab: "t1", cells: { A2: 2 } }]);
  });
  await held;
  assert.deepEqual(order, ["held", "released", "second"]);

  mkdirSync(lock);
  const started = Date.now();
  await assert.rejects(mutate(env, "sh_00000004", (wb) => ({ workbook: wb })), /^Error: The sheet is busy; try again\.$/);
  assert.ok(Date.now() - started >= 4900, "it waited about five seconds first");
  await done();
});

test("list: real sheets only, newest first; remove takes the directory", async () => {
  const { env, done } = await makeEnv();
  await createSheet(env, fresh("One", "sh_00000005"), { by: "agent" });
  await new Promise((r) => setTimeout(r, 5));
  await createSheet(env, fresh("Two", "sh_00000006"), { by: "agent" });
  await env.writeFile("sheets/sh_00000007/sheet.json", "{ not json");
  await env.writeFile("sheets/sh_00000008/sheet.json", JSON.stringify({ ...fresh("x", "sh_00000009") }));
  await env.writeFile("sheets/stray/sheet.json", "{}");
  assert.deepEqual((await listSheets(env)).map((s) => s.id), ["sh_00000006", "sh_00000005"]);
  assert.equal(await readSheet(env, "sh_00000007"), null);
  assert.equal(await readSheet(env, "sh_00000008"), null, "a workbook whose id disagrees with its directory is not trusted");
  await removeSheet(env, "sh_00000005");
  assert.equal(await readSheet(env, "sh_00000005"), null);
  await removeSheet(env, "sh_00000005");
  await assert.rejects(mutate(env, "sh_00000005", (wb) => ({ workbook: wb })), /No sheet sh_00000005/, "a write never brings a removed sheet back");
  await done();
});
