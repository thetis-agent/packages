// The .xlsx export: a zip whose parts a spreadsheet program reads, every tab with its formulas in Excel's
// spelling and the values computed here, formats and styles deduplicated into styles.xml, widths, heights
// and frozen panes, and the few things that have to change on the way out said in notes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { excelFormula, workbookXlsx, zip } from "../lib/xlsx.js";
import { applyOps, emptyWorkbook } from "../ui/core/workbook.js";
import { unzipText } from "./helpers.js";

const LONG = "A very long tab name that Excel will not take";

function sample() {
  let wb = emptyWorkbook({ id: "sh_00000001", title: "Budget & <co>", tabs: ["Data", LONG], now: "2026-10-09T10:00:00.000Z" });
  ({ workbook: wb } = applyOps(wb, [
    { op: "set", tab: "Data", cells: { A1: "Item", B1: "Cost", A2: "Rent", B2: 1200, B3: 450.5, B4: "=sum(b2:b3)", C2: 46303, D1: "'0042", D2: true, E2: '=IFS(B2>1000,"big",TRUE,"small")', E3: "=1/0", E4: "=SUM(", E5: `='${LONG}'!A1*2`, A6: "  two\nlines" } },
    { op: "style", tab: "Data", range: "A1:B1", style: { b: true, fill: "#ffeeaa", align: "center" } },
    { op: "style", tab: "Data", range: "B2:B4", style: { fmt: "$#,##0.00" } },
    { op: "style", tab: "Data", range: "C2", style: { fmt: "yyyy-mm-dd", wrap: true } },
    { op: "widths", tab: "Data", cols: { A: 180 } },
    { op: "heights", tab: "Data", rows: { "10": 40 } },
    { op: "freeze", tab: "Data", rows: 1, cols: 1 },
    { op: "set", tab: LONG, cells: { A1: 21, B1: "=Data!B4" } },
  ]));
  return wb;
}

test("excelFormula: no =, capitals, _xlfn. where Excel wants it, tab names mapped, engine-only errors replaced, null when it does not parse", () => {
  assert.equal(excelFormula("=sum(a1:b2)+average($c$1:c9)"), "SUM(A1:B2)+AVERAGE($C$1:C9)");
  assert.equal(excelFormula('=xlookup("x",A:A,B:B)&textjoin(",",true,C1:C3)'), '_xlfn.XLOOKUP("x",A:A,B:B)&_xlfn.TEXTJOIN(",",TRUE,C1:C3)');
  assert.equal(excelFormula("=MAXIFS(B:B,A:A,\">1\")+MINIFS(B:B,A:A,1)+IFNA(1,2)"), '_xlfn.MAXIFS(B:B,A:A,">1")+_xlfn.MINIFS(B:B,A:A,1)+_xlfn.IFNA(1,2)');
  assert.equal(excelFormula("='Long name'!a1*Other!B2", new Map([["long name", "Short"]])), "Short!A1*Other!B2");
  assert.equal(excelFormula("=Data!A1", new Map([["data", "My data"]])), "'My data'!A1");
  assert.equal(excelFormula("=IF(A1,#CYCLE!,#ERROR!)"), "IF(A1,#REF!,#VALUE!)");
  assert.equal(excelFormula('=  "a b"  &  A1 '), '  "a b"  &  A1 ', "everything else byte for byte");
  assert.equal(excelFormula("=SUM("), null);
});

test("zip: entries a reader finds through the central directory, deflated, with UTF-8 names", () => {
  const files = unzipText(zip([["a.txt", "hello"], ["dir/é.xml", "<x/>".repeat(100)]]));
  assert.deepEqual([...files.keys()], ["a.txt", "dir/é.xml"]);
  assert.equal(files.get("a.txt"), "hello");
  assert.equal(files.get("dir/é.xml"), "<x/>".repeat(100));
});

