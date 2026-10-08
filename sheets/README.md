# @thetis/sheets

Spreadsheets for one person, which the agent and the person edit together. The agent makes and changes a sheet with nine tools from any conversation; the person opens it from **Sheets** in the web gateway's sidebar — above the conversations, under the project switcher — as a tab beside their chats, and there types into cells, writes formulas, formats, sorts, inserts rows, adds tabs and imports or downloads CSV, while the agent may be writing the same sheet. Each sees the other's changes within a moment; the agent's answers say what the person changed lately and which of the person's cells a write replaced. A sheet belongs to a project or is global. The package is a `tool` with a `ui` and a `skills` directory; it has no build step and one dependency, `@thetis/tools-files`, for reading and writing CSV files in the person's space.

## What it provides

The manifest declares `type: "tool"`, `skills: "skills"`, nine `tools`, and a `ui` block with `dir: "ui"`, `entry: "index.js"`, `style: "index.css"`, a sidebar section, a tab kind and nine commands.

| Tool | Arguments | Effect |
|---|---|---|
| `sheet_create` | `title`, `project?`, `tabs?`, `rows?` | A new sheet, its tabs (default one, Sheet1), and optionally a first block of rows from A1 of the first tab. `project` is a project id, `"none"` for global, or omitted for the conversation's own project (from `projects/sessions.json`). Answers the id. |
| `sheet_list` | `project?` | One line per sheet: id, title, tab count, project, last change, revision. |
| `sheet_read` | `sheet`, `tab?`, `range?`, `formulas?`, `styles?` | A header line (id, title, project, revision, each tab with its used range and cell count); the person's edits of the last day (newest first, up to 8); the range (default the used range) as a Markdown table of the values the person sees, with row numbers and column letters; every formula with its result; every error with its message; with `styles`, the formatting as runs, widths and heights. About 40,000 characters at most; a cut answer names the range to read next. |
| `sheet_write` | `sheet`, `tab?`, `cells?`, `at?` + `rows?`, `literal?` | Writes cells by address and/or a block of rows from one cell, parsed as typed (below). Grows the tab when a write lands past its size. Answers the range written, each formula's result, the errors, errors it caused elsewhere, and "The person changed B4, C7 in the last 10 minutes; you replaced them." when it did. |
| `sheet_format` | `sheet`, `tab?`, `range`, `format? bold? italic? underline? strike? color? fill? align? wrap? width? clear?` | Number format (a preset or a pattern), font flags, colours, alignment, wrapping, column widths; null removes one, `clear` all. |
| `sheet_structure` | `sheet`, `action`, … | One of insert_rows, delete_rows, insert_columns, delete_columns, sort, fill, freeze, resize, add_tab, rename_tab, delete_tab, move_tab, rename_sheet. Formulas everywhere follow moved rows, columns and renamed tabs; references into deleted ones become `#REF!`, and the answer lists the cells that started erroring. |
| `sheet_import` | `path`, `sheet?`, `name?`, `title?`, `project?` | A `.csv`, `.tsv` or `.txt` file from the person's space (through `@thetis/tools-files`' containment), at most 16 MB, as a new sheet or a new tab of one. |
| `sheet_export` | `sheet`, `tab?`, `path`, `values?` | One tab to a `.csv` or `.tsv` file in the space: the displayed values, or with `values: "raw"` the formulas and unformatted numbers. |
| `sheet_delete` | `sheet` | The whole sheet. One tab is `sheet_structure` `delete_tab`. |

`sheet` is an id (`sh_` and 8 hexadecimal characters) or a sheet's exact title (any case) when exactly one has it; `tab` a tab's name (any case), default the first. Every answer's first line says what happened and the revision it left; a refusal is a sentence that names the way out.

