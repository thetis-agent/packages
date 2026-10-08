// The calculator over a whole workbook: values of every kind of cell, operators and their coercions,
// references across tabs, circular references, chains deeper than the stack, the error list, and speed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compute, evaluate } from "../ui/core/engine.js";
import { addr } from "../ui/core/address.js";

const tab = (id, name, cells, rows = 1000, cols = 26) => ({ id, name, rows, cols, cells, styles: {}, widths: {}, heights: {}, freeze: { rows: 0, cols: 0 } });
const book = (...tabs) => ({ v: 1, id: "sh_00000001", title: "T", tabs, changes: [] });
const one = (cells) => compute(book(tab("t1", "Sheet1", cells)));

test("values of plain cells, text with an apostrophe, and formulas", () => {
  const r = one({ A1: 2, A2: "'=not a formula", A3: "text", A4: true, B1: "=A1*3", B2: "=A2", B3: "=Z99", B4: "=Z99+1" });
  assert.equal(r.value("t1", "A1"), 2);
  assert.equal(r.value("t1", "A2"), "=not a formula");
  assert.equal(r.value("t1", "A3"), "text");
  assert.equal(r.value("t1", "A4"), true);
  assert.equal(r.value("t1", "B1"), 6);
  assert.equal(r.value("t1", "B2"), "=not a formula");
  assert.equal(r.value("t1", "B3"), null, "a reference to a blank is blank, as in Sheets");
  assert.equal(r.value("t1", "B4"), 1);
  assert.equal(r.value("t1", "C9"), null);
  assert.equal(r.value("t1", "b1"), 6, "addresses in any case");
  assert.equal(r.value("Sheet1", "B1"), 6, "a tab by name");
  assert.equal(r.value("nope", "B1"), null);
  assert.deepEqual([...r.all("t1").keys()], ["A1", "B1", "A2", "B2", "A3", "B3", "A4", "B4"], "row by row");
  assert.equal(r.all("t1"), r.all("t1"));
});

test("operators: coercions, comparisons, precedence and errors", () => {
  const cases = {
    '="3"+4': 7,
    "=TRUE+1": 2,
    '="a"&1.5': "a1.5",
    '=1/3&""': "0.333333333333333",
    '=""&TRUE': "TRUE",
    "=0.1+0.2=0.3": true,
    '="a"="A"': true,
    '=1<"a"': true,
    '="z"<TRUE': true,
    "=B9=0": true,
    '=B9=""': true,
    "=-2^2": 4,
    "=2^3^2": 64,
    "=-(2^2)": -4,
    "=50%*50%": 0.25,
    "=2*3+4": 10,
    '=1+2&"x"': "3x",
    "=10-4-3": 3,
    "=+\"keep\"": "keep",
    '="2026-10-08"+1': 46304,
    "=1e3": 1000,
  };
  for (const [f, want] of Object.entries(cases)) assert.equal(evaluate(book(tab("t1", "S", {})), "t1", f), want, f);
  const errs = { '="abc"+1': "#VALUE!", "=1/0": "#DIV/0!", "=(-8)^(1/3)": "#NUM!", "=0^-1": "#DIV/0!", "=#N/A+1": "#N/A", "=SUM(": "#ERROR!", "=10^400": "#NUM!" };
  for (const [f, code] of Object.entries(errs)) assert.equal(evaluate(book(tab("t1", "S", {})), "t1", f).err, code, f);
});

test("a range where one value goes: implicit intersection in the formula's row or column, else #VALUE!", () => {
  const r = one({ B1: 10, B2: 20, B3: 30, A1: "=B:B*2", A2: "=B1:B3+1", A3: "=B1:B2", C5: "=B1:B3", D1: 5, E1: 6, D7: "=D1:E1*2" });
  assert.equal(r.value("t1", "A1"), 20);
  assert.equal(r.value("t1", "A2"), 21);
  assert.equal(r.value("t1", "A3").err, "#VALUE!");
  assert.equal(r.value("t1", "C5").err, "#VALUE!");
  assert.equal(r.value("t1", "D7"), 10, "a row range meets the formula's column");
});

test("references across tabs, quoted names, and missing tabs", () => {
  const wb = book(tab("t1", "Data", { A1: 5, B1: "='My tab'!A1+A1" }), tab("t2", "My tab", { A1: 7, B1: "=Data!A1*2", C1: "=data!b1", D1: "=Gone!A1", E1: "=SUM(Data!A:A)" }));
  const r = compute(wb);
  assert.equal(r.value("t1", "B1"), 12);
  assert.equal(r.value("t2", "B1"), 10);
  assert.equal(r.value("t2", "C1"), 12, "tab names match without case");
  assert.deepEqual(r.value("t2", "D1"), { err: "#REF!", msg: "There is no tab named Gone." });
  assert.equal(r.value("t2", "E1"), 5);
});

test("circular references make #CYCLE! of every cell on the cycle; cells that only read it get the error too", () => {
  const r = one({ A1: "=A1", B1: "=C1+1", C1: "=B1*2", D1: "=B1+1", E1: "=SUM(E:E)", F1: 3, F2: "=F1*2" });
  assert.equal(r.value("t1", "A1").err, "#CYCLE!");
  assert.equal(r.value("t1", "B1").err, "#CYCLE!");
  assert.equal(r.value("t1", "C1").err, "#CYCLE!");
  assert.equal(r.value("t1", "D1").err, "#CYCLE!");
  assert.equal(r.value("t1", "E1").err, "#CYCLE!", "a range that holds its own cell");
  assert.equal(r.value("t1", "F2"), 6, "the rest computes");
  assert.deepEqual(r.errors.map((e) => e.addr), ["A1", "B1", "C1", "D1", "E1"]);
  assert.ok(r.errors.every((e) => e.tab === "t1" && e.value.msg));
  const lazy = one({ A1: "=IF(TRUE,1,A1)" });
  assert.equal(lazy.value("t1", "A1"), 1, "a branch not taken is not a cycle");
});

