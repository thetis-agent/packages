/* The todo plan: parsing a todo_* tool result into structured items, the card that shows
 * them (Thetis 1's todo.js, ported to this page's tokens), and the chip that opens it.
 *
 * The tool result is the only record of the plan — nothing else remembers it — so parsing
 * has to be forgiving of the exact blank-line layout `renderPlan` uses (notes, then items,
 * then the tally line, any of which may be missing) rather than assuming fixed positions. */

import { el, onClickOutside } from "../lib/dom.js";

const MARK = { pending: "[ ]", active: "[>]", done: "[x]", dropped: "[-]" };
const STAGE_OF = { " ": "pending", ">": "active", x: "done", "-": "dropped" };
const ITEM_RE = /^\[([ >x-])\]\s+(\S+)\s+(.*)$/;
const TALLY_RE = /^\d+ done · \d+ active · \d+ pending(?: · \d+ dropped)?$/;

/** Reads a todo_* tool result (the whole rendered plan as text) into { items, notes, tally }. */
export function parsePlan(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const items = [];
  const notes = [];
  let tallyLine = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = ITEM_RE.exec(line);
    if (m) {
      const [, mark, id, rest] = m;
      const cut = rest.indexOf(" — ");
      items.push({ id, stage: STAGE_OF[mark] ?? "pending", text: cut < 0 ? rest : rest.slice(0, cut), note: cut < 0 ? "" : rest.slice(cut + 3) });
    } else if (TALLY_RE.test(line)) tallyLine = line;
    else notes.push(line);
  }
  if (!items.length && !tallyLine) return null; // not a plan result at all (e.g. an error)
  const done = items.filter((i) => i.stage === "done").length;
  const total = items.length;
  return { items, notes, tallyLine, done, total, allSettled: total > 0 && items.every((i) => i.stage === "done" || i.stage === "dropped") };
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

/** The last todo_* result in a session record, live turn included: the whole plan as of the most recent call. */
export function lastPlanText(record) {
  let text = null;
  for (const message of record.conversation ?? []) if (message.role === "tool" && isTodoTool(message.name)) text = message.content;
  for (const { event } of record.turn?.events ?? []) if (event.type === "tool.result" && isTodoTool(event.name)) text = event.result;
  return text;
}

/** Any todo_* call collapses to one quiet line; the chip and its popover say the rest. */
export function isTodoTool(name) {
  return typeof name === "string" && name.startsWith("todo_");
}

function row(item) {
  const mark = MARK[item.stage] ?? "[ ]";
  return el(
    "div",
    { class: `todo-item is-${item.stage}` },
    el("span", { class: "todo-status mono" }, mark),
    el("div", { class: "todo-copy" },
      el("div", { class: "todo-content" }, item.text),
      item.note ? el("div", { class: "todo-note" }, item.note) : null,
      el("div", { class: "todo-id mono" }, item.id)
    )
  );
}

/** The card's contents: a list of items, the tally, and any notes (e.g. the single-active warning). */
export function planCard(plan) {
  return el(
    "div",
    { class: "plan-card" },
    el("div", { class: "plan-list" }, ...(plan.items.length ? plan.items.map(row) : [el("div", { class: "popover-note" }, "No items yet.")])),
    plan.notes.length ? el("div", { class: "plan-notes" }, ...plan.notes.map((n) => el("div", { class: "plan-note" }, n))) : null,
    plan.tallyLine ? el("div", { class: "plan-tally" }, plan.tallyLine) : null
  );
}

/** Wires the chip's popover: `currentPlan()` answers the plan of the open conversation. drawHeader()
 * writes the label and the `.is-done` colour; the popover follows the confirm()/Picker pattern (fixed
 * position under the anchor, closes on Escape or an outside click). */
export function mountPlanChip(button, currentPlan) {
  let open = null; // { pop, stop } while the popover is shown

  function close() {
    if (!open) return;
    open.stop();
    open.pop.remove();
    document.removeEventListener("keydown", onKey);
    open = null;
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  function show(plan) {
    if (open) return close();
    const pop = el("div", { class: "popover plan-popover", role: "dialog", "aria-label": "Todo plan" }, planCard(plan));
    document.body.append(pop);
    const r = button.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12))}px`;
    const below = r.bottom + 6;
    pop.style.top = `${below + pop.offsetHeight > window.innerHeight - 12 ? Math.max(12, r.top - pop.offsetHeight - 6) : below}px`;
    const stop = onClickOutside(pop, close);
    open = { pop, stop };
    document.addEventListener("keydown", onKey);
  }

  button.addEventListener("click", () => {
    const plan = currentPlan();
    if (plan) show(plan);
  });
  return { close };
}
