// The commands the package's own page sends, run in the gateway as the person: the list for the sidebar,
// one sheet whole for a tab, the person's edits as ops, create, remove, assign to a project, and the two
// raw verbs, a tab downloaded as CSV or TSV and a CSV or TSV uploaded as a new sheet or tab. Each JSON
// verb answers `{ data }`; a refusal is a thrown Error the gateway answers as `400 { error }`. A save goes
// through `mutate` like a tool's write, so the person's ops land on the workbook as it is now, after
// whatever the agent wrote since the page last read it, and the Change says the person made them.
import { applyOps, emptyWorkbook, findTab } from "../ui/core/workbook.js";
import { isProjectId, projectExists, projectNames } from "./projects.js";
import { cellsOf, createSheet, fail, isSheetId, listSheets, MAX_SHEETS, mutate, newId, readSheet, removeSheet } from "./store.js";
import { importRows } from "./tools.js";
import { delimiterOf, MAX_FILE, parseTable, tabText } from "./transfer.js";
import { workbookXlsx, XLSX_TYPE } from "./xlsx.js";

const MAX_OPS = 1000;

const summary = (s, names) => ({
  id: s.id,
  title: s.title,
  project: s.project,
  projectName: s.project ? names.get(s.project) ?? null : null,
  projectMissing: Boolean(s.project) && !names.has(s.project),
  tabs: s.tabs.length,
  cells: cellsOf(s),
  updatedAt: s.updatedAt,
  rev: s.rev,
});

/** The rows the sidebar and the watcher's snapshot share, with the project names read once. */
export async function summaries(env) {
  const all = await listSheets(env);
  const names = await projectNames(env, all.map((s) => s.project).filter(Boolean));
  return { sheets: all.map((s) => summary(s, names)), projects: [...names].map(([id, name]) => ({ id, name })) };
}

/** One row of the list for a sheet just written. */
export async function summaryOf(env, workbook) {
  return summary(workbook, await projectNames(env, workbook.project ? [workbook.project] : []));
}

const session = (env) => env.session?.id;
const person = (env) => ({ by: "person", session: session(env) });

async function sheetOrFail(env, id) {
  if (!isSheetId(id)) fail("A sheet id looks like sh_1a2b3c4d.");
  const workbook = await readSheet(env, id);
  if (!workbook) fail(`No sheet ${id}.`);
  return workbook;
}

async function checkProject(env, project) {
  if (project === null) return null;
  if (!isProjectId(project)) fail("project must be a project id, or null.");
  if (!(await projectExists(env, project))) fail(`No project ${project}.`);
  return project;
}

/** list: every sheet (or one project's, or the global ones with "none") with its project's name, and every project there is, for the menus. */
export async function uiList(args, env) {
  const { sheets, projects } = await summaries(env);
  const project = args.project;
  const rows = project === undefined || project === null || project === "all" ? sheets : project === "none" ? sheets.filter((s) => !s.project) : sheets.filter((s) => s.project === project);
  return { data: { sheets: rows, projects } };
}

/** get: one sheet's whole workbook. */
export async function uiGet(args, env) {
  return { data: { sheet: await sheetOrFail(env, args.id) } };
}

/**
 * save: the person's ops (`applyOps` ops, in order) applied under the lock to the workbook as it is now.
 * `base` is the revision the page last saw; a different one is applied anyway and answered `merged`, and
 * the page then re-reads. Answers `{ rev, merged? }`.
 */
export async function uiSave(args, env) {
  if (!Array.isArray(args.ops) || !args.ops.length) fail("ops must be a non-empty list of edits.");
  if (args.ops.length > MAX_OPS) fail(`At most ${MAX_OPS} edits in one save; send the rest in another.`);
  await sheetOrFail(env, args.id);
  let found = null;
  const written = await mutate(
    env,
    args.id,
    (workbook) => {
      found = workbook.rev;
      return applyOps(workbook, args.ops);
    },
    person(env),
  );
  return { data: { rev: written.rev, ...(args.base !== undefined && args.base !== found ? { merged: true } : {}) } };
}

/** create: an empty sheet with one tab, in the project the page chose (which must exist) or none. */
export async function uiCreate(args, env) {
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Untitled sheet";
  const project = await checkProject(env, args.project ?? null);
  if ((await listSheets(env)).length >= MAX_SHEETS) fail(`At most ${MAX_SHEETS} sheets; delete one first.`);
  const workbook = emptyWorkbook({ id: newId(), title, project, createdBy: null, now: new Date() });
  const written = await createSheet(env, workbook, person(env));
  return { data: { sheet: await summaryOf(env, written) } };
}