test("workbookXlsx: every tab with formulas and cached values, shared strings, styles, widths, heights, freeze; notes say what changed", () => {
  const out = workbookXlsx(sample(), { now: new Date("2026-10-09T10:00:00Z") });
  assert.equal(out.tabs, 2);
  assert.equal(out.formulas, 5, "the one that does not parse is not counted");
  assert.deepEqual(out.notes, [
    `Excel allows tab names of at most 31 characters, so "${LONG}" is "A very long tab name that Excel" in the file, and the formulas pointing at it follow.`,
    "Data!E4 holds a formula that does not parse, written as text.",
  ]);
  const files = unzipText(out.body);
  assert.deepEqual([...files.keys()], ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  const book = files.get("xl/workbook.xml");
  assert.match(book, /<sheet name="Data" sheetId="1" r:id="rId1"\/><sheet name="A very long tab name that Excel" sheetId="2" r:id="rId2"\/>/);
  assert.match(book, /fullCalcOnLoad="1"/);
  assert.match(files.get("docProps/core.xml"), /<dc:title>Budget &amp; &lt;co&gt;<\/dc:title>/);

  const sst = files.get("xl/sharedStrings.xml");
  const strings = [...sst.matchAll(/<si><t[^>]*>([^<]*)<\/t><\/si>/g)].map((m) => m[1]);
  const s = (text) => strings.indexOf(text);
  assert.ok(sst.includes('<t xml:space="preserve">  two\nlines</t>'));

  const sheet = files.get("xl/worksheets/sheet1.xml");
  const cell = (at) => new RegExp(`<c r="${at}"[^>]*?(?:/>|>.*?</c>)`).exec(sheet)?.[0];
  assert.match(cell("A2"), new RegExp(`t="s"><v>${s("Rent")}</v>`));
  assert.match(cell("B2"), /<v>1200<\/v>/);
  assert.match(cell("B4"), /<f>SUM\(B2:B3\)<\/f><v>1650.5<\/v>/);
  assert.match(cell("D1"), /t="s"><v>\d+<\/v>/, "a quoted text is text");
  assert.ok(s("0042") >= 0, "without its apostrophe");
  assert.match(cell("D2"), /t="b"><v>1<\/v>/);
  assert.match(cell("E2"), /t="str"><f>_xlfn.IFS\(B2&gt;1000,&quot;big&quot;,TRUE,&quot;small&quot;\)<\/f><v>big<\/v>/);
  assert.match(cell("E3"), /t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v>/);
  assert.match(cell("E4"), new RegExp(`t="s"><v>${s("=SUM(")}</v>`), "a formula that does not parse is its text");
  assert.match(cell("E5"), /<f>'A very long tab name that Excel'!A1\*2<\/f><v>42<\/v>/);
  assert.match(sheet, /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/);
  assert.match(sheet, /<col min="1" max="1" width="25.71484375" customWidth="1"\/><col min="2" max="26" width="14.28515625" customWidth="1"\/>/);
  assert.match(sheet, /<row r="10" ht="30" customHeight="1"\/>/);
  assert.match(files.get("xl/worksheets/sheet2.xml"), /<f>Data!B4<\/f><v>1650.5<\/v>/);

  const styles = files.get("xl/styles.xml");
  assert.match(styles, /<numFmt numFmtId="164" formatCode="\$#,##0.00"\/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"\/>/);
  assert.match(styles, /<font><b\/><sz val="10"\/><name val="Arial"\/><family val="2"\/><\/font>/);
  assert.match(styles, /<fgColor rgb="FFFFEEAA"\/>/);
  assert.match(styles, /<alignment horizontal="center"\/>/);
  assert.match(styles, /quotePrefix="1"/);
  const xfs = [...styles.matchAll(/<xf numFmtId=/g)].length - 1; // less the cellStyleXfs one
  assert.equal(xfs, 5, "default, header, currency, date, quoted text: B2:B4 share one");
});

test("workbookXlsx: duplicate names after shortening get a number; an empty workbook is still a file", () => {
  let wb = emptyWorkbook({ id: "sh_00000002", title: "x", tabs: [`${"n".repeat(31)} one`, `${"n".repeat(31)} two`] });
  const out = workbookXlsx(wb);
  assert.match(unzipText(out.body).get("xl/workbook.xml"), new RegExp(`<sheet name="${"n".repeat(31)}" sheetId="1"[^>]*/><sheet name="${"n".repeat(29)} 2" sheetId="2"`));
  wb = emptyWorkbook({ id: "sh_00000003", title: "empty" });
  const empty = unzipText(workbookXlsx(wb).body);
  assert.match(empty.get("xl/worksheets/sheet1.xml"), /<dimension ref="A1"\/>.*<sheetData><\/sheetData>/s);
  assert.equal(workbookXlsx(wb).notes.length, 0);
});
