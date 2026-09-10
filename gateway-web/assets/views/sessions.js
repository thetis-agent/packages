/* The conversation sidebar: navigation, and what each conversation is doing.
 *
 * Search filters as you type; the list sorts by most-recent activity, which is
 * a real sort now that `session.list` carries `updatedMs` (core/session-store.ts).
 * Every row also says what its conversation is doing *right now* — working
 * under a moving sheen with the current step and a ticking elapsed time, or
 * failed with how — from `store.activity`.
 *
 * That liveness has a hard edge this wire draws for us, and lib/activity.js's
 * header spells it out: activity is derived from this socket's own `event`
 * frames, and wire.ts sends those only for conversations the socket has
 * subscribed to. A conversation with no open tab shows its title, preview and
 * recency, and nothing about what it is doing, because nothing about it
 * reaches this tab. There is no `waiting` state either: no frame on this wire
 * means "stopped to ask you something".
 *
 * The legacy sidebar also grouped by day, nested sub-agent rows under their
 * parent, and — for a role that could see everyone's work — grouped by owner
 * with an "all conversations" toggle. None of that has a wire to speak to any
 * more (no sub-agents, no owner field, no "see everyone's conversations"
 * concept at all). Archived rows are filtered out here and no archived section
 * is drawn: the storage flag exists, but no command on this wire can set it,
 * so a section for it would always be empty.
 */

import { $, clear, el } from "../lib/dom.js";
import { store } from "../lib/store.js";
import {
  SHEEN_MS,
  activeSessions,
  describeState,
  describeStep,
  fmtAgo,
  fmtDuration,
  previewOf,
  sortSessions,
  stampOf,
  titleOf,
} from "../lib/activity.js";

/** How often the clocks move: every second while anything works, else every half minute. */
const TICK_MS = { working: 1000, idle: 30_000 };

let query = "";

/* The clock at the row's right edge. It carries what it measures from in
 * `data-since` so the ticker can move every clock without redrawing the list,
 * which would drop a hover and restart every sheen. */
function clock(activity, session) {
  const working = activity.state === "working";
  const since = working ? activity.sinceMs : stampOf(session);
  if (!since) return null;
  return el(
    "span",
    {
      class: `session-when${working ? " is-elapsed" : ""}`,
      dataset: { since: String(since), mode: working ? "elapsed" : "ago" },
      title: working
        ? `Working since ${new Date(since).toLocaleTimeString()}`
        : `Last activity ${new Date(since).toLocaleString()}`,
    },
    working ? fmtDuration(Date.now() - since) : fmtAgo(Date.now() - since)
  );
}

/** The second line: the live step while working, why it stopped when that is
 *  unusual, else the last message's preview. */
function statusLine(activity, session) {
  if (activity.state === "working") {
    const { label, tool, facts } = describeStep(activity);
    return el(
      "div",
      { class: "session-line is-working" },
      el("span", { class: "session-dot" }),
      el(
        "span",
        { class: `session-step${tool ? " session-tool" : ""}`, title: tool ? `Running the ${tool} tool` : label },
        label || tool
      ),
      facts.length ? el("span", { class: "session-facts" }, facts.join(" · ")) : null
    );
  }
  if (activity.state === "failed") {
    return el(
      "div",
      { class: "session-line is-failed" },
      el("span", { class: "session-dot" }),
      el("span", { class: "session-step", title: activity.outcome || "" },
        "Stopped: ", el("span", { class: "session-tool" }, activity.outcome || "error"))
    );
  }
  // An ordinary stop shows the conversation; an unusual one — cancelled,
  // interrupted by a restart — is worth the one line it takes to say so.
  return el("div", { class: `session-line${activity.outcome ? " is-noted" : ""}` },
    activity.outcome || previewOf(session));
}

/* The sheen's phase, from a shared clock.
 *
 * The list is redrawn on every activity change — each tool call — and a CSS
 * animation restarts with its node, so without this the sheen jumped back to
 * the start on every step. Anchoring the delay to wall time keeps it gliding
 * through a redraw and keeps every working row in step with the others.
 *
 * Set through CSSOM rather than as a `style=` attribute in markup: lib/assets'
 * CSP is `default-src 'self'` with no `style-src` exception, which blocks a
 * style attribute but not a property set on an element's own style object. */
