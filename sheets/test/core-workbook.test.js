// The workbook record and applyOps: every op, purity (a frozen input is never touched and untouched tabs
// are shared), formulas following inserts, deletes, sorts, fills and tab renames, and the refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOps, cellCount, cellRanges, checkWorkbook, compactRanges, completeWorkbook, diffCells, emptyWorkbook, findTab, isSheetId, isTabId, LIMITS, newTabId, usedRange, validTabName,
} from "../ui/core/workbook.js";
import { compute } from "../ui/core/engine.js";
import { toSerial } from "../ui/core/dates.js";

const freeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freeze(v);
  }
  return o;
};

function make(cells = {}, more = {}) {
  const wb = emptyWorkbook({ id: "sh_0000abcd", title: "Budget", now: new Date("2026-10-08T12:00:00Z"), tabs: ["Sheet1", "Data"] });
  wb.tabs[0].cells = cells;
  Object.assign(wb.tabs[0], more);
  return freeze(wb);
}

const run = (wb, ...ops) => applyOps(wb, ops);
const cellsOf = (r, t = 0) => r.workbook.tabs[t].cells;

test("emptyWorkbook, completeWorkbook and checkWorkbook", () => {
  const wb = emptyWorkbook({ id: "sh_0000abcd", title: " Budget ", project: "p_00000001", createdBy: "s1", now: new Date("2026-10-08T12:00:00Z") });
  assert.deepEqual(wb, {
    v: 1, id: "sh_0000abcd", title: "Budget", project: "p_00000001", createdBy: "s1", createdAt: "2026-10-08T12:00:00.000Z", updatedAt: "2026-10-08T12:00:00.000Z", rev: 0,
    tabs: [{ id: "t1", name: "Sheet1", rows: 1000, cols: 26, cells: {}, styles: {}, widths: {}, heights: {}, freeze: { rows: 0, cols: 0 } }],
    changes: [],
  });
  assert.equal(checkWorkbook(wb), wb);
  assert.throws(() => emptyWorkbook({ id: "sh_0000abcd", title: "x", tabs: ["A", "a"] }), /already a tab named A/);
  const done = completeWorkbook({ id: "sh_0000abcd", title: "Old", tabs: [{ id: "t1", name: "S", cells: { A1: 1 } }] });
  assert.equal(done.tabs[0].rows, 1000);
  assert.deepEqual(done.tabs[0].freeze, { rows: 0, cols: 0 });
  assert.deepEqual(done.changes, []);
  assert.equal(done.project, null);
  assert.equal(completeWorkbook({}).tabs[0].name, "Sheet1");
  checkWorkbook(done);
});

test("checkWorkbook refuses what is out of rules, with a sentence", () => {
  const bad = (mutate, re) => {
    const wb = structuredClone(make({ A1: 1 }));
    mutate(wb);
    assert.throws(() => checkWorkbook(wb), re);
  };
  bad((wb) => (wb.title = ""), /title is 1 to 120/);
  bad((wb) => (wb.id = "c_1"), /sh_1a2b3c4d/);
  bad((wb) => (wb.tabs[1].id = "t1"), /used twice/);
  bad((wb) => (wb.tabs[1].name = "sheet1"), /already a tab named sheet1/i);
  bad((wb) => (wb.tabs[0].name = "a/b"), /cannot hold/);
  bad((wb) => (wb.tabs[0].cells.A1001 = 1), /outside its 1000 rows.*resize/);
  bad((wb) => (wb.tabs[0].cells.a1 = 1), /not an address/);
  bad((wb) => (wb.tabs[0].cells.B1 = ""), /empty text/);
  bad((wb) => (wb.tabs[0].cells.B1 = null), /number, text or a boolean/);
  bad((wb) => (wb.tabs[0].cells.B1 = "=" + "1+".repeat(5000) + "1"), /longer than 8192/);
  bad((wb) => (wb.tabs[0].styles.A1 = { b: true, color: "red" }), /colour like/);
  bad((wb) => (wb.tabs[0].styles.A1 = { fmt: "bogus" }), /not a number format/);
  bad((wb) => (wb.tabs[0].styles.A1 = { glow: true }), /unknown key glow/);
  bad((wb) => (wb.tabs[0].widths.AA = 100), /not one of its columns/);
  bad((wb) => (wb.tabs[0].widths.A = 5), /20 to 1000/);
  bad((wb) => (wb.tabs[0].heights["0"] = 30), /not one of its rows/);
  bad((wb) => (wb.tabs[0].freeze.rows = 2000), /freezes more/);
  bad((wb) => (wb.tabs = []), /at least one tab/);
});

