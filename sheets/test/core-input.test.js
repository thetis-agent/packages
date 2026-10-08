// What typed text becomes, what a tool's JSON value becomes, and what the editor shows — and that the
// editor's text reads back to the same value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { editText, fromValue, parseInput, readNumber } from "../ui/core/input.js";
import { toSerial } from "../ui/core/dates.js";

test("parseInput reads numbers, percentages, currency, dates, times and booleans", () => {
  assert.deepEqual(parseInput(""), { raw: null });
  assert.deepEqual(parseInput("42"), { raw: 42 });
  assert.deepEqual(parseInput("-3.5"), { raw: -3.5 });
  assert.deepEqual(parseInput("1,234,567.25"), { raw: 1234567.25 });
  assert.deepEqual(parseInput("1.5e3"), { raw: 1500 });
  assert.deepEqual(parseInput(".5"), { raw: 0.5 });
  assert.deepEqual(parseInput(" 12 "), { raw: 12 });
  assert.deepEqual(parseInput("12%"), { raw: 0.12, fmt: "0%" });
  assert.deepEqual(parseInput("12.5%"), { raw: 0.125, fmt: "0.0%" });
  assert.deepEqual(parseInput("-7%"), { raw: -0.07, fmt: "0%" });
  assert.deepEqual(parseInput("$1,234.50"), { raw: 1234.5, fmt: "$#,##0.00" });
  assert.deepEqual(parseInput("-$3"), { raw: -3, fmt: "$#,##0.00" });
  assert.deepEqual(parseInput("$-3"), { raw: -3, fmt: "$#,##0.00" });
  assert.deepEqual(parseInput("2026-10-08"), { raw: toSerial(2026, 10, 8), fmt: "yyyy-mm-dd" });
  assert.deepEqual(parseInput("2026-10-08 14:30"), { raw: toSerial(2026, 10, 8, 14, 30), fmt: "yyyy-mm-dd hh:mm" });
  assert.deepEqual(parseInput("2026-10-08 14:30:15"), { raw: toSerial(2026, 10, 8, 14, 30, 15), fmt: "yyyy-mm-dd hh:mm:ss" });
  assert.deepEqual(parseInput("14:30"), { raw: 14.5 / 24, fmt: "hh:mm" });
  assert.deepEqual(parseInput("2:30 PM"), { raw: 14.5 / 24, fmt: "h:mm AM/PM" });
  assert.deepEqual(parseInput("TRUE"), { raw: true });
  assert.deepEqual(parseInput("false"), { raw: false });
});

test("parseInput keeps formulas, apostrophe text and anything else as typed", () => {
  assert.deepEqual(parseInput("=SUM(A1:A3)"), { raw: "=SUM(A1:A3)" });
  assert.deepEqual(parseInput("'0042"), { raw: "'0042" });
  assert.deepEqual(parseInput("hello"), { raw: "hello" });
  assert.deepEqual(parseInput("2026-02-30"), { raw: "2026-02-30" }, "not a real date");
  assert.deepEqual(parseInput("12,34"), { raw: "12,34" }, "not a thousands grouping");
  assert.deepEqual(parseInput("25:00"), { raw: "25:00" });
  assert.deepEqual(parseInput("1.2.3"), { raw: "1.2.3" });
  assert.deepEqual(parseInput("e5"), { raw: "e5" });
  assert.deepEqual(parseInput("Infinity"), { raw: "Infinity" });
});

test("literal keeps strings as text, adding an apostrophe only where needed", () => {
  assert.deepEqual(parseInput("0042", { literal: true }), { raw: "'0042" });
  assert.deepEqual(parseInput("=1+1", { literal: true }), { raw: "'=1+1" });
  assert.deepEqual(parseInput("'quoted", { literal: true }), { raw: "''quoted" });
  assert.deepEqual(parseInput("true", { literal: true }), { raw: "'true" });
  assert.deepEqual(parseInput("2026-10-08", { literal: true }), { raw: "'2026-10-08" });
  assert.deepEqual(parseInput("plain words", { literal: true }), { raw: "plain words" });
});

test("fromValue takes JSON values from tools", () => {
  assert.deepEqual(fromValue(3), { raw: 3 });
  assert.deepEqual(fromValue(true), { raw: true });
  assert.deepEqual(fromValue(null), { raw: null });
  assert.deepEqual(fromValue("12%"), { raw: 0.12, fmt: "0%" });
  assert.deepEqual(fromValue("12%", { literal: true }), { raw: "'12%" });
  assert.throws(() => fromValue({ a: 1 }), /number, a string, a boolean or null/);
  assert.throws(() => fromValue(Infinity), /finite/);
});

test("readNumber is the shared reader for numbers in text", () => {
  assert.equal(readNumber("abc"), null);
  assert.equal(readNumber(""), null);
  assert.deepEqual(readNumber("50%"), { value: 0.5, fmt: "0%" });
});

test("editText shows what parseInput reads back", () => {
  assert.equal(editText(null), "");
  assert.equal(editText("=A1*2"), "=A1*2");
  assert.equal(editText("'0042"), "'0042");
  assert.equal(editText(true), "TRUE");
  assert.equal(editText(1234567.5, { fmt: "#,##0.00" }), "1234567.5");
  assert.equal(editText(0.1 + 0.2), "0.3");
  assert.equal(editText(1e-7), "1E-7");
  assert.equal(editText(0.000001), "0.000001");
  assert.equal(editText(123456789012345), "123456789012345");
  assert.equal(editText(1e15), "1E+15");
  assert.equal(editText(0.125, { fmt: "0.0%" }), "12.5%");
  assert.equal(editText(0.07, { fmt: "0%" }), "7%");
  assert.equal(editText(toSerial(2026, 10, 8), { fmt: "yyyy-mm-dd" }), "2026-10-08");
  assert.equal(editText(toSerial(2026, 10, 8), { fmt: "mmm d, yyyy" }), "2026-10-08");
  assert.equal(editText(toSerial(2026, 10, 8, 14, 30), { fmt: "yyyy-mm-dd hh:mm" }), "2026-10-08 14:30");
  assert.equal(editText(14.5 / 24, { fmt: "hh:mm" }), "14:30");
  assert.equal(editText(toSerial(2026, 10, 8, 9, 5, 7), { fmt: "hh:mm:ss" }), "2026-10-08 09:05:07");
  const cases = [
    [42, null],
    [-3.25, { fmt: "$#,##0.00" }],
    [0.125, { fmt: "0.0%" }],
    [toSerial(2026, 10, 8), { fmt: "yyyy-mm-dd" }],
    [toSerial(2026, 10, 8, 14, 30), { fmt: "yyyy-mm-dd hh:mm" }],
    [14.5 / 24, { fmt: "hh:mm" }],
    [1e-7, null],
    [true, null],
    ["'0042", null],
    ["=SUM(A:A)", null],
  ];
  for (const [raw, style] of cases) assert.deepEqual(parseInput(editText(raw, style)).raw, raw, `${raw} round-trips`);
});
