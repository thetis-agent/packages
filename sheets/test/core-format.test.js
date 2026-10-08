// Number formats: the presets, General, patterns with thousands, decimals, percent, scientific, literal
// text, sections, dates and times, text sections, and refusing what cannot be read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignOf, formatKind, formatValue, generalNumber, isDateFormat, PRESETS, resolveFormat } from "../ui/core/format.js";
import { toSerial } from "../ui/core/dates.js";

test("General: up to 10 significant digits, no trailing zeros, exponent from 1e11", () => {
  assert.equal(formatValue(0, null), "0");
  assert.equal(formatValue(1234.5, null), "1234.5");
  assert.equal(formatValue(0.1 + 0.2, null), "0.3");
  assert.equal(formatValue(1 / 3, null), "0.3333333333");
  assert.equal(formatValue(-2.5, null), "-2.5");
  assert.equal(formatValue(12345678901, null), "12345678901");
  assert.equal(formatValue(123456789012, null), "1.23457E+11");
  assert.equal(formatValue(1e-10, null), "1E-10");
  assert.equal(formatValue(0.0001, null), "0.0001");
  assert.equal(generalNumber(-1.5e20), "-1.5E+20");
});

test("values that are not numbers: text, booleans, errors and blanks", () => {
  assert.equal(formatValue("hi", "#,##0.00"), "hi");
  assert.equal(formatValue(true, null), "TRUE");
  assert.equal(formatValue(false, "0.00"), "FALSE");
  assert.equal(formatValue({ err: "#DIV/0!" }, null), "#DIV/0!");
  assert.equal(formatValue(null, "0.00"), "");
  assert.equal(formatValue("x", '"Note: "@'), "Note: x");
  assert.equal(formatValue("x", '0.00;-0.00;0;"<"@">"'), "<x>");
});

test("number patterns: grouping, decimals, optional digits, scaling, percent, scientific, literals", () => {
  assert.equal(formatValue(1234567.891, "#,##0.00"), "1,234,567.89");
  assert.equal(formatValue(1234567.891, "#,##0"), "1,234,568");
  assert.equal(formatValue(-1234.5, "#,##0.00"), "-1,234.50");
  assert.equal(formatValue(0.5, "#,##0.00"), "0.50");
  assert.equal(formatValue(0.5, "#.##"), ".5");
  assert.equal(formatValue(5, "#.##"), "5.");
  assert.equal(formatValue(3.1, "0.0#"), "3.1");
  assert.equal(formatValue(3.14159, "0.0#"), "3.14");
  assert.equal(formatValue(7, "000"), "007");
  assert.equal(formatValue(1.005, "0.00"), "1.01", "rounds half away from zero like Sheets");
  assert.equal(formatValue(-0.001, "0.00"), "0.00", "no minus on a value that rounds to zero");
  assert.equal(formatValue(1234567, "#,##0,"), "1,235");
  assert.equal(formatValue(1234567, '0.0,,"M"'), "1.2M");
  assert.equal(formatValue(0.1234, "0.0%"), "12.3%");
  assert.equal(formatValue(0.5, "0%"), "50%");
  assert.equal(formatValue(-0.25, "0.00%"), "-25.00%");
  assert.equal(formatValue(1234.5, "$#,##0.00"), "$1,234.50");
  assert.equal(formatValue(-1234.5, "$#,##0.00"), "-$1,234.50");
  assert.equal(formatValue(12345.678, "0.00E+00"), "1.23E+04");
  assert.equal(formatValue(0.000123, "0.0E+0"), "1.2E-4");
  assert.equal(formatValue(42, '0 "kg"'), "42 kg");
  assert.equal(formatValue(42, "0\\x"), "42x");
  assert.equal(formatValue(5, "(0)"), "(5)");
  assert.equal(formatValue(5551234, "000-0000"), "555-1234");
  assert.equal(formatValue(1.5, "0.0_)"), "1.5 ");
});

test("sections: negatives without a minus, zero, and colours ignored", () => {
  assert.equal(formatValue(-5, "0;(0)"), "(5)");
  assert.equal(formatValue(5, "0;(0)"), "5");
  assert.equal(formatValue(0, '0;(0);"zero"'), "zero");
  assert.equal(formatValue(-1234.5, "#,##0.00;[Red]-#,##0.00"), "-1,234.50");
  assert.equal(formatValue(-3, '$#,##0.00;($#,##0.00);"-"'), "($3.00)");
  assert.equal(formatValue(0, '$#,##0.00;($#,##0.00);"-"'), "-");
});