test("ids, names, findTab, usedRange, cellCount", () => {
  assert.ok(isSheetId("sh_1a2b3c4d") && !isSheetId("sh_1A2B3C4D") && !isSheetId("sh_123"));
  assert.ok(isTabId("t1") && isTabId("t9999") && !isTabId("t") && !isTabId("x1"));
  assert.equal(validTabName("Q1 plan"), null);
  assert.match(validTabName(""), /needs a name/);
  assert.match(validTabName(" pad"), /start or end with a space/);
  assert.match(validTabName("x".repeat(65)), /at most 64/);
  for (const ch of "'![]*?/\\:") assert.match(validTabName(`a${ch}b`), /cannot hold/, ch);
  const wb = make({ B2: 1, D5: "x" });
  assert.equal(findTab(wb, "t2").name, "Data");
  assert.equal(findTab(wb, "data").id, "t2");
  assert.equal(findTab(wb, "nope"), null);
  assert.deepEqual(usedRange(wb.tabs[0]), { r1: 1, c1: 1, r2: 4, c2: 3 });
  assert.equal(usedRange(wb.tabs[1]), null);
  assert.equal(cellCount(wb), 2);
  assert.equal(newTabId(wb), "t3");
  assert.equal(newTabId({ tabs: [{ id: "t1" }], changes: [{ ranges: [{ tab: "t7", range: "A1" }] }] }), "t8", "a deleted tab's id seen in the log is not reused");
});

test("applyOps is pure: a frozen workbook is never touched, untouched tabs are shared", () => {
  const wb = make({ A1: 1, A2: 2, A3: "=A1+A2", B1: "x" }, { styles: { A1: { b: true } }, widths: { A: 120 }, heights: { 2: 30 } });
  const ops = [
    { op: "set", tab: "Sheet1", cells: { C1: 5 } },
    { op: "style", tab: "t1", range: "A1:B2", style: { i: true } },
    { op: "insertRows", tab: "t1", at: 1, count: 1 },
    { op: "deleteCols", tab: "t1", at: 1, count: 1 },
    { op: "sort", tab: "t1", range: "A1:A4", by: 0, desc: true },
    { op: "fill", tab: "t1", from: "A1", to: "A1:A3" },
    { op: "resize", tab: "t1", rows: 50 },
    { op: "widths", tab: "t1", cols: { A: 200 } },
    { op: "heights", tab: "t1", rows: { 4: 40 } },
    { op: "freeze", tab: "t1", rows: 1, cols: 1 },
    { op: "addTab", name: "New" },
    { op: "renameTab", tab: "Data", name: "Facts" },
    { op: "moveTab", tab: "t2", to: 0 },
    { op: "removeTab", tab: "t2" },
    { op: "title", title: "Renamed" },
  ];
  for (const op of ops) {
    const r = applyOps(wb, [op]);
    assert.notEqual(r.workbook, wb);
    assert.equal(typeof r.what, "string");
  }
  const all = applyOps(wb, ops);
  checkWorkbook(all.workbook);
  const r = run(wb, { op: "set", tab: "t1", cells: { C9: 1 } });
  assert.equal(r.workbook.tabs[1], wb.tabs[1], "the other tab is the same object");
  assert.equal(r.workbook.tabs[0].styles, wb.tabs[0].styles, "fields an op does not change are shared");
  assert.equal(r.workbook.changes, wb.changes);
});

