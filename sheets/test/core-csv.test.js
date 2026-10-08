// CSV and TSV: quotes, embedded delimiters and line ends, CRLF, a BOM, sniffing, and the way back out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelimited, toDelimited } from "../ui/core/csv.js";

test("parseDelimited reads RFC 4180 quoting and both line ends", () => {
  assert.deepEqual(parseDelimited('a,b,c\r\n1,"two, three","say ""hi"""\n"multi\nline",,x\n'), [
    ["a", "b", "c"],
    ["1", "two, three", 'say "hi"'],
    ["multi\nline", "", "x"],
  ]);
  assert.deepEqual(parseDelimited(""), []);
  assert.deepEqual(parseDelimited("only"), [["only"]]);
  assert.deepEqual(parseDelimited("a,b\n\nc,d"), [["a", "b"], [""], ["c", "d"]], "a blank line is a row with one empty field");
  assert.deepEqual(parseDelimited('"",x'), [["", "x"]]);
});

test("a BOM is dropped and the delimiter is sniffed", () => {
  assert.deepEqual(parseDelimited("﻿name,age\nAda,36"), [["name", "age"], ["Ada", "36"]]);
  assert.deepEqual(parseDelimited("name\tage\nAda\t36\n"), [["name", "age"], ["Ada", "36"]]);
  assert.deepEqual(parseDelimited("name;price\nTea;3,50\n"), [["name", "price"], ["Tea", "3,50"]]);
  assert.deepEqual(parseDelimited("a,b\tc\n", { delimiter: "\t" }), [["a,b", "c"]]);
});

test("toDelimited quotes where needed and ends lines with CRLF; it round-trips", () => {
  const rows = [["a", "b, c", 'q"x'], [1, null, "two\nlines"], [true, "", " sp "]];
  const text = toDelimited(rows, ",");
  assert.equal(text, 'a,"b, c","q""x"\r\n1,,"two\nlines"\r\nTRUE,, sp \r\n'.replace("TRUE", "true"));
  assert.deepEqual(parseDelimited(text), rows.map((r) => r.map((v) => (v === null ? "" : String(v)))));
  assert.equal(toDelimited([["a\tb", "c"]], "\t"), '"a\tb"\tc\r\n');
});
