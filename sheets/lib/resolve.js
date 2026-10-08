// Which sheet and which tab a tool means: a sheet by id, or by title when exactly one sheet has it; a tab by
// name (any case), its id, or the first tab when none is named. The create answer always gives the id and
// the model keeps it; the title and the tab names are for the person's own words ("the budget, Q3 tab").
import { findTab } from "../ui/core/workbook.js";
import { fail, isSheetId, listSheets, readSheet } from "./store.js";

export async function resolveSheet(env, ref) {
  if (typeof ref !== "string" || !ref.trim()) fail("sheet is required: a sheet id like sh_1a2b3c4d, or a sheet's exact title.");
  const wanted = ref.trim();
  if (isSheetId(wanted)) {
    const workbook = await readSheet(env, wanted);
    if (!workbook) fail(`No sheet ${wanted}. sheet_list shows the ones there are.`);
    return workbook;
  }
  const all = await listSheets(env);
  const matches = all.filter((s) => s.title.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (!matches.length) fail(`No sheet named ${JSON.stringify(wanted)}. sheet_list shows the ones there are; a sheet id like sh_1a2b3c4d works too.`);
  fail(`${matches.length} sheets are named ${JSON.stringify(wanted)}: ${matches.map((s) => s.id).join(", ")}. Name one by its id.`);
}

/** The tab named (or the first), refused with the names there are. */
export function resolveTab(workbook, ref) {
  if (ref === undefined || ref === null || ref === "") return workbook.tabs[0];
  const tab = typeof ref === "string" ? findTab(workbook, ref.trim()) : null;
  if (!tab) fail(`No tab ${JSON.stringify(ref)} in ${JSON.stringify(workbook.title)}; its tabs are ${workbook.tabs.map((t) => JSON.stringify(t.name)).join(", ")}.`);
  return tab;
}