test("set writes, clears, applies typed formats only where none is set, grows the grid, and refuses bad input", () => {
  const wb = make({ A1: 1, B1: 2 }, { styles: { B2: { fmt: "0.00" } } });
  const r = run(wb, { op: "set", tab: "Sheet1", cells: { A1: null, a2: "=A1*2", B2: 0.5, C3: "" }, fmts: { B2: "0%", A2: "0.0%" } });
  assert.deepEqual(cellsOf(r), { A2: "=A1*2", B1: 2, B2: 0.5 });
  assert.deepEqual(r.workbook.tabs[0].styles, { B2: { fmt: "0.00" }, A2: { fmt: "0.0%" } }, "B2 kept its format");
  assert.deepEqual(r.ranges, [{ tab: "t1", range: "A1" }, { tab: "t1", range: "A2:B2" }, { tab: "t1", range: "C3" }]);
  assert.equal(r.what, "wrote 4 cells");
  assert.equal(run(wb, { op: "set", tab: "t1", cells: { A1: null, B1: null } }).what, "cleared 2 cells");
  const grown = run(wb, { op: "set", tab: "t1", cells: { AB1500: "far" } });
  assert.equal(grown.workbook.tabs[0].rows, 1500);
  assert.equal(grown.workbook.tabs[0].cols, 28);
  assert.throws(() => run(wb, { op: "set", tab: "t1", cells: { "B-1": 1 } }), /not a cell address like B3/);
  assert.throws(() => run(wb, { op: "set", tab: "t1", cells: { A20001: 1 } }), /rows 1 to 20000/);
  assert.throws(() => run(wb, { op: "set", tab: "t1", cells: { A1: { x: 1 } } }), /number, text or a boolean/);
  assert.throws(() => run(wb, { op: "set", tab: "t1", cells: { A1: NaN } }), /not finite/);
  assert.throws(() => run(wb, { op: "set", tab: "t1", cells: { A1: "x".repeat(32768) } }), /32767/);
  assert.throws(() => run(wb, { op: "set", tab: "Nope", cells: { A1: 1 } }), /no tab Nope.*Sheet1, Data/);
  assert.throws(() => run(wb, { op: "set", tab: "t1" }), /set needs cells/);
  assert.throws(() => run(wb, { op: "explode" }), /Unknown op "explode"; the ops are set, style/);
});

