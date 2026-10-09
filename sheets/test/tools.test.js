// The nine tools over a temporary home: create in the conversation's project, a named one or none, with a
// first block of rows; list; read with its table, formulas, errors, the person's recent edits, styles and
// the budget's cut; write by address and by block, the parsing of values, growing a tab, and the line that
// says which of the person's cells were replaced; format; every structure action; CSV import and export;
// delete; and how a sheet and a tab are named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sheetCreate, sheetDelete, sheetExport, sheetFormat, sheetImport, sheetList, sheetRead, sheetStructure, sheetWrite } from "../index.js";
import { readSheet } from "../lib/store.js";
import { idIn, makeEnv, personEdit, unzipText } from "./helpers.js";

const PROJECTS = [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }];
const cellsOf = async (env, id, tab = 0) => (await readSheet(env, id)).tabs[tab].cells;

test("create: in the conversation's project by default, in a named one, global with none; tabs and a first block of rows", async () => {
  const { env, done } = await makeEnv({ session: "s_1", projects: PROJECTS, assignments: { s_1: "p_00000001" } });
  const own = await sheetCreate({ title: "Budget" }, env);
  assert.match(own, /^Created sheet sh_[0-9a-f]{8} "Budget", project "Nova" \(p_00000001\) \(this conversation's project\), tabs Sheet1\. The person opens it from Sheets in the sidebar\. rev 1\.$/);
  const record = await readSheet(env, idIn(own));
  assert.equal(record.createdBy, "s_1");
  assert.equal(record.project, "p_00000001");
  assert.equal(record.changes[0].by, "agent");
  assert.equal(record.changes[0].session, "s_1");

  const withRows = await sheetCreate({ title: "Costs", project: "none", tabs: ["Q3", "Q4"], rows: [["Item", "Cost"], ["Rent", 1200], ["Food", "$350.50"], ["Total", "=SUM(B2:B3)"]] }, env);
  assert.match(withRows, /^Created sheet sh_[0-9a-f]{8} "Costs", global, tabs Q3, Q4\. .* rev 1\.\nWrote 8 cells in 'Q3'!A1:B4\.\nFormulas:\nB4 =SUM\(B2:B3\) → 1550\.5$/);
  const costs = await readSheet(env, idIn(withRows));
  assert.deepEqual(costs.tabs.map((t) => t.name), ["Q3", "Q4"]);
  assert.equal(costs.tabs[0].cells.B3, 350.5);
  assert.equal(costs.tabs[0].styles.B3.fmt, "$#,##0.00", "a currency typed brings its format");
  assert.deepEqual(costs.changes[0].ranges, [{ tab: "t1", range: "A1:B4" }]);

  assert.match(await sheetCreate({ title: "Other", project: "p_00000002" }, env), /project "Orion" \(p_00000002\), tabs/);
  await assert.rejects(sheetCreate({ title: "x", project: "p_00000009" }, env), /No project p_00000009/);
  await assert.rejects(sheetCreate({ title: "x", project: "nova" }, env), /not a project id/);
  await assert.rejects(sheetCreate({}, env), /title is required/);
  await assert.rejects(sheetCreate({ title: "x", tabs: [] }, env), /tabs must be a list of tab names/);

  const list = await sheetList({}, env);
  assert.equal(list.split("\n").length, 3);
  assert.match(list, /^sh_[0-9a-f]{8} "Budget" · 1 tab · project "Nova" \(p_00000001\) · updated just now · rev 1$/m);
  assert.match(list, /"Costs" · 2 tabs · global · updated just now · rev 1/);
  assert.equal((await sheetList({ project: "none" }, env)).split("\n").length, 1);
  assert.equal((await sheetList({ project: "p_00000002" }, env)).split("\n").length, 1);
  await assert.rejects(sheetList({ project: "x" }, env), /not a project id/);
  await done();
});

test("a conversation without a project, or without the projects package at all, makes a global sheet; an empty list says how to start", async () => {
  const { env, done } = await makeEnv({ session: "s_9" });
  assert.equal(await sheetList({}, env), "No sheets yet. sheet_create makes one.");
  assert.match(await sheetCreate({ title: "Alone" }, env), /"Alone", global, tabs Sheet1\./);
  await done();
});

test("read: the header with the tabs, the table of values the person sees, the formulas with their results, the errors", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Budget", tabs: ["Costs", "Empty tab"], rows: [["Item", "Cost"], ["Rent", 1200], ["Food | drink", 350], ["Total", "=SUM(B2:B3)"], ["Ratio", "=B2/0"], ["Note", "line one\nline two"]] }, env));
  await sheetFormat({ sheet: id, range: "B2:B4", format: "#,##0" }, env);
  const out = await sheetRead({ sheet: "budget" }, env);
  const lines = out.split("\n");
  assert.equal(lines[0], `Sheet ${id} "Budget" · global · rev 2 · tabs: Costs (A1:B6, 12 cells), Empty tab (empty)`);
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Costs!A1:B6:");
  assert.equal(lines[3], "|  | A | B |");
  assert.equal(lines[4], "|---|---|---|");
  assert.equal(lines[5], "| 1 | Item | Cost |");
  assert.equal(lines[6], "| 2 | Rent | 1,200 |");
  assert.equal(lines[7], "| 3 | Food \\| drink | 350 |");
  assert.equal(lines[8], "| 4 | Total | 1,550 |");
  assert.equal(lines[9], "| 5 | Ratio | #DIV/0! |");
  assert.equal(lines[10], "| 6 | Note | line one⏎line two |");
  assert.match(out, /\nFormulas:\nB4 =SUM\(B2:B3\) → 1,550\nB5 =B2\/0 → #DIV\/0!\n/);
  assert.match(out, /\nErrors:\nB5 #DIV\/0!/);
  assert.doesNotMatch(out, /Recent edits by the person/);
  assert.doesNotMatch(out, /Formatting:/);

  const noFormulas = await sheetRead({ sheet: id, formulas: false }, env);
  assert.doesNotMatch(noFormulas, /Formulas:/);
  assert.match(noFormulas, /Errors:/);

  const part = await sheetRead({ sheet: id, range: "B:B" }, env);
  assert.match(part, /\nCosts!B1:B6:\n\|  \| B \|\n/);
  const qualified = await sheetRead({ sheet: id, range: "Costs!A4:B4" }, env);
  assert.match(qualified, /\nCosts!A4:B4:\n\|  \| A \| B \|\n\|---\|---\|---\|\n\| 4 \| Total \| 1,550 \|\n/);
  assert.match(await sheetRead({ sheet: id, tab: "empty TAB" }, env), /\nEmpty tab is empty \(1,000 rows × 26 columns\)\.$/);
  assert.match(await sheetRead({ sheet: id, range: "H20:J30" }, env), /Costs!H20:J30 is empty; Costs holds A1:B6\./);
  await assert.rejects(sheetRead({ sheet: id, tab: "Nope" }, env), /No tab "Nope" in "Budget"; its tabs are "Costs", "Empty tab"\./);
  await assert.rejects(sheetRead({ sheet: id, range: "A1:" }, env), /not a range in A1 notation/);
  await assert.rejects(sheetRead({ sheet: "sh_00000000" }, env), /No sheet sh_00000000\. sheet_list/);
  await assert.rejects(sheetRead({ sheet: "Nope" }, env), /No sheet named "Nope"/);
  await sheetCreate({ title: "BUDGET" }, env);
  await assert.rejects(sheetRead({ sheet: "Budget" }, env), /2 sheets are named "Budget": .* Name one by its id\./);
  await done();
});

test("read: the person's recent edits, newest first, and the formatting on request", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Plan", rows: [["a", "b"], [1, 2]] }, env));
  await personEdit(env, id, { A2: 5 }, { minutesAgo: 30 });
  await personEdit(env, id, { B2: 7, B3: 8 }, { minutesAgo: 4 });
  await personEdit(env, id, { A1: "old" }, { minutesAgo: 60 * 25 });
  await sheetFormat({ sheet: id, range: "A1:B1", bold: true, fill: "#EEE" }, env);
  await sheetFormat({ sheet: id, range: "A:A", width: 140 }, env);
  const out = await sheetRead({ sheet: id, styles: true }, env);
  const recent = out.split("\n\n")[1].split("\n");
  assert.equal(recent[0], "Recent edits by the person:");
  assert.match(recent[1], /^- 4 min ago: Sheet1!B2(:B3|, Sheet1!B3) — .+ \(rev 3\)$/);
  assert.match(recent[2], /^- 30 min ago: Sheet1!A2 — .+ \(rev 2\)$/);
  assert.equal(recent.length, 3, "an edit older than a day is not listed");
  assert.match(out, /\nFormatting:\nA1:B1 bold, fill #eeeeee\nColumn widths: A 140 \(others 100 px\)\./);
  await done();
});

test("read: a range too large for the budget is cut, and the answer names the range to read next", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Big" }, env));
  const rows = Array.from({ length: 1500 }, (_, i) => [`row ${i + 1} ${"x".repeat(20)}`, i, `=B${i + 1}*2`]);
  await sheetWrite({ sheet: id, at: "A1", rows }, env);
  const out = await sheetRead({ sheet: id }, env);
  assert.ok(out.length <= 41_000, `the answer is ${out.length} characters`);
  const cut = /Rows 1–(\d+) of 1–1500 shown; read range A(\d+):C1500 next\./.exec(out);
  assert.ok(cut, "the cut is said");
  assert.equal(Number(cut[2]), Number(cut[1]) + 1);
  assert.match(out, /…and [\d,]+ more formulas; read a smaller range to see them\.|Formulas:/);
  const next = await sheetRead({ sheet: id, range: `A${cut[2]}:C1500` }, env);
  assert.match(next, new RegExp(`\\n\\| ${cut[2]} \\| row ${cut[2]} `));
  await done();
});

test("write: cells by address and a block, values parsed as typed, literal text, clearing, and the answer's formulas and errors", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "W" }, env));
  const out = await sheetWrite({ sheet: id, cells: { b4: 12, C4: "=B4*2", D4: "12%", E4: "2026-10-08", F4: "true", G4: "'0042", H4: "=1/0" } }, env);
  assert.match(out, /^Wrote 7 cells in Sheet1!B4:H4 of sh_[0-9a-f]{8} "W"\. rev 2\.\nFormulas:\nC4 =B4\*2 → 24\nH4 =1\/0 → #DIV\/0!\nErrors:\nH4 #DIV\/0!/);
  let cells = await cellsOf(env, id);
  assert.equal(cells.B4, 12);
  assert.equal(cells.D4, 0.12);
  assert.equal(typeof cells.E4, "number");
  assert.equal(cells.F4, true);
  assert.equal(cells.G4, "'0042");
  const wb = await readSheet(env, id);
  assert.equal(wb.tabs[0].styles.D4.fmt, "0%");
  assert.equal(wb.tabs[0].styles.E4.fmt, "yyyy-mm-dd");
  assert.deepEqual(wb.changes.at(-1).what, "wrote 7 cells");

  const literal = await sheetWrite({ sheet: id, at: "A1", rows: [["=not a formula", "12", "plain"]], literal: true }, env);
  assert.match(literal, /^Wrote 3 cells in Sheet1!A1:C1 .* rev 3\.$/);
  cells = await cellsOf(env, id);
  assert.equal(cells.A1, "'=not a formula");
  assert.equal(cells.B1, "'12");
  assert.equal(cells.C1, "plain");

  await sheetWrite({ sheet: id, cells: { B4: null, A1: null } }, env);
  cells = await cellsOf(env, id);
  assert.ok(!("B4" in cells) && !("A1" in cells));
  assert.equal((await readSheet(env, id)).changes.at(-1).what, "cleared 2 cells");
  assert.match(await sheetRead({ sheet: id, range: "C4" }, env), /C4 =B4\*2 → 0/);

  await assert.rejects(sheetWrite({ sheet: id }, env), /Nothing to write/);
  await assert.rejects(sheetWrite({ sheet: id, at: "A1" }, env), /A block needs both at/);
  await assert.rejects(sheetWrite({ sheet: id, cells: { "4B": 1 } }, env), /"4B" is not a cell address/);
  await assert.rejects(sheetWrite({ sheet: id, cells: { A1: { x: 1 } } }, env), /A1: a value is a number, a boolean, null or a string/);
  await assert.rejects(sheetWrite({ sheet: id, cells: { A1: Infinity } }, env), /A1: a value is a number/);
  await assert.rejects(sheetWrite({ sheet: id, at: "A1", rows: [1, 2] }, env), /rows\[0\] must be an array/);
  await assert.rejects(sheetWrite({ sheet: id, cells: { A20001: 1 } }, env), /not a cell address like B4 on the grid, which reaches ZZ20000/);
  await done();
});

