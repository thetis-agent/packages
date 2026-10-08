// A1 notation: column letters both ways, cell and range parsing (whole rows and columns clipped to a tab),
// qualified references with quoted tab names, and the small range helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, area, boundingBox, colIndex, colName, eachCell, MAX_COLS, MAX_ROWS, parseAddr, parseQualified, parseRange, quoteTab, rangeText } from "../ui/core/address.js";

test("colName and colIndex are inverse over the whole grid", () => {
  assert.equal(colName(0), "A");
  assert.equal(colName(25), "Z");
  assert.equal(colName(26), "AA");
  assert.equal(colName(51), "AZ");
  assert.equal(colName(701), "ZZ");
  assert.equal(colIndex("AA"), 26);
  assert.equal(colIndex("zz"), 701);
  assert.equal(colIndex("A1"), -1);
  assert.equal(colIndex(""), -1);
  for (let i = 0; i < MAX_COLS; i++) assert.equal(colIndex(colName(i)), i);
});

test("addr and parseAddr: 0-based in, lower case and $ accepted, off-grid refused", () => {
  assert.equal(addr(2, 1), "B3");
  assert.deepEqual(parseAddr("B3"), { row: 2, col: 1 });
  assert.deepEqual(parseAddr("b3"), { row: 2, col: 1 });
  assert.deepEqual(parseAddr("$B$3"), { row: 2, col: 1 });
  assert.equal(parseAddr("B0"), null);
  assert.equal(parseAddr("AAA1"), null, "past ZZ");
  assert.equal(parseAddr(`A${MAX_ROWS + 1}`), null);
  assert.deepEqual(parseAddr(`ZZ${MAX_ROWS}`), { row: MAX_ROWS - 1, col: MAX_COLS - 1 });
  assert.equal(parseAddr("B 3"), null);
  assert.equal(parseAddr(null), null);
});

test("parseRange normalizes and clips whole rows and columns", () => {
  assert.deepEqual(parseRange("A1"), { r1: 0, c1: 0, r2: 0, c2: 0 });
  assert.deepEqual(parseRange("A1:C3"), { r1: 0, c1: 0, r2: 2, c2: 2 });
  assert.deepEqual(parseRange("C3:A1"), { r1: 0, c1: 0, r2: 2, c2: 2 });
  assert.deepEqual(parseRange("B:B", { rows: 1000, cols: 26 }), { r1: 0, c1: 1, r2: 999, c2: 1 });
  assert.deepEqual(parseRange("D:B", { rows: 50 }), { r1: 0, c1: 1, r2: 49, c2: 3 });
  assert.deepEqual(parseRange("3:3", { rows: 1000, cols: 26 }), { r1: 2, c1: 0, r2: 2, c2: 25 });
  assert.deepEqual(parseRange("3:10"), { r1: 2, c1: 0, r2: 9, c2: MAX_COLS - 1 });
  assert.deepEqual(parseRange(" $A$1:$B$2 "), { r1: 0, c1: 0, r2: 1, c2: 1 });
  for (const bad of ["", "A", "1", "A1:", "A1:B2:C3", "Sheet1!A1", "A0:B2", "x"]) assert.equal(parseRange(bad), null, bad);
});

test("rangeText, area, eachCell and boundingBox", () => {
  assert.equal(rangeText({ r1: 0, c1: 0, r2: 2, c2: 2 }), "A1:C3");
  assert.equal(rangeText({ r1: 4, c1: 1, r2: 4, c2: 1 }), "B5");
  assert.equal(area({ r1: 0, c1: 0, r2: 2, c2: 1 }), 6);
  const seen = [];
  eachCell({ r1: 0, c1: 0, r2: 1, c2: 1 }, (r, c) => seen.push(addr(r, c)));
  assert.deepEqual(seen, ["A1", "B1", "A2", "B2"]);
  assert.deepEqual(boundingBox([{ r1: 3, c1: 2, r2: 4, c2: 2 }, null, { r1: 0, c1: 5, r2: 1, c2: 6 }]), { r1: 0, c1: 2, r2: 4, c2: 6 });
  assert.equal(boundingBox([]), null);
});

test("parseQualified and quoteTab round-trip tab names", () => {
  assert.deepEqual(parseQualified("A1:B2"), { tab: null, range: "A1:B2" });
  assert.deepEqual(parseQualified("Data!B:B"), { tab: "Data", range: "B:B" });
  assert.deepEqual(parseQualified("'My tab'!A1:B2"), { tab: "My tab", range: "A1:B2" });
  assert.deepEqual(parseQualified("'It''s'!C3"), { tab: "It's", range: "C3" });
  assert.equal(quoteTab("Data"), "Data");
  assert.equal(quoteTab("Sheet_2.x"), "Sheet_2.x");
  assert.equal(quoteTab("My tab"), "'My tab'");
  assert.equal(quoteTab("It's"), "'It''s'");
  assert.equal(quoteTab("A1"), "'A1'", "a name that reads as a cell is quoted");
  assert.equal(quoteTab("2024"), "'2024'");
  assert.equal(quoteTab("true"), "'true'");
  for (const name of ["Data", "My tab", "It's", "Q1-Q2", "A1"]) assert.equal(parseQualified(`${quoteTab(name)}!A1`).tab, name);
});