test("style sets and removes keys, clears, clips whole columns, deletes empty styles", () => {
  const wb = make({}, { styles: { A1: { b: true, fill: "#ffffff" }, A5: { i: true } } });
  let r = run(wb, { op: "style", tab: "t1", range: "A1:B2", style: { b: null, color: "#FF0000", fmt: "currency" } });
  assert.deepEqual(r.workbook.tabs[0].styles, {
    A1: { fill: "#ffffff", color: "#ff0000", fmt: "$#,##0.00" },
    B1: { color: "#ff0000", fmt: "$#,##0.00" },
    A2: { color: "#ff0000", fmt: "$#,##0.00" },
    B2: { color: "#ff0000", fmt: "$#,##0.00" },
    A5: { i: true },
  });
  assert.equal(r.what, "formatted A1:B2");
  r = run(wb, { op: "style", tab: "t1", range: "A:A", style: { i: null, fill: null, b: false } });
  assert.deepEqual(r.workbook.tabs[0].styles, {}, "removing every key deletes the style");
  r = run(wb, { op: "style", tab: "t1", range: "A:A", style: { wrap: true }, clear: true });
  assert.equal(Object.keys(r.workbook.tabs[0].styles).length, 1000);
  assert.deepEqual(r.workbook.tabs[0].styles.A1, { wrap: true });
  assert.deepEqual(r.ranges, [{ tab: "t1", range: "A1:A1000" }]);
  r = run(wb, { op: "style", tab: "t1", range: "A1:Z9", clear: true });
  assert.deepEqual(r.workbook.tabs[0].styles, {});
  assert.equal(r.what, "cleared the formatting of A1:Z9");
  r = run(wb, { op: "style", tab: "t1", range: "A1", style: { fmt: "general" } });
  assert.deepEqual(r.workbook.tabs[0].styles.A1, { b: true, fill: "#ffffff" });
  assert.throws(() => run(wb, { op: "style", tab: "t1", range: "A1", style: { fill: "blue" } }), /colour like #1a2b3c/);
  assert.throws(() => run(wb, { op: "style", tab: "t1", range: "A1", style: { align: "middle" } }), /left, center, right/);
  assert.throws(() => run(wb, { op: "style", tab: "t1", range: "A1", style: { fmt: "money" } }), /not a number format/);
  assert.throws(() => run(wb, { op: "style", tab: "t1", range: "nope", style: { b: true } }), /not a range like A1:D4/);
  assert.throws(() => run(wb, { op: "style", tab: "t1", range: "AB1", style: { b: true } }), /outside the tab Sheet1/);
});

test("insertRows moves cells, styles, heights and freeze, and rewrites formulas in every tab", () => {
  const wb = freeze({
    ...make(),
    tabs: [
      { ...make().tabs[0], cells: { A1: 1, A2: 2, A3: 3, A4: "=SUM(A1:A3)", B4: "=A3*$A$3", C1: "=Data!A2" }, styles: { A3: { b: true } }, heights: { 3: 40, 1: 30 }, freeze: { rows: 2, cols: 0 } },
      { ...make().tabs[1], cells: { A1: "=Sheet1!A3+A3", A2: 5, B1: "=SUM(Sheet1!A:A)" } },
    ],
  });
  const r = run(wb, { op: "insertRows", tab: "Sheet1", at: 1, count: 2 });
  const [s, d] = r.workbook.tabs;
  assert.deepEqual(s.cells, { A1: 1, A4: 2, A5: 3, A6: "=SUM(A1:A5)", B6: "=A5*$A$5", C1: "=Data!A2" });
  assert.deepEqual(s.styles, { A5: { b: true } });
  assert.deepEqual(s.heights, { 1: 30, 5: 40 });
  assert.deepEqual(s.freeze, { rows: 4, cols: 0 }, "inserting inside the frozen rows grows them");
  assert.equal(s.rows, 1002);
  assert.deepEqual(d.cells, { A1: "=Sheet1!A5+A3", A2: 5, B1: "=SUM(Sheet1!A:A)" });
  assert.deepEqual(r.ranges, [{ tab: "t1", range: "A2:Z3" }]);
  assert.equal(r.what, "inserted 2 rows at row 2");
  assert.equal(compute(r.workbook).value("t1", "A6"), 6);
  assert.throws(() => run(wb, { op: "insertRows", tab: "t1", at: 1001, count: 1 }), /Insert rows at 1 to 1001/);
  assert.throws(() => run(wb, { op: "insertRows", tab: "t1", at: 0, count: 19001 }), /grow past 20,000 rows/);
  assert.equal(run(wb, { op: "insertRows", tab: "t1", at: 1000 }).workbook.tabs[0].rows, 1001, "appending at the end");
});

test("inserted rows and columns take the formatting of the one before them", () => {
  const wb = make({ A1: "Item", B2: 5, B3: 6, B4: "=SUM(B2:B3)" }, { styles: { A1: { b: true }, B3: { fmt: "$#,##0.00" }, B4: { b: true, fmt: "$#,##0.00" } } });
  const rows = run(wb, { op: "insertRows", tab: "t1", at: 3, count: 2 }).workbook.tabs[0].styles;
  assert.deepEqual(rows.B4, { fmt: "$#,##0.00" }, "the row above's currency, not the total's bold");
  assert.deepEqual(rows.B5, { fmt: "$#,##0.00" });
  assert.deepEqual(rows.B6, { b: true, fmt: "$#,##0.00" }, "the total moved down keeps its own");
  assert.equal(run(wb, { op: "insertRows", tab: "t1", at: 0 }).workbook.tabs[0].styles.A1, undefined, "a row inserted at the top has nothing above it");
  const cols = run(wb, { op: "insertCols", tab: "t1", at: 2 }).workbook.tabs[0].styles;
  assert.deepEqual(cols.C3, { fmt: "$#,##0.00" });
});

test("deleteRows drops the rows, moves the rest up, shrinks ranges and turns lost references into #REF!", () => {
  const wb = make({ A1: 1, A2: 2, A3: 3, A4: 4, A5: "=SUM(A1:A4)", B5: "=A2+A4", B1: "=A3" }, { styles: { A2: { b: true }, A4: { i: true } }, heights: { 2: 30, 4: 50 }, freeze: { rows: 3, cols: 0 } });
  const r = run(wb, { op: "deleteRows", tab: "t1", at: 1, count: 2 });
  const s = r.workbook.tabs[0];
  assert.deepEqual(s.cells, { A1: 1, A2: 4, A3: "=SUM(A1:A2)", B3: "=#REF!+A2", B1: "=#REF!" });
  assert.deepEqual(s.styles, { A2: { i: true } });
  assert.deepEqual(s.heights, { 2: 50 });
  assert.deepEqual(s.freeze, { rows: 1, cols: 0 });
  assert.equal(s.rows, 998);
  assert.equal(r.what, "deleted 2 rows at row 2");
  const v = compute(r.workbook);
  assert.equal(v.value("t1", "A3"), 5);
  assert.equal(v.value("t1", "B1").err, "#REF!");
  assert.throws(() => run(wb, { op: "deleteRows", tab: "t1", at: 999, count: 2 }), /only 1000 rows/);
  assert.throws(() => run(make({}, { rows: 3 }), { op: "deleteRows", tab: "t1", at: 0, count: 3 }), /at least one row/);
});

test("insertCols and deleteCols move widths and rewrite column references", () => {
  const wb = make({ A1: 1, B1: 2, C1: "=A1+B1", D1: "=SUM(A:B)" }, { widths: { B: 150, D: 80 }, freeze: { rows: 0, cols: 2 } });
  let r = run(wb, { op: "insertCols", tab: "t1", at: 1, count: 1 });
  assert.deepEqual(cellsOf(r), { A1: 1, C1: 2, D1: "=A1+C1", E1: "=SUM(A:C)" });
  assert.deepEqual(r.workbook.tabs[0].widths, { C: 150, E: 80 });
  assert.equal(r.workbook.tabs[0].cols, 27);
  assert.deepEqual(r.workbook.tabs[0].freeze, { rows: 0, cols: 3 });
  assert.equal(r.what, "inserted 1 column at column B");
  r = run(wb, { op: "deleteCols", tab: "t1", at: 0, count: 1 });
  assert.deepEqual(cellsOf(r), { A1: 2, B1: "=#REF!+A1", C1: "=SUM(A:A)" });
  assert.deepEqual(r.workbook.tabs[0].widths, { A: 150, C: 80 });
  assert.equal(r.workbook.tabs[0].cols, 25);
});

test("sort is stable, orders numbers, text, booleans, keeps blanks last, moves formulas and styles with their rows", () => {
  const wb = make({
    A1: "Name", B1: "Score", C1: "Double",
    A2: "bob", B2: 75, C2: "=B2*2",
    A3: "Ann", B3: 90, C3: "=B3*2",
    A4: "cat", B4: "n/a", C4: "=B4",
    A5: "dan", C5: "x",
    A6: "eve", B6: 75, C6: "=B6*2",
    A7: "fay", B7: true,
    A8: "gus", B8: "=10*6",
  }, { styles: { A3: { b: true } } });
  let r = run(wb, { op: "sort", tab: "t1", range: "A1:C8", by: "B", header: true });
  let c = cellsOf(r);
  const col = (k) => [2, 3, 4, 5, 6, 7, 8].map((i) => c[`${k}${i}`]);
  assert.deepEqual(col("A"), ["gus", "bob", "eve", "Ann", "cat", "fay", "dan"], "by computed value: 60 (a formula), 75, 75, 90, text, boolean, blank");
  assert.deepEqual(col("C"), [undefined, "=B3*2", "=B4*2", "=B5*2", "=B6", undefined, "x"]);
  assert.equal(c.B2, "=10*6");
  assert.deepEqual(r.workbook.tabs[0].styles, { A5: { b: true } });
  assert.equal(c.A1, "Name", "the header stays");
  assert.equal(r.what, "sorted A1:C8 by column B");
  assert.equal(compute(r.workbook).value("t1", "C3"), 150);
  r = run(wb, { op: "sort", tab: "t1", range: "A2:C8", by: 1, desc: true });
  c = cellsOf(r);
  assert.deepEqual(col("A"), ["fay", "cat", "Ann", "bob", "eve", "gus", "dan"], "descending reverses all but the blanks, which stay last; ties keep their order");
  r = run(wb, { op: "sort", tab: "t1", range: "A2:A8", by: "A" });
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map((i) => cellsOf(r)[`A${i}`]), ["Ann", "bob", "cat", "dan", "eve", "fay", "gus"], "text without case");
  assert.equal(cellsOf(r).B2, 75, "columns outside the range stay");
  assert.throws(() => run(wb, { op: "sort", tab: "t1", range: "A1:B8", by: "C" }), /Sort by a column inside A1:B8/);
});