function phase(node, activity) {
  if (activity.state !== "working") return;
  node.style.setProperty("--phase", `-${String(Date.now() % SHEEN_MS)}ms`);
}

function row(session, onOpen) {
  const activity = store.activityOf(session.id);
  const state = activity.state || "idle";
  const said = describeState(activity);
  const node = el(
    "button",
    {
      class: `session is-${state}${session.id === store.current ? " is-active" : ""}`,
      dataset: { session: session.id },
      title: [titleOf(session), said].filter(Boolean).join(" · "),
      onClick: () => onOpen(session.id),
    },
    el(
      "div",
      { class: "session-title" },
      el("span", { class: "session-title-text" }, titleOf(session)),
      clock(activity, session)
    ),
    statusLine(activity, session)
  );
  phase(node, activity);
  return node;
}

/* Focus search from anywhere that is not already an input, on "/". */
function wireSearch(search, onChange) {
  search.addEventListener("input", () => { onChange(search.value.trim().toLowerCase()); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    event.preventDefault();
    search.focus();
  });
}

/* Every clock in the list, moved forward in place.
 *
 * `tick` writes the DOM only where the text differs; a redraw instead would
 * drop a hover and restart every sheen. `schedule` keeps exactly one interval:
 * every second while anything is working — the elapsed time on a live row is
 * the thing you watch — every half minute otherwise, and none at all in a
 * hidden tab, which should not wake to rewrite text nobody is reading. */
function clocks(list) {
  let ticker = null;
  const tick = () => {
    const now = Date.now();
    // Selected by the data attribute alone: everything carrying `data-since` inside the list is one
    // of these clocks, and the class-qualified selector would put a never-say word in served copy.
    for (const node of list.querySelectorAll("[data-since]")) {
      const since = Number(node.dataset.since);
      const text = node.dataset.mode === "elapsed" ? fmtDuration(now - since) : fmtAgo(now - since);
      if (node.textContent !== text) node.textContent = text;
    }
  };
  const schedule = () => {
    clearInterval(ticker);
    ticker = null;
    if (document.hidden) return;
    const working = (store.sessions || []).some((session) => store.activityOf(session.id).state === "working");
    ticker = setInterval(tick, working ? TICK_MS.working : TICK_MS.idle);
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
    schedule();
  });
  return { tick, schedule };
}

/* The window title carries how many conversations are working, so a tab in the
 * background says "(2) Thetis" and you know without switching to it. */
function titleSetter() {
  const base = document.title;
  return (working) => {
    const wanted = working ? `(${working}) ${base}` : base;
    if (document.title !== wanted) document.title = wanted;
  };
}

const matches = (session) =>
  !query ||
  String(session.title || session.id || "").toLowerCase().includes(query) ||
  String(session.preview || "").toLowerCase().includes(query);

const empty = (text) => el("div", { class: "session-empty" }, text);

export function mountSessions({ onOpen, onNew }) {
  const list = $("session-list");
  $("new-chat").addEventListener("click", onNew);
  const { tick, schedule } = clocks(list);
  const setTitle = titleSetter();
  wireSearch($("session-search"), (next) => { query = next; draw(); });

  function draw() {
    clear(list);
    const all = sortSessions(activeSessions(store.sessions));
    const visible = all.filter(matches);
    if (!all.length) list.append(empty("No conversations yet — start one with the + button."));
    else if (!visible.length) list.append(empty("Nothing matches — try fewer words, or clear the search."));
    else for (const session of visible) list.append(row(session, onOpen));
    setTitle(all.filter((session) => store.activityOf(session.id).state === "working").length);
    tick();
  }

  store.watch("sessions", draw);
  store.watch("current", draw);
  store.watch("busyIds", draw);
  store.watch("activity", () => { draw(); schedule(); });
  draw();
  schedule();
}