test("dates and times: tokens, minutes after hours or before seconds, AM/PM, elapsed hours", () => {
  const d = toSerial(2026, 10, 8, 14, 5, 9);
  assert.equal(formatValue(d, "yyyy-mm-dd"), "2026-10-08");
  assert.equal(formatValue(d, "yyyy-mm-dd hh:mm"), "2026-10-08 14:05");
  assert.equal(formatValue(d, "yyyy-mm-dd hh:mm:ss"), "2026-10-08 14:05:09");
  assert.equal(formatValue(d, "d/m/yy"), "8/10/26");
  assert.equal(formatValue(d, "dddd, mmmm d, yyyy"), "Thursday, October 8, 2026");
  assert.equal(formatValue(d, "ddd mmm dd"), "Thu Oct 08");
  assert.equal(formatValue(d, "mmmmm"), "O");
  assert.equal(formatValue(d, "h:mm AM/PM"), "2:05 PM");
  assert.equal(formatValue(toSerial(2026, 10, 8, 0, 30), "h:mm am/pm"), "12:30 am");
  assert.equal(formatValue(d, "h:mm:ss A/P"), "2:05:09 P");
  assert.equal(formatValue(d, "mm:ss"), "05:09", "mm before ss is minutes");
  assert.equal(formatValue(d, "YYYY-MM-DD"), "2026-10-08", "upper case works as in Sheets");
  assert.equal(formatValue(1.5 + 2 / 24, "[h]:mm"), "38:00");
  assert.equal(formatValue(14.5 / 24 + 0.25 / 86400, "hh:mm:ss.00"), "14:30:00.25");
  assert.equal(formatValue(toSerial(2026, 10, 8, 23, 59, 59.7), "yyyy-mm-dd hh:mm:ss"), "2026-10-09 00:00:00", "rounding carries the day");
});

test("PRESETS, resolveFormat and refusals", () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ["general", "number", "integer", "currency", "percent", "date", "datetime", "time", "text"]);
  assert.equal(resolveFormat("currency"), "$#,##0.00");
  assert.equal(resolveFormat("Percent"), "0.00%");
  assert.equal(resolveFormat("general"), null);
  assert.equal(resolveFormat(null), null);
  assert.equal(resolveFormat(""), null);
  assert.equal(resolveFormat("#,##0.00"), "#,##0.00");
  assert.equal(resolveFormat("yyyy-mm-dd"), "yyyy-mm-dd");
  assert.throws(() => resolveFormat("currency2"), /not a number format I can read.*preset/);
  assert.throws(() => resolveFormat("dollars"), /not a number format/);
  assert.throws(() => resolveFormat('0.00 "unclosed'), /quote is not closed/);
  assert.throws(() => resolveFormat("0.00yy"), /mixes date and number/);
  for (const p of PRESETS) assert.equal(resolveFormat(p.id), p.fmt);
  assert.equal(formatValue(1234.5, "@"), "1234.5", "a number under the text format shows as General");
  assert.equal(formatValue(5, "not a format at all"), "5", "an unreadable stored format falls back to General");
});

test("formatKind, isDateFormat and alignOf", () => {
  assert.equal(formatKind(null), "general");
  assert.equal(formatKind("0.0%"), "percent");
  assert.equal(formatKind("$#,##0.00"), "number");
  assert.equal(formatKind("yyyy-mm-dd"), "date");
  assert.equal(formatKind("hh:mm"), "time");
  assert.equal(formatKind("yyyy-mm-dd hh:mm"), "datetime");
  assert.equal(formatKind("@"), "text");
  assert.ok(isDateFormat("mmm d"));
  assert.ok(!isDateFormat("0.00"));
  assert.equal(alignOf(1), "right");
  assert.equal(alignOf("a"), "left");
  assert.equal(alignOf(true), "center");
  assert.equal(alignOf({ err: "#N/A" }), "center");
  assert.equal(alignOf(null), "left");
});