test("fill continues numeric series, copies single values and text, translates formulas, copies styles, in all four directions", () => {
  const d0 = toSerial(2026, 1, 1);
  const wb = make({ A1: 1, A2: 2, B1: 10, B2: 8, C1: 5, D1: "=A1*2", E1: "x", E2: "y", F1: d0, F2: d0 + 7, G5: 3, G6: 6, H1: 1, I1: 1.5 }, { styles: { D1: { b: true } } });
  let r = run(wb, { op: "fill", tab: "t1", from: "A1:F2", to: "A1:F6" });
  const c = cellsOf(r);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => c[`A${i}`]), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => c[`B${i}`]), [10, 8, 6, 4, 2, 0]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => c[`C${i}`]), [5, undefined, 5, undefined, 5, undefined], "a number with a blank below is no series: the block repeats");
  assert.deepEqual([1, 3, 5].map((i) => c[`D${i}`]), ["=A1*2", "=A3*2", "=A5*2"]);
  assert.deepEqual([1, 2, 3, 4].map((i) => c[`E${i}`]), ["x", "y", "x", "y"]);
  assert.equal(c.F4, d0 + 21, "dates are numbers: a weekly series");
  assert.deepEqual(r.workbook.tabs[0].styles.D3, { b: true });
  assert.equal(r.what, "filled A1:F6 from A1:F2");
  r = run(wb, { op: "fill", tab: "t1", from: "C1", to: "C1:C4" });
  assert.deepEqual([1, 2, 3, 4].map((i) => cellsOf(r)[`C${i}`]), [5, 5, 5, 5], "a single number is copied");
  r = run(wb, { op: "fill", tab: "t1", from: "G5:G6", to: "G1:G6" });
  assert.deepEqual([1, 2, 3, 4].map((i) => cellsOf(r)[`G${i}`]), [-9, -6, -3, 0], "upward continues the series backwards");
  r = run(wb, { op: "fill", tab: "t1", from: "H1:I1", to: "H1:L1" });
  assert.deepEqual(["J1", "K1", "L1"].map((a) => cellsOf(r)[a]), [2, 2.5, 3], "to the right");
  r = run(wb, { op: "fill", tab: "t1", from: "D1", to: "B1:D1" });
  assert.deepEqual([cellsOf(r).B1, cellsOf(r).C1], ["=#REF!*2", "=#REF!*2"], "to the left, references pushed off the grid");
  r = run(wb, { op: "fill", tab: "t1", from: "D1", to: "D1:D1500" });
  assert.equal(cellsOf(r).D1500, "=A1500*2");
  assert.equal(r.workbook.tabs[0].rows, 1500, "the grid grows to the fill");
  assert.throws(() => run(wb, { op: "fill", tab: "t1", from: "A1:A2", to: "A3:A9" }), /must contain the source/);
});