test("write: a write past the tab's size grows it; new errors elsewhere are said", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Grow", rows: [[1, "=A1*2"]] }, env));
  const out = await sheetWrite({ sheet: id, cells: { A1: "word", AB1200: 5 } }, env);
  assert.match(out, /\nSheet1 grew to 1,200 rows × 28 columns to hold them\./);
  assert.match(out, /\nNow erroring elsewhere:\nSheet1!B1 #VALUE!/);
  const tab = (await readSheet(env, id)).tabs[0];
  assert.equal(tab.rows, 1200);
  assert.equal(tab.cols, 28);
  await done();
});

test("write: the cells the person changed in the last ten minutes and the agent replaced are named", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Shared", rows: [["a", "b", "c"], [1, 2, 3]] }, env));
  await personEdit(env, id, { B4: 40, C7: 70, D9: 9 }, { minutesAgo: 3 });
  await personEdit(env, id, { A1: "old" }, { minutesAgo: 30 });
  const out = await sheetWrite({ sheet: id, cells: { B4: 41, C7: 71, D9: 9, A1: "new", A2: 100 } }, env);
  assert.match(out, /\nThe person changed B4, C7 in the last 10 minutes; you replaced them\.$/);
  const quiet = await sheetWrite({ sheet: id, cells: { E1: 1 } }, env);
  assert.doesNotMatch(quiet, /The person changed/);
  await done();
});

