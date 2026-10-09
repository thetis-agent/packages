---
name: sheets
description: How to work on a spreadsheet with the sheet_* tools while the person edits the same sheet in a tab. Use when asked for a spreadsheet, a table to fill in, a budget, a tracker, a model with formulas, or a CSV to clean up, and before changing a sheet that already exists. What a sheet is, how to share it with the person, how values and formulas are written, and the order of work.
metadata:
  title: Sheets
  tags: [sheet, spreadsheet, table, formula, csv, budget, tracker]
  version: 1
---
# Sheets

A sheet is a spreadsheet the person opens from **Sheets** in the sidebar: tabs of cells with formulas, number formats and styles, kept as one file in their home. You change it with the `sheet_*` tools from any conversation; the person edits the same sheet in a tab at the same time, and each of you sees the other's changes within a moment. A sheet belongs to a project or is global; `sheet_create` puts it in this conversation's project unless told otherwise.

Say "sheet", "tab" and "cell" with the person, and A1 addresses (`B4`, `A1:F40`, `B:B`, `3:10`, `'Q3 costs'!A1`).

## Working with the person

The person types into cells, sorts, inserts rows and renames tabs themselves, sometimes while you work. So:

- **Read before writing.** `sheet_read` the sheet before changing one that has existed for more than a moment. Its answer starts with "Recent edits by the person": what they changed and where. Take those as the current truth.
- **Change the cells you were asked to change.** Never rebuild or re-import a sheet the person has edited; write the cells, rows or columns the request is about and leave the rest. Structure changes (`sheet_structure`) keep formulas pointing at the right cells; rewriting a block by hand does not.
- **Mind the warning.** When `sheet_write` says "The person changed B4, C7 in the last 10 minutes; you replaced them", tell the person and ask whether their values should come back, unless they asked for exactly that.

## Keep it a spreadsheet

- **Live formulas, not pasted numbers.** A total is `=SUM(B2:B13)`, a share `=B2/B$14`, a lookup `=XLOOKUP(A2, Rates!A:A, Rates!B:B)`. A number you computed yourself goes stale the moment the person changes an input. Put inputs (rates, assumptions) in their own labelled cells and point formulas at them.
- **Headers in row 1, frozen.** One header row, then one record per row; `sheet_structure` `freeze` with `rows: 1`. Bold the header (`sheet_format` `bold`, a light `fill`).
- **Format numbers.** Currency, percent, date and thousands separators through `sheet_format` `format` (presets `number`, `integer`, `currency`, `percent`, `date`, `datetime`, `time`, `text`, or a pattern like `#,##0.00`, `0.0%`, `yyyy-mm-dd`). Set column widths that fit the content.
- **Check the answer.** `sheet_write` lists each formula it wrote with its result and every error with its message (`#DIV/0!`, `#REF!`, `#NAME?` for an unknown function, `#CYCLE!` for a circular reference), and errors it caused elsewhere. Fix them before you report back.

## Values

What you write is read the way a person's typing is:

- a string starting with `=` is a formula; `'` in front keeps the rest as text (`'0042`, `'=not a formula`);
- numbers, `12%`, `$1,234.50`, `2026-10-08`, `2026-10-08 14:30`, `14:30` and `TRUE`/`FALSE` become numbers, dates and booleans, with a matching format when the cell has none;
- `null` clears a cell; anything else is text;
- `literal: true` stores every string exactly as given — for codes, IDs and imported text that must not turn into numbers.

Formulas use the usual spreadsheet functions, about a hundred of them: SUM, AVERAGE, COUNTIFS, SUMIFS, MAXIFS, SUMPRODUCT, IF, IFS, IFERROR, XLOOKUP, VLOOKUP, INDEX/MATCH, ROUND, TEXT, DATE, EOMONTH, NETWORKDAYS, PMT and the like. An unknown name shows `#NAME?` with "Unknown function …" in `sheet_write`'s answer; rewrite it with functions that exist. References across tabs are `Tab!A1` or `'Tab name'!A1:B9`. Dynamic arrays (FILTER, SORT, UNIQUE, spilling results) and arithmetic on whole ranges (`=SUM(A1:A9*B1:B9)`, use SUMPRODUCT) are not supported: write one formula per cell and fill it down with `sheet_structure` `fill`. CSV and TSV come in with `sheet_import`. `sheet_export` to a `.xlsx` path writes the whole sheet, every tab with its formulas and formatting, for the person to open in Google Sheets or Excel (File > Import in Sheets, or upload it to Drive); to `.csv` or `.tsv` it writes one tab's displayed values, or with `values: "raw"` its formulas. The person can also download the .xlsx from the sheet's ⋯ menu or its row in the sidebar. Importing xlsx is not supported.

## The order of work for a new sheet

1. `sheet_create` with a title, the tabs, and the header row plus any data as `rows` (inputs as values, derived columns as formulas).
2. `sheet_write` more rows with `at` + `rows`; one formula in the first data row, then `sheet_structure` `fill` down the column.
3. `sheet_format`: the header bold with a fill, number formats per column, widths. `sheet_structure` `freeze` the header.
4. `sheet_read` once to see it as the person will, and fix any error.
5. Tell the person where it is ("It's in Sheets in the sidebar"), what the inputs are and what you assumed.

For data that comes as a file, `sheet_import` it as a new sheet or tab, then format it; do not retype it through `sheet_write`.
