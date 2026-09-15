/* The browser side of @thetis/tools-plan: what the web gateway draws for this package once it has read
 * the `ui` block of the manifest. Three pieces share one per-conversation cache of the plan: the Todo
 * dock (one row per item with a ✓ ● ○ glyph, a checkbox that marks the item through the `mark` command,
 * and the row disabled until the package answers, because the answer is the plan), the `todo n/m` chip
 * in the chat bar that opens the dock, and the transcript renderers that fold every todo_* call into one
 * quiet line and draw an ask_user call as a form. The cache is filled from two sides: every todo_* result
 * carries the whole rendered plan, so the transcript keeps the chip right without a request, live and on
 * a restored record alike; and the dock asks the package for the plan as data (`plan`) for a conversation
 * it has not read, or has not read since the conversation changed. The seam has no "opened" hook, so that
 * read is scheduled by the first draw of such a conversation, never awaited inside it, one per
 * conversation at a time, and a conversation is read at most once per change; a redraw after the answer
 * finds the cache filled and asks nothing. Nothing here touches the gateway beyond what `ext` hands over. */

import { askCard, lockCard, parseAsk } from "./ask.js";
import { isTodoTool, parsePlan, planLine, shapePlan } from "./plan-text.js";

const CACHE_MAX = 32;
const ASK_TOOL = "ask_user";
const GLYPH = { done: "✓", active: "●", pending: "○", dropped: "–" };

export default function install(ext) {
  const { el, setHidden } = ext.dom;
  const plans = new Map();    // session -> { items, notes, done, total, allSettled }, newest last
  const unread = new Set();   // sessions the dock must read (never read, or changed since)
  const failed = new Map();   // session -> why the last read failed; shown with a Retry, not retried on its own
  const reading = new Set();  // sessions with a `plan` request in flight
  const marking = new Set();  // item ids with a `mark` request in flight

  function remember(session, plan) {
    plans.delete(session);
    plans.set(session, plan);
    unread.delete(session);
    failed.delete(session);
    if (plans.size > CACHE_MAX) plans.delete(plans.keys().next().value);
  }

  const fromData = (data) => shapePlan(Array.isArray(data?.items) ? data.items : []);

  // ---- the two commands ----

  function read(session) {
    if (reading.has(session)) return;
    reading.add(session);
    ext.request("plan", { session })
      .then(({ data }) => remember(session, fromData(data)), (err) => failed.set(session, err?.message || "no answer"))
      .finally(() => { reading.delete(session); unread.delete(session); ext.redraw(); });
  }

  async function mark(session, id, stage) {
    marking.add(id);
    ext.redraw("todo");
    try {
      const { text, data } = await ext.request("mark", { session, args: { id, stage } });
      remember(session, fromData(data));
      if (text) ext.toast(text);
    } catch (err) {
      ext.toast(`The item was not marked: ${err?.message || "no answer"}`, { tone: "error" });
    } finally {
      marking.delete(id);
      ext.redraw();
    }
  }

  // ---- the dock ----

  function row(session, item) {
    const done = item.stage === "done";
    const check = el("input", {
      type: "checkbox",
      class: "tp-check",
      checked: done,
      disabled: item.stage === "dropped" || marking.has(item.id),
      "aria-label": `${item.text} — mark ${done ? "pending" : "done"}`,
      onChange: (e) => void mark(session, item.id, e.target.checked ? "done" : "pending"),
    });
    return el(
      "div",
      { class: `tp-row is-${item.stage}${marking.has(item.id) ? " is-busy" : ""}`, "data-item": item.id },
      el("label", { class: "tp-mark", title: item.stage === "dropped" ? "Dropped" : done ? "Mark it pending again" : "Mark it done" }, check, el("span", { class: "tp-glyph", "aria-hidden": "true" }, GLYPH[item.stage] ?? GLYPH.pending)),
      el("div", { class: "tp-copy" }, el("div", { class: "tp-text" }, item.text), item.note ? el("div", { class: "tp-note" }, item.note) : null),
      el("span", { class: "tp-id mono" }, item.id)
    );
  }

  function dockBody(session) {
    if (!session) return el("div", { class: "panel-empty" }, "No conversation open.");
    const plan = plans.get(session);
    if (failed.has(session) && !plan) {
      return el("div", { class: "tp-failed" }, el("span", {}, `The plan could not be read: ${failed.get(session)}`), el("button", { type: "button", class: "ghost-btn sm", onClick: () => { failed.delete(session); unread.add(session); ext.redraw("todo"); } }, "Retry"));
    }
    if (!plan) return el("div", { class: "panel-empty" }, "Reading the plan…");
    if (!plan.total) return el("div", { class: "panel-empty" }, "No plan yet in this conversation.");
    return el(
      "div",
      { class: "tp-plan" },
      plan.notes.length ? el("div", { class: "tp-notes" }, ...plan.notes.map((n) => el("div", {}, n))) : null,
      el("div", { class: "tp-list" }, ...plan.items.map((item) => row(session, item)))
    );
  }

  ext.dock("todo", {
    draw() {
      const session = ext.conversation.current;
      if (session && !failed.has(session) && (unread.has(session) || !plans.has(session))) queueMicrotask(() => read(session));
      const plan = session ? plans.get(session) : null;
      return { title: "Todo", subtitle: plan?.total ? `${plan.done} of ${plan.total} done` : "", body: dockBody(session) };
    },
  });

  ext.conversation.watch((session) => {
    if (session) unread.add(session);
    ext.redraw("todo");
  });

  // ---- the chip: hidden until the conversation has a plan, green once every item is done or dropped ----

  ext.chip("todo", {
    draw(button, { session }) {
      const plan = plans.get(session);
      const has = Boolean(plan?.total);
      setHidden(button, !has);
      button.classList.add("mono", "tp-chip");
      button.title = "The plan of this conversation";
      if (!has) return;
      button.textContent = `todo ${plan.done}/${plan.total}`;
      button.classList.toggle("is-done", plan.allSettled);
    },
    open() {
      ext.open.dock("todo");
    },
  });

  // ---- the transcript: a todo_* call is one quiet line; an ask_user call is the form ----

  const callArgs = new Map(); // todo_* call id -> its args, held from tool.call to tool.result
  const forms = new Set();    // "<session>:<call id>" drawn as a form, so the result is swallowed

  ext.transcript((event, ctx) => {
    if (event.type === "tool.call") {
      const call = event.call ?? {};
      if (isTodoTool(call.name)) {
        callArgs.set(call.id, call.args || {});
        return true;
      }
      if (call.name !== ASK_TOOL) return null;
      const ask = parseAsk(call.args);
      if (!ask) return null; // a malformed call keeps its tool card rather than vanishing
      const card = askCard(ext.dom, ask, { onAnswer: (text) => void ext.conversation.send(text) });
      forms.add(`${ctx.session}:${call.id}`);
      ctx.whenAnswered(() => lockCard(ext.dom, card));
      return card;
    }
    if (event.type !== "tool.result") return null;
    if (event.name === ASK_TOOL) return forms.has(`${ctx.session}:${event.id}`) ? true : null;
    if (!isTodoTool(event.name)) return null;
    const args = callArgs.get(event.id) || {};
    callArgs.delete(event.id);
    const plan = parsePlan(event.result);
    if (!plan) return true; // an error result: the plan did not change, and the line would say nothing
    remember(ctx.session, plan);
    ext.redraw();
    return ctx.el("div", { class: "msg is-note is-quiet tp-line" }, ctx.el("span", { class: "note-dot" }), ctx.el("span", {}, planLine(event.name, args, plan)));
  });
}