test("resize, widths, heights and freeze", () => {
  const wb = make({ C10: 1 }, { styles: { E50: { b: true } }, widths: { Z: 90 }, heights: { 900: 30 }, freeze: { rows: 5, cols: 0 } });
  let r = run(wb, { op: "resize", tab: "t1", rows: 20, cols: 5 });
  const t = r.workbook.tabs[0];
  assert.deepEqual([t.rows, t.cols, t.styles, t.widths, t.heights, t.freeze], [20, 5, {}, {}, {}, { rows: 5, cols: 0 }]);
  assert.throws(() => run(wb, { op: "resize", tab: "t1", rows: 9 }), /Row 10 still holds data/);
  assert.throws(() => run(wb, { op: "resize", tab: "t1", cols: 2 }), /Column C still holds data/);
  assert.throws(() => run(wb, { op: "resize", tab: "t1", rows: 20001 }), /1 to 20,000 rows/);
  r = run(wb, { op: "widths", tab: "t1", cols: { A: 140.4, Z: null } }, { op: "heights", tab: "t1", rows: { 3: 40, 900: null } }, { op: "freeze", tab: "t1", rows: 1, cols: 2 });
  assert.deepEqual(r.workbook.tabs[0].widths, { A: 140 });
  assert.deepEqual(r.workbook.tabs[0].heights, { 3: 40 });
  assert.deepEqual(r.workbook.tabs[0].freeze, { rows: 1, cols: 2 });
  assert.throws(() => run(wb, { op: "widths", tab: "t1", cols: { A: 5 } }), /20 to 1000 px/);
  assert.throws(() => run(wb, { op: "widths", tab: "t1", cols: { AA: 50 } }), /not a column of Sheet1/);
  assert.throws(() => run(wb, { op: "heights", tab: "t1", rows: { 3: 500 } }), /16 to 400 px/);
  assert.throws(() => run(wb, { op: "heights", tab: "t1", rows: { 0: 30 } }), /not a row/);
  assert.throws(() => run(wb, { op: "freeze", tab: "t1", rows: -1, cols: 0 }), /Freeze 0 to/);
});