A value a tool writes is read the way a person's typing is (`ui/core/input.js`): a string starting with `=` is a formula and one starting with `'` is text without the apostrophe; numbers with thousands commas, `12%`, `$1,234.50`, `2026-10-08`, `2026-10-08 14:30`, `14:30` and `TRUE`/`FALSE` become numbers, dates (serial days) and booleans, bringing a format when the cell has none; `null` clears. With `literal`, every string is stored as text exactly as given.

The `skills/sheets` skill carries the policy the tools expect: read before writing, change only the cells asked for, prefer live formulas, headers in row 1 and frozen, formatted numbers, checking the formula results, and the order of work for a new sheet.

| Slot | Id | Notes |
|---|---|---|
| `sidebar` (`slot: "section"`) | `sheets` | The Sheets section, order 21. Its rows are the chosen project's sheets and the global ones; under "All", every sheet with its project as a badge. ＋ makes one in the chosen project. Row menu: Rename, Move to a project, Make global, Download CSV, Delete. |
| `tabs` | `sheet` | A sheet as a tab: toolbar, formula bar, the virtualized grid, the tabs strip, the status strip. |

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `list` | `uiList` | `project?` (`"all"`, `"none"` or an id) | `{ sheets: [{ id, title, project, projectName, projectMissing, tabs, cells, updatedAt, rev }], projects: [{ id, name }] }`. |
| `get` | `uiGet` | `id` | `{ sheet }`: the whole workbook. The gateway caps a JSON answer at 256 KiB; a larger workbook is fetched with `export` and `format: "json"`. |
| `save` | `uiSave` | `id`, `ops`, `base?` | The ops (`applyOps` ops, at most 1000) applied under the lock to the workbook as it is now, logged as the person's; `{ rev, merged? }`, `merged` when `base` was not the revision found. |
| `create` | `uiCreate` | `title?`, `project?` | `{ sheet }`, a list row; the title defaults to "Untitled sheet". |
| `remove` | `uiRemove` | `id` | `{ removed }`. |
| `assign` | `uiAssign` | `id`, `project` (or null) | `{ id, project, rev }`. |
| `export` | `uiExport` | raw GET; `id`, `tab?`, `format?` | One tab's displayed values as `csv` (default) or `tsv`, UTF-8 with a byte-order mark, as an attachment named `<title> - <tab>.csv`; `format: "json"` serves the whole workbook. |
| `import` | `uiImport` | raw PUT, 16 MiB at most; `id?`, `name?`, `title?`, `project?`, `format?` | The body is CSV or TSV text (the delimiter sniffed unless `format`); with `id` a new tab of that sheet (default name "Imported"), else a new sheet (default title "Imported sheet"). `{ sheet, tab, range }`. |
| `watch` | `uiWatch` | stream; `sheet?` | `{ ev: "snapshot", sheets, projects }`, then `{ ev: "changed", sheet, rev, title, project, updatedAt, tabs, cells, by, session? }` (by and session of the last Change) or `{ ev: "removed", sheet }` for every change on disk whoever made it, and `{ ev: "ping" }` after twenty quiet seconds. |

## The files

Everything is under `sheets/<id>/` in the person's home, so a tool in the fence and a command in the gateway read and write the same thing, the Files place shows it, and a person can read it by hand:

- `sheet.json`, the workbook, written pretty: `{ v: 1, id, title, project, createdBy, createdAt, updatedAt, rev, tabs, changes }`. Each tab: `{ id: "t1", name, rows, cols, cells: { A1: raw }, styles: { A1: { b?, i?, u?, s?, color?, fill?, align?, wrap?, fmt? } }, widths: { A: px }, heights: { "3": px }, freeze: { rows, cols } }`. A raw is a number, a boolean or a string; a string starting with `=` is a formula, one starting with `'` is text without the apostrophe; dates are serial days since 1899-12-30 shown through a date format. `changes` keeps the last 40 writes, `{ rev, by: "agent" | "person", session?, at, ranges: [{ tab, range }], what }`, at most 20 ranges each (merged to one bounding box per tab beyond that).
- `.lock/`, a directory that exists while one writer holds the sheet.

Limits: 256 sheets, 32 tabs, 20,000 rows by 702 columns (A..ZZ) per tab, 250,000 non-empty cells per sheet, 32,767 characters per cell and 8,192 per formula, 16 MB per file. Every write is a temporary dot-file renamed into place.

## The lock

Every read-modify-write — a tool's, a page's save, an assign — goes through `mutate` in `lib/store.js`: `mkdir sheets/<id>/.lock` (which only one process wins), read the workbook fresh, apply the change, check it against the rules and limits, bump `rev`, append the Change, write, remove the lock. A writer that finds the lock waits in 20 ms steps for up to five seconds, takes over a lock older than ten (its holder died), and otherwise refuses "The sheet is busy; try again." So when the agent and the person write at the same moment, the second applies its change on top of the first and neither loses cells. A sheet is removed under its lock too, so a waiting writer finds no sheet rather than bringing it back.

## Live sync

The page holds one `watch` subscription. The watcher in the gateway watches `sheets/` and, a moment after a change, reads that sheet again and says its revision and who made the last change. The lock is never a change; a temporary file only makes it look at `sheet.json` again (Node's recursive watch on Linux follows inodes and soon names only the temporary side of a rename), and it speaks only when `sheet.json`'s time or size moved. A tab that sees another writer's revision re-reads with `get`, re-applies the person's unsaved edits on top, and flashes the cells of the agent's change. The person's edits apply at once on the page and go out as `save` ops, coalesced; the answered revision is the page's own echo.

## Projects

`project` in the workbook names a project by its id. The package reads `projects/<id>.json` and `projects/sessions.json` directly, as `@thetis/canvases` does, so it works without `@thetis/projects` (everything is global then). The chosen project is `@thetis/projects`' own, read from `localStorage["thetis.project"]`; a sheet whose project was deleted shows everywhere until it is moved.

## The formula engine

`ui/core/` holds the pure modules both sides share — the server imports them as `../ui/core/x.js`, the page loads them as ES modules: `address.js` (A1 addresses and ranges), `input.js` (typed text to a raw), `format.js` (number, date and text formats), `values.js` (errors and coercions), `formula.js` (the parser and the reference rewriters that keep formulas right when rows, columns and tabs move), `functions.js`, `engine.js` (recompute with memoization and cycle detection), `workbook.js` (the format, its checks and every edit as an op) and `csv.js`.

Supported: numbers, text, booleans, error values; operators `: - + % ^ * / & = <> < > <= >=` with spreadsheet precedence; references `A1`, `$A$1`, ranges, whole columns and rows, other tabs (`Tab!A1`, `'Tab name'!A1:B2`); about a hundred functions — math, statistics, logic, lookup (VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH), text, date and financial (`FUNCTIONS` in `ui/core/functions.js`, each with a one-line signature), with Sheets' criteria in COUNTIF, SUMIFS and the rest. Errors are `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#N/A`, `#NUM!`, `#ERROR!` (a formula that does not parse) and `#CYCLE!` (a circular reference), each with a message. Not in v1: dynamic arrays (FILTER, SORT, UNIQUE, spilling), arithmetic on whole ranges outside SUMPRODUCT, array literals, named ranges, merged cells, charts, conditional formatting, and xlsx — CSV and TSV only.

## Tests

`node --test test/*.test.js`: the shared core (`test/core-*.test.js`); the store (ids, the change log, two writers at once both landing, a stale lock taken over and a live one refused after five seconds, atomic writes leaving no temporary file); the nine tools over a temporary home, with and without project files; the commands, including the raw export and import; the watcher (it leans on inotify); and the sidebar section over the shell's fake DOM. `test/browser.mjs` drives the real page in Chromium against an in-memory home.