test("format: number formats, flags, colours, alignment, widths, clearing; refusals name the way out", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "F", rows: [["Item", "Cost"], ["Rent", 1200.5]] }, env));
  assert.match(await sheetFormat({ sheet: id, range: "A1:B1", bold: true, fill: "#F0F0F0", align: "center" }, env), /^Formatted Sheet1!A1:B1: bold, fill #f0f0f0, align center\. rev 2\.$/);
  assert.match(await sheetFormat({ sheet: id, range: "B2", format: "currency" }, env), /^Formatted Sheet1!B2: format "\$#,##0\.00"\. rev 3\.$/);
  assert.match(await sheetRead({ sheet: id }, env), /\| 2 \| Rent \| \$1,200\.50 \|/);
  assert.match(await sheetFormat({ sheet: id, range: "B:B", width: 160 }, env), /^Formatted Sheet1!B1:B1000: width 160 px\. rev 4\.$/);
  let tab = (await readSheet(env, id)).tabs[0];
  assert.equal(tab.widths.B, 160);
  assert.deepEqual(tab.styles.A1, { b: true, fill: "#f0f0f0", align: "center" });
  assert.match(await sheetFormat({ sheet: id, range: "A1", bold: false, fill: null }, env), /removed bold, fill/);
  tab = (await readSheet(env, id)).tabs[0];
  assert.deepEqual(tab.styles.A1, { align: "center" });
  assert.match(await sheetFormat({ sheet: id, range: "A1:B2", clear: true }, env), /cleared the formatting/);
  tab = (await readSheet(env, id)).tabs[0];
  assert.equal(tab.styles.A1, undefined);
  assert.equal(tab.styles.B2, undefined);
  await assert.rejects(sheetFormat({ sheet: id, range: "A1" }, env), /Nothing to format/);
  await assert.rejects(sheetFormat({ sheet: id, range: "A1", color: "red" }, env), /color is a colour like #1a73e8/);
  await assert.rejects(sheetFormat({ sheet: id, range: "A1", width: 5 }, env), /width is a whole number of pixels from 20 to 1000/);
  await assert.rejects(sheetFormat({ sheet: id, range: "A1", format: "fancy" }, env), /./);
  await assert.rejects(sheetFormat({ sheet: id, range: "AA1", bold: true }, env), /outside Sheet1, which is 1,000 rows by 26 columns \(A\.\.Z\); grow it with sheet_structure resize first/);
  await assert.rejects(sheetFormat({ sheet: id, bold: true }, env), /range is required/);
  await done();
});