test("tabs: add (with a chosen id), rename rewriting references, remove turning references into #REF!, move; title", () => {
  const wb = freeze({ ...make(), tabs: [{ ...make().tabs[0], cells: { A1: "=Data!B2+'Data'!C3", A2: "=data!A1" } }, { ...make().tabs[1], cells: { B2: 1, C3: 2, D1: "=Data!B2*2" } }] });
  let r = run(wb, { op: "addTab", name: "Notes", at: 1 });
  assert.deepEqual(r.workbook.tabs.map((t) => [t.id, t.name]), [["t1", "Sheet1"], ["t3", "Notes"], ["t2", "Data"]]);
  assert.deepEqual(r.ranges, [{ tab: "t3", range: "A1" }]);
  r = run(wb, { op: "addTab", name: "Mine", id: "t12" });
  assert.equal(r.workbook.tabs[2].id, "t12");
  assert.throws(() => run(wb, { op: "addTab", name: "X", id: "t2" }), /t2 is taken/);
  assert.throws(() => run(wb, { op: "addTab", name: "DATA" }), /already a tab named Data/);
  assert.throws(() => run(wb, { op: "addTab", name: "a:b" }), /cannot hold/);
  r = run(wb, { op: "renameTab", tab: "t2", name: "Q1 data" });
  assert.deepEqual(r.workbook.tabs[0].cells, { A1: "='Q1 data'!B2+'Q1 data'!C3", A2: "='Q1 data'!A1" });
  assert.deepEqual(r.workbook.tabs[1].cells.D1, "='Q1 data'!B2*2");
  assert.equal(compute(r.workbook).value("t1", "A1"), 3);
  assert.equal(r.what, "renamed the tab Data to Q1 data");
  assert.equal(run(wb, { op: "renameTab", tab: "t2", name: "DATA" }).workbook.tabs[1].name, "DATA", "a tab may change its own name's case");
  r = run(wb, { op: "removeTab", tab: "Data" });
  assert.deepEqual(r.workbook.tabs[0].cells, { A1: "=#REF!+#REF!", A2: "=#REF!" });
  assert.equal(r.workbook.tabs.length, 1);
  assert.throws(() => run(r.workbook, { op: "removeTab", tab: "t1" }), /at least one tab; delete the whole sheet/);
  r = run(wb, { op: "moveTab", tab: "Data", to: 0 });
  assert.deepEqual(r.workbook.tabs.map((t) => t.id), ["t2", "t1"]);
  assert.throws(() => run(wb, { op: "moveTab", tab: "Data", to: 2 }), /0 to 1/);
  r = run(wb, { op: "title", title: "  Plan  " });
  assert.equal(r.workbook.title, "Plan");
  assert.throws(() => run(wb, { op: "title", title: "" }), /1 to 120/);
  let many = wb;
  for (let k = 0; k < LIMITS.tabs - 2; k++) many = run(many, { op: "addTab", name: `T${k}` }).workbook;
  assert.throws(() => run(many, { op: "addTab", name: "one more" }), /at most 32 tabs/);
});

