/* Reading a todo_* tool result back into items. The tool answers the whole rendered plan as text (see
 * lib/plan.js `renderPlan`), and that text is the only thing a transcript keeps of the plan, so the page
 * parses it: one `[mark] id text — note` line per item, a tally line, and any notes before them (the
 * single-active warning). The parsing is forgiving of the blank-line layout, because notes, items and the
 * tally may each be missing, rather than assuming fixed positions. `planLine` is the one quiet transcript
 * line a todo_* call collapses to. */

const STAGE_OF = { " ": "pending", ">": "active", x: "done", "-": "dropped" };
const ITEM_RE = /^\[([ >x-])\]\s+(\S+)\s+(.*)$/;
const TALLY_RE = /^\d+ done · \d+ active · \d+ pending(?: · \d+ dropped)?$/;

/** True for the five plan tools. */
export function isTodoTool(name) {
  return typeof name === "string" && name.startsWith("todo_");
}

/** Reads a todo_* tool result into { items, notes, done, total, allSettled }, or null when the text is not a plan (an error, say). */
export function parsePlan(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const items = [];
  const notes = [];
  let tally = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = ITEM_RE.exec(line);
    if (m) {
      const [, mark, id, rest] = m;
      const cut = rest.indexOf(" — ");
      items.push({ id, stage: STAGE_OF[mark] ?? "pending", text: cut < 0 ? rest : rest.slice(0, cut), note: cut < 0 ? "" : rest.slice(cut + 3) });
    } else if (TALLY_RE.test(line)) tally = true;
    else notes.push(line);
  }
  if (!items.length && !tally) return null;
  return shapePlan(items, notes);
}

/** The one shape the page keeps, whether the items came from a tool result or from the `plan` command. */
export function shapePlan(items, notes = []) {
  const done = items.filter((i) => i.stage === "done").length;
  const total = items.length;
  return { items, notes, done, total, allSettled: total > 0 && items.every((i) => i.stage === "done" || i.stage === "dropped") };
}

/** One line summarizing what a todo_* call did, from its name, its arguments, and the plan it left behind. */
export function planLine(name, args, plan) {
  const tally = `${plan.done} of ${plan.total} done`;
  if (name === "todo_write") return `plan: ${plan.total} items · ${tally}`;
  if (name === "todo_add") return `plan: added ${(args.items || []).length} item(s) · ${tally}`;
  if (name === "todo_mark") return `plan: ${(args.ids || []).join(", ") || "item"} → ${args.stage || "?"} · ${tally}`;
  if (name === "todo_order") return `plan: reordered · ${tally}`;
  return `plan: ${tally}`;
}