test("structure: rows and columns in and out with formulas following, sort, fill, freeze, resize, the tabs and the title", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "S", rows: [["Name", "Score"], ["b", 2], ["a", 3], ["c", 1], ["Total", "=SUM(B2:B4)"]] }, env));
  assert.match(await sheetStructure({ sheet: id, action: "insert_rows", at: "3", count: 2 }, env), /^Inserted 2 rows before row 3 in Sheet1\. rev 2\.$/);
  let cells = await cellsOf(env, id);
  assert.equal(cells.B7, "=SUM(B2:B6)");
  assert.equal(cells.A5, "a");
  assert.match(await sheetStructure({ sheet: id, action: "delete_rows", at: 3, count: 2 }, env), /^Deleted rows 3–4 of Sheet1\. rev 3\.$/);
  cells = await cellsOf(env, id);
  assert.equal(cells.B5, "=SUM(B2:B4)");
  assert.match(await sheetStructure({ sheet: id, action: "insert_columns", at: "A" }, env), /^Inserted 1 column before A in Sheet1\. rev 4\.$/);
  assert.equal((await cellsOf(env, id)).C5, "=SUM(C2:C4)");
  assert.match(await sheetStructure({ sheet: id, action: "delete_columns", at: "a" }, env), /^Deleted column A of Sheet1\. rev 5\.$/);

  assert.match(await sheetStructure({ sheet: id, action: "sort", range: "A1:B4", by: "B", header: true, descending: true }, env), /^Sorted Sheet1!A1:B4 by column B, descending \(the header row kept in place\)\. rev 6\.$/);
  cells = await cellsOf(env, id);
  assert.deepEqual([cells.A1, cells.A2, cells.A3, cells.A4], ["Name", "a", "b", "c"]);

  await sheetWrite({ sheet: id, cells: { C2: "=B2*10" } }, env);
  assert.match(await sheetStructure({ sheet: id, action: "fill", from: "C2", to: "C2:C4" }, env), /^Filled Sheet1!C2:C4 from C2\. rev 8\.$/);
  cells = await cellsOf(env, id);
  assert.equal(cells.C4, "=B4*10");

  assert.match(await sheetStructure({ sheet: id, action: "freeze", rows: 1 }, env), /^Froze 1 row and 0 columns of Sheet1\. rev 9\.$/);
  assert.deepEqual((await readSheet(env, id)).tabs[0].freeze, { rows: 1, cols: 0 });
  assert.match(await sheetStructure({ sheet: id, action: "resize", rows: 50, columns: 5 }, env), /^Sheet1 is now 50 rows × 5 columns \(A\.\.E\)\. rev 10\.$/);
  await assert.rejects(sheetStructure({ sheet: id, action: "resize", rows: 2 }, env), /./, "shrinking past a value is refused");

  assert.match(await sheetStructure({ sheet: id, action: "add_tab", name: "Notes", position: 1 }, env), /^Added tab "Notes" at position 1\. rev 11\.$/);
  assert.deepEqual((await readSheet(env, id)).tabs.map((t) => t.name), ["Notes", "Sheet1"]);
  await sheetWrite({ sheet: id, tab: "Notes", cells: { A1: "=Sheet1!B2" } }, env);
  assert.match(await sheetStructure({ sheet: id, action: "rename_tab", tab: "Sheet1", name: "Scores" }, env), /^Renamed tab "Sheet1" to "Scores"; formulas follow\. rev 13\.$/);
  assert.equal((await cellsOf(env, id, 0)).A1, "=Scores!B2");
  assert.match(await sheetStructure({ sheet: id, action: "move_tab", tab: "Notes", position: 2 }, env), /^Moved tab "Notes" to position 2\. rev 14\.$/);
  const gone = await sheetStructure({ sheet: id, action: "delete_tab", tab: "Scores" }, env);
  assert.match(gone, /^Deleted tab "Scores" \(\d+ cells\)\. rev 15\.\nNow erroring:\nNotes!A1 #REF!/);
  await assert.rejects(sheetStructure({ sheet: id, action: "delete_tab", tab: "Notes" }, env), /./, "the last tab stays");
  assert.match(await sheetStructure({ sheet: id, action: "rename_sheet", title: "Scores 2026" }, env), /^Renamed the sheet to "Scores 2026"\. rev 16\.$/);
  assert.equal((await readSheet(env, id)).title, "Scores 2026");

  await assert.rejects(sheetStructure({ sheet: id, action: "explode" }, env), /action is one of insert_rows/);
  await assert.rejects(sheetStructure({ sheet: id, action: "insert_rows" }, env), /insert_rows needs at: the row number/);
  await assert.rejects(sheetStructure({ sheet: id, action: "insert_columns", at: "3" }, env), /insert_columns needs at: the column letter/);
  await assert.rejects(sheetStructure({ sheet: id, action: "sort" }, env), /sort needs by/);
  await assert.rejects(sheetStructure({ sheet: id, action: "move_tab", position: 9 }, env), /position is a whole number from 1 to 1/);
  await done();
});