test("several ops in one call: ranges compacted, a short phrase", () => {
  const wb = make();
  const ops = [];
  for (let k = 0; k < 25; k++) ops.push({ op: "set", tab: "t1", cells: { [`A${k * 3 + 1}`]: k } });
  const r = applyOps(wb, ops);
  assert.equal(r.what, "wrote 25 cells");
  assert.deepEqual(r.ranges, [{ tab: "t1", range: "A1:A73" }]);
  const mixed = applyOps(wb, [{ op: "set", tab: "t1", cells: { A1: 1 } }, { op: "style", tab: "t1", range: "A1", style: { b: true } }]);
  assert.equal(mixed.what, "wrote 1 cell, formatted A1");
  const full = {};
  for (let k = 0; k < LIMITS.cells - 1; k++) full[`${String.fromCharCode(65 + (k % 13))}${Math.floor(k / 13) + 1}`] = 1;
  const big = make(full, { rows: 20000 });
  assert.equal(applyOps(big, [{ op: "set", tab: "t1", cells: { Z1: 1 } }]).workbook.tabs[0].cells.Z1, 1);
  assert.throws(() => applyOps(big, [{ op: "set", tab: "t1", cells: { Z1: 1, Z2: 2 } }]), /at most 250,000 non-empty cells.*Split/);
  assert.throws(() => applyOps(wb, [{ op: "fill", tab: "t1", from: "A1", to: "A1:M20000" }]), /would write 260,000 cells/);
});

test("diffCells, cellRanges and compactRanges", () => {
  const a = make({ A1: 1, A2: 2, C5: "x" }, { styles: { B1: { b: true } } });
  const b = run(a, { op: "set", tab: "t1", cells: { A1: 9, A2: 8, C5: null } }, { op: "style", tab: "t1", range: "B1", style: { b: null } }).workbook;
  assert.deepEqual(diffCells(a, b), [{ tab: "t1", range: "A1:B1" }, { tab: "t1", range: "A2" }, { tab: "t1", range: "C5" }]);
  assert.deepEqual(diffCells(a, a), []);
  assert.deepEqual(cellRanges(["A1", "B1", "A2", "B2", "D4"]), [{ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 3, c1: 3, r2: 3, c2: 3 }]);
  assert.deepEqual(cellRanges(["A1", "C1"], 1), [{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
  const many = Array.from({ length: 30 }, (_, k) => ({ tab: k % 2 ? "t1" : "t2", range: `A${k * 2 + 1}` }));
  assert.deepEqual(compactRanges(many), [{ tab: "t2", range: "A1:A57" }, { tab: "t1", range: "A3:A59" }]);
});

test("sorting whole columns leaves the blank rows below the data where they are", () => {
  const wb = make({ A1: 3, A2: 1, A3: 2, B5: "x" }, { styles: { A900: { b: true } } });
  const r = run(wb, { op: "sort", tab: "t1", range: "A:A", by: 0 });
  assert.deepEqual(cellsOf(r), { A1: 1, A2: 2, A3: 3, B5: "x" });
  assert.deepEqual(r.workbook.tabs[0].styles, { A900: { b: true } });
  assert.deepEqual(r.ranges, [{ tab: "t1", range: "A1:A1000" }]);
  assert.equal(run(make(), { op: "sort", tab: "t1", by: 0 }).what, "sorted nothing");
});
