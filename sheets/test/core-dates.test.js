// Date serials as Sheets and Excel count them from 1899-12-30, the calendar parts back, and today/now read
// from a given clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { daysInMonth, fromSerial, nowSerial, toSerial, todaySerial, validDate } from "../ui/core/dates.js";

test("toSerial matches the spreadsheet epoch", () => {
  assert.equal(toSerial(1899, 12, 30), 0);
  assert.equal(toSerial(1900, 1, 1), 2);
  assert.equal(toSerial(1900, 3, 1), 61);
  assert.equal(toSerial(2000, 1, 1), 36526);
  assert.equal(toSerial(2026, 10, 8), 46303);
  assert.equal(toSerial(2026, 10, 8, 12), 46303.5);
  assert.equal(toSerial(2026, 13, 1), toSerial(2027, 1, 1), "months roll over");
  assert.equal(toSerial(2026, 3, 0), toSerial(2026, 2, 28), "day 0 is the last of the month before");
});

test("fromSerial gives the parts back, rounded to the second, with the weekday", () => {
  assert.deepEqual(fromSerial(46303), { y: 2026, m: 10, d: 8, h: 0, mi: 0, s: 0, weekday: 4 });
  assert.deepEqual(fromSerial(46303.75), { y: 2026, m: 10, d: 8, h: 18, mi: 0, s: 0, weekday: 4 });
  const p = fromSerial(toSerial(2024, 2, 29, 23, 59, 59.6));
  assert.deepEqual([p.y, p.m, p.d, p.h, p.mi, p.s], [2024, 3, 1, 0, 0, 0], "rounding to the second carries into the next day");
  assert.deepEqual(fromSerial(0).y, 1899);
  assert.equal(fromSerial(-1).d, 29);
});

test("todaySerial and nowSerial read the local calendar of the clock given", () => {
  const now = new Date(2026, 9, 8, 15, 30, 0);
  assert.equal(todaySerial(now), 46303);
  assert.ok(Math.abs(nowSerial(now) - (46303 + 15.5 / 24)) < 1e-9);
});

test("daysInMonth and validDate know leap years", () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2026, 12), 31);
  assert.ok(validDate(2024, 2, 29));
  assert.ok(!validDate(2026, 2, 29));
  assert.ok(!validDate(2026, 13, 1));
});
