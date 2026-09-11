/* The Todo panel: the plan the agent is working to, and the one a person can change.
 *
 * Every other inspector in this surface is a reader — it folds frames the surface already received and
 * shows what it found. This one cannot be, for two reasons. A plan is not on the wire: the tool calls
 * that built it are, but replaying four verbs to reconstruct a list is a second implementation of the
 * list, kept in a browser, that drifts the first time a call is spilled or a tab is opened late. And a
 * plan is the one thing in a conversation a person legitimately edits — they know a line is already
 * done — so the panel has to be able to say so.
 *
 * Both go through the two verbs this package declared in its own manifest: `plan` reads the list and
 * `tick` changes one line. The host checks both against that list, against the signed-in role and
 * against the conversation on screen before anything is forwarded (ADR 0051).
 */

import { registerPanel, onEvent, conversation, request, el, icon } from "/lib/surface.js";

/** A checklist: a page with two lines ruled on it and a tick over the second. */
const LIST = ["M5.5 3.5h9v13h-9z", "M8 8h4.5", "M7.6 12.2l1.3 1.3 2.6-2.8"];

/** The names this package's own tools go by on the wire, so a `tool-result` that changed the plan can
 *  trigger a read and nothing else can. A frame for somebody else's tool is not this panel's news. */
const TOOLS = new Set(["todo_write", "todo_add", "todo_mark", "todo_order"]);

/** The last plan read, per conversation, so switching tabs draws that tab's own plan rather than
 *  whichever was read last. Bounded by the panel's own reach: one entry per conversation on screen. */
const plans = new Map();
/** Call id -> the tool that call named, learned from the `tool-call` frame. A result frame carries
 *  only an id, so without this the panel could not tell a finished plan change from any other tool. */
const calls = new Map();
const LIMITS = { calls: 512, conversations: 32 };
/** One read in flight at a time: an answer redraws the panel, and a redraw that read again would
 *  leave the panel talking to its own package for as long as it was open. */
let reading = false;

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

/** Reads the plan for the conversation on screen. Never called from `draw`: drawing must not send. */
function refresh() {
  const session = conversation.current;
  if (reading || !session) return;
  reading = true;
  request("plan", { conversation: session })
    .then((answer) => {
      const value = JSON.parse(answer.text || "{}");
      if (plans.size >= LIMITS.conversations && !plans.has(session)) plans.delete(plans.keys().next().value);
      plans.set(session, { items: Array.isArray(value.items) ? value.items : [], done: value.done || 0, total: value.total || 0 });
      panel.redraw();
    })
    .catch((error) => { console.error("the plan could not be read", error); })
    .finally(() => { reading = false; });
}

/** Ticks one line off, or puts it back. The row is disabled until the answer lands, because the
 *  answer is the new plan: showing a tick before the package has taken it would be showing the
 *  person their own click rather than the plan the agent will read. */
function tick(session, item, box) {
  box.disabled = true;
  request("tick", { conversation: session, id: item.id, done: item.stage !== "done" })
    .then((answer) => {
      const value = JSON.parse(answer.text || "{}");
      plans.set(session, { items: Array.isArray(value.items) ? value.items : [], done: value.done || 0, total: value.total || 0 });
      panel.redraw();
    })
    .catch((error) => {
      box.disabled = false; box.checked = item.stage === "done";
      console.error("that line could not be changed", error);
    });
}

/** The mark in front of a line: done, in hand, or not started. Drawn as a real checkbox so the row is
 *  reachable from a keyboard and reads to a screen reader as the thing it is. */
function row(session, item) {
  const box = el("input", {
    type: "checkbox",
    class: "td-box",
    checked: item.stage === "done",
    "aria-label": item.text,
    onChange: () => tick(session, item, box),
  });
  return el("label", { class: `td-item is-${item.stage}` },
    box,
    el("span", { class: "td-copy" },
      el("span", { class: "td-text" }, item.text),
      item.stage === "active" && item.note ? el("span", { class: "td-note" }, item.note) : null,
      el("span", { class: "td-id" }, item.id)));
}

function draw() {
  const session = conversation.current;
  const plan = session ? plans.get(session) : undefined;
  if (!plan || !plan.items.length) {
    return { title: "Todo", subtitle: "Nothing planned yet", items: [], empty: "No plan yet — the agent puts one up when there is more than one thing to do." };
  }
  const left = plan.total - plan.done;
  return {
    title: "Todo",
    subtitle: left ? `${String(plan.done)} of ${String(plan.total)} done` : `All ${String(plan.total)} done`,
    blocks: plan.items.map((item) => row(session, item)),
  };
}

link("/surface/tools-todo/panel.css");

const panel = registerPanel({
  id: "todo",
  label: "Todo",
  hint: "Todo — the plan the agent is working to, and what is left",
  icon: () => icon(LIST, { size: 17, width: 1.5 }),
  draw,
});

// A tab switch shows that conversation's own plan, not whichever was read last.
conversation.watch(() => { panel.redraw(); refresh(); });

onEvent("tool-call", (frame) => {
  if (!TOOLS.has(frame.name)) return;
  if (calls.size >= LIMITS.calls) calls.delete(calls.keys().next().value);
  calls.set(frame.id, frame.session);
});

// The plan is read back after a change rather than reconstructed from the call that made it: the
// package holds the list, and a second copy assembled in a browser is a second list to be wrong.
onEvent("tool-result", (frame) => {
  const session = calls.get(frame.id);
  if (session === undefined) return;
  calls.delete(frame.id);
  if (session === conversation.current) refresh();
});