test("chains far deeper than the stack compute in either direction, and a long cycle is still found", () => {
  const N = 20000;
  const down = {};
  const up = {};
  down.A1 = 1;
  for (let i = 2; i <= N; i++) down[`A${i}`] = `=A${i - 1}+1`;
  for (let i = 1; i < N; i++) up[`A${i}`] = `=A${i + 1}+1`;
  up[`A${N}`] = 1;
  const a = one(down);
  assert.equal(a.value("t1", `A${N}`), N);
  const b = compute(book(tab("t1", "S", up, N)));
  assert.equal(b.value("t1", "A1"), N);
  assert.equal(b.errors.length, 0);
  const loop = { ...up, [`A${N}`]: "=A1" };
  const c = compute(book(tab("t1", "S", loop, N)));
  assert.equal(c.value("t1", "A1").err, "#CYCLE!");
  assert.equal(c.value("t1", `A${N}`).err, "#CYCLE!");
  assert.equal(c.errors.length, N);
});

test("errors list every error cell, tab by tab, row by row, with their messages", () => {
  const r = compute(book(tab("t1", "A", { B2: "=1/0", A1: "=FOO()", C1: 1 }), tab("t2", "B", { A1: "=NA()", A2: "=SUM(1" })));
  assert.deepEqual(r.errors.map((e) => [e.tab, e.addr, e.value.err]), [
    ["t1", "A1", "#NAME?"],
    ["t1", "B2", "#DIV/0!"],
    ["t2", "A1", "#N/A"],
    ["t2", "A2", "#ERROR!"],
  ]);
  assert.match(r.errors[3].value.msg, /not closed/);
});

test("evaluate runs a formula that is stored nowhere, at a given cell", () => {
  const wb = book(tab("t1", "Data", { A1: 1, A2: 2, A3: 3 }));
  assert.equal(evaluate(wb, "t1", "SUM(A1:A3)"), 6, "with or without =");
  assert.equal(evaluate(wb, "Data", "=ROW()", { row: 9 }), 10);
  assert.equal(evaluate(wb, "t1", "=A1:A3*10", { row: 1 }), 20);
  assert.equal(evaluate(wb, "t1", "=1+").err, "#ERROR!");
  assert.equal(evaluate(wb, "t1", "=TODAY()", { now: new Date(2026, 9, 8) }), 46303);
});

test("speed: 20,000 formulas recompute in well under a quarter second, faster on the second run", () => {
  const cells = {};
  for (let r = 1; r <= 5000; r++) {
    cells[`A${r}`] = r;
    cells[`B${r}`] = r * 1.5;
    cells[`C${r}`] = `=A${r}*2+B${r}`;
    cells[`D${r}`] = r === 1 ? "=C1" : `=D${r - 1}+C${r}`;
    cells[`E${r}`] = `=IF(C${r}>100,"big",ROUND(C${r}/3,2))`;
    cells[`F${r}`] = `=VLOOKUP(A${(r % 50) + 1},A1:C60,3,FALSE)`;
  }
  cells.G1 = "=SUM(C:C)";
  cells.G2 = '=COUNTIF(E:E,"big")';
  const wb = book(tab("t1", "S", cells, 5000));
  let t0 = performance.now();
  let r = compute(wb);
  const first = performance.now() - t0;
  t0 = performance.now();
  r = compute(wb);
  const second = performance.now() - t0;
  assert.equal(r.value("t1", "C10"), 35);
  assert.equal(r.value("t1", "D3"), 21, "running total of 3.5r");
  assert.equal(r.value("t1", "G2"), 5000 - 28);
  assert.equal(r.errors.length, 0);
  assert.ok(second < 250, `second compute took ${second.toFixed(1)} ms`);
  assert.ok(first < 1000, `first compute took ${first.toFixed(1)} ms`);
});

test("running totals down a long column stay fast and exact; block totals carry errors and skip text", () => {
  const cells = {};
  for (let r = 1; r <= 10000; r++) {
    cells[`A${r}`] = r;
    cells[`B${r}`] = `=SUM($A$1:A${r})`;
  }
  cells.A5000 = "text";
  cells.C1 = "=COUNT(A:A)";
  cells.C2 = "=AVERAGE(A1:A3)";
  const t0 = performance.now();
  const r = compute(book(tab("t1", "S", cells, 10000)));
  const ms = performance.now() - t0;
  assert.equal(r.value("t1", "B10000"), 50005000 - 5000);
  assert.equal(r.value("t1", "B4999"), (4999 * 5000) / 2);
  assert.equal(r.value("t1", "C1"), 9999);
  assert.equal(r.value("t1", "C2"), 2);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  const bad = compute(book(tab("t1", "S", { ...cells, A70: "=1/0" }, 10000)));
  assert.equal(bad.value("t1", "B69"), (69 * 70) / 2);
  assert.equal(bad.value("t1", "B70").err, "#DIV/0!");
  assert.equal(bad.value("t1", "B9000").err, "#DIV/0!");
  assert.equal(bad.value("t1", "C1"), 9998, "COUNT skips the error");
});