test("import: a CSV as a new sheet, a TSV as a new tab, values parsed; export: display or raw, CSV or TSV, or the whole workbook as xlsx", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS, assignments: { s_1: "p_00000001" } });
  await env.writeFile("data/costs.csv", "Item,Cost,Share\r\nRent,\"$1,200.00\",50%\r\nFood,350,25%\r\n\"Odd, item\",=B2+B3,\n");
  const made = await sheetImport({ path: "data/costs.csv" }, env);
  assert.match(made, /^Imported data\/costs\.csv into new sheet sh_[0-9a-f]{8} "costs", project "Nova" \(p_00000001\) \(this conversation's project\): costs!A1:C4, 11 cells\. rev 1\.$/);
  const id = idIn(made);
  let wb = await readSheet(env, id);
  assert.equal(wb.tabs[0].name, "costs");
  assert.equal(wb.tabs[0].cells.B2, 1200);
  assert.equal(wb.tabs[0].cells.C3, 0.25);
  assert.equal(wb.tabs[0].cells.A4, "Odd, item");
  assert.equal(wb.tabs[0].cells.B4, "=B2+B3");

  await env.writeFile("data/more.tsv", "a\tb\n1\t2\n");
  const tab = await sheetImport({ path: "data/more.tsv", sheet: id }, env);
  assert.match(tab, /^Imported data\/more\.tsv into sheet sh_[0-9a-f]{8} "costs" as a new tab: more!A1:B2, 4 cells\. rev 2\.$/);
  await sheetImport({ path: "data/more.tsv", sheet: id }, env);
  wb = await readSheet(env, id);
  assert.deepEqual(wb.tabs.map((t) => t.name), ["costs", "more", "more 2"]);
  await assert.rejects(sheetImport({ path: "data/more.tsv", sheet: id, name: "MORE" }, env), /already has a tab named "MORE"/);
  await assert.rejects(sheetImport({ path: "data/none.csv" }, env), /does not exist/);
  await env.writeFile("data/x.json", "{}");
  await assert.rejects(sheetImport({ path: "data/x.json" }, env), /not a \.csv, \.tsv or \.txt file/);
  await assert.rejects(sheetImport({ path: "../../etc/passwd.csv" }, env), /outside the spaces/);

  const out = await sheetExport({ sheet: id, path: "out/costs.csv" }, env);
  assert.match(out, /^Exported costs of sh_[0-9a-f]{8} "costs" \(A1:C4, the values the person sees\) to out\/costs\.csv, \d+ bytes\. The sheet is unchanged at rev 3\.$/);
  const csv = readFileSync(resolve(env.cwd, "out/costs.csv"), "utf8");
  assert.equal(csv.split("\r\n")[1], "Rent,\"$1,200.00\",50%");
  assert.equal(csv.split("\r\n")[3], "\"Odd, item\",1550,");
  await sheetExport({ sheet: id, path: "out/raw.tsv", values: "raw" }, env);
  const tsv = readFileSync(resolve(env.cwd, "out/raw.tsv"), "utf8");
  assert.equal(tsv.split("\r\n")[1], "Rent\t1200\t0.5");
  assert.equal(tsv.split("\r\n")[3], "Odd, item\t=B2+B3\t");
  const book = await sheetExport({ sheet: id, path: "out/costs.xlsx" }, env);
  assert.match(book, /^Exported every tab of sh_[0-9a-f]{8} "costs" \(3 tabs, \d+ cells, 1 formula\) to out\/costs\.xlsx, \d+ KB: formulas with their values, .*Google Sheets opens it .* The sheet is unchanged at rev 3\.$/);
  const parts = unzipText(readFileSync(resolve(env.cwd, "out/costs.xlsx")));
  assert.match(parts.get("xl/worksheets/sheet1.xml"), /<f>B2\+B3<\/f><v>1550<\/v>/);
  await assert.rejects(sheetExport({ sheet: id, path: "out/x.xls" }, env), /must end in \.xlsx, \.csv or \.tsv/);
  await assert.rejects(sheetExport({ sheet: id, path: "out/x.csv", values: "pretty" }, env), /values is "display"/);
  await done();
});

test("delete: the whole sheet goes with its directory", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await sheetCreate({ title: "Gone", tabs: ["A", "B"], rows: [[1, 2]] }, env));
  assert.equal(await sheetDelete({ sheet: "Gone" }, env), `Deleted sheet ${id} "Gone" (2 tabs, 2 cells).`);
  assert.ok(!existsSync(resolve(env.cwd, "sheets", id)));
  await assert.rejects(sheetDelete({ sheet: id }, env), /No sheet/);
  await done();
});