/** remove: the whole sheet. */
export async function uiRemove(args, env) {
  const workbook = await sheetOrFail(env, args.id);
  await removeSheet(env, workbook.id);
  return { data: { removed: workbook.id } };
}

/** assign: the sheet's project, or null for global. */
export async function uiAssign(args, env) {
  await sheetOrFail(env, args.id);
  const project = await checkProject(env, args.project ?? null);
  const written = await mutate(env, args.id, (workbook) => ({ workbook: { ...workbook, project }, ranges: [], what: project ? "moved it to a project" : "made it global" }), person(env));
  return { data: { id: written.id, project: written.project, rev: written.rev } };
}

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 form, so a title in any script survives the download. */
export function dispositionOf(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

const fileName = (text) => text.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "sheet";

/**
 * export (raw GET): one tab as the values the person sees, CSV by default or TSV, with a byte-order mark so
 * a spreadsheet program reads it as UTF-8, named "<title> - <tab>.csv". `format: "json"` serves the whole
 * workbook instead, for a sheet larger than `get` can answer (the gateway caps a JSON answer at 256 KiB).
 * `format: "xlsx"` serves every tab as an Excel workbook with its formulas and formatting, named
 * "<title>.xlsx", the file to open in Google Sheets or Excel.
 */
export async function uiExport(args, env, req) {
  if (req?.method && req.method !== "GET") fail("export is a download: fetch it with GET.");
  const workbook = await sheetOrFail(env, args.id);
  const format = args.format ?? "csv";
  if (format === "json") {
    const body = JSON.stringify(workbook);
    return { headers: { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "content-disposition": dispositionOf(`${fileName(workbook.title)}.json`) }, body };
  }
  if (format === "xlsx") {
    const { body } = workbookXlsx(workbook);
    return { headers: { "content-type": XLSX_TYPE, "content-length": String(body.length), "content-disposition": dispositionOf(`${fileName(workbook.title)}.xlsx`) }, body };
  }
  if (format !== "csv" && format !== "tsv") fail("format is xlsx, csv or tsv.");
  const tab = args.tab === undefined || args.tab === null || args.tab === "" ? workbook.tabs[0] : findTab(workbook, String(args.tab));
  if (!tab) fail(`No tab ${JSON.stringify(args.tab)} in this sheet.`);
  const { text } = tabText(workbook, tab, { delimiter: format === "tsv" ? "\t" : ",", values: "display" });
  const body = Buffer.from(`\ufeff${text}`, "utf8");
  return {
    headers: {
      "content-type": format === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8",
      "content-length": String(body.length),
      "content-disposition": dispositionOf(`${fileName(workbook.title)} - ${fileName(tab.name)}.${format}`),
    },
    body,
  };
}

/**
 * import (raw PUT): the body is CSV or TSV text (the delimiter sniffed, or `format: "csv" | "tsv"`). With
 * `id`, a new tab of that sheet (named `name`, default "Imported"); else a new sheet titled `title` in
 * `project`. Answers `{ sheet, tab, range }` (the gateway puts it under `data`): the sheet id, the tab id,
 * the range filled.
 */
export async function uiImport(args, env, req) {
  if (req?.method && req.method !== "PUT") fail("import is an upload: send the file's text with PUT.");
  const body = req?.body ?? Buffer.alloc(0);
  if (!body.length) fail("The upload is empty.");
  if (body.length > MAX_FILE) fail("That file is larger than 16 MB.");
  const format = args.format;
  if (format !== undefined && format !== "csv" && format !== "tsv") fail("format is csv or tsv.");
  const rows = parseTable(Buffer.from(body).toString("utf8"), { delimiter: format ? delimiterOf(`x.${format}`) : undefined });
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : null;
  let done;
  if (args.id !== undefined && args.id !== null && args.id !== "") {
    const workbook = await sheetOrFail(env, args.id);
    done = await importRows(env, rows, { file: "an upload", base: name ?? "Imported", name, sheet: workbook, ...person(env) });
  } else {
    const project = await checkProject(env, args.project ?? null);
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Imported sheet";
    done = await importRows(env, rows, { file: "an upload", base: name ?? "Sheet1", name, title, project, ...person(env) });
  }
  return { sheet: done.workbook.id, tab: done.tab.id, range: done.range };
}
