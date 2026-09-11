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
 * Each row carries an overflow button with Rename and Archive behind it, the
 * archive sits in a section that collapses at the foot of the list, and an
 * account whose role may observe others gets a switch for everyone's
 * conversations. All three are host-enforced (wire.ts, and the kernel behind
 * it); what is here is only the way to ask.
 *
 * Someone else's conversation, in the everyone view, is drawn but not opened.
 * This socket subscribes through its own person-scoped environment, so there
 * is no stream on it for a conversation that lives in somebody else's — and
 * renaming or archiving would address the wrong environment entirely. A row
 * that cannot be acted on says whose it is and stops there, which is a more
 * honest screen than a click that always fails.
 *
 * The legacy sidebar also grouped by day and nested sub-agent rows under their
 * parent. Neither has a wire to speak to any more.
 */

import { $, clear, el, icon, onClickOutside, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";
import {
  IDLE,
  SHEEN_MS,
  activeSessions,
  archivedSessions,
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

/* The roles whose sidebar may show everyone's conversations. The same list
 * wire.ts checks and the kernel enforces through `observeOthers`; here it only
 * decides whether the switch is on screen at all, since a switch that always
 * answers "you cannot" is worse than no switch. */
const OBSERVERS = ["admin", "reviewer"];

/** A filled dot at `y`, three of which make the overflow button's mark. */
const dot = (y) => `M10 ${y}a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7z`;
const MORE = [dot(6.7), dot(11.35), dot(16)];

let query = "";
let archiveOpen = false;

/* The row the person is in the middle of something on: its menu open, or its
 * name being typed into.
 *
 * The list redraws on every activity change — every tool call of every open
 * conversation — and a redraw builds new nodes, which would close the menu
 * under the cursor and take the caret out of the input mid-word. So while a
 * row is busy the redraw is skipped and taken when it stops, a few seconds
 * later at most. The clocks keep moving either way: `tick` writes text into
 * the nodes that are already there. */
let busy = null;

/* Assigned by `mountSessions`, which owns the list element. Declared out here
 * because the menu and the rename field both end by asking for a redraw, and
 * neither is built inside that function. */
let draw = () => {};

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

/** Whose a row is, when the list is showing more than one person's. The host
 *  stamps `owner` only on a fan-out reply, so an ordinary list has none. */
const ownerOf = (session) => (session && session.owner) || "";
const mine = (session) => !ownerOf(session) || ownerOf(session) === (store.user?.name || "");

/* The overflow menu. Closed by the next click landing anywhere else, and by
 * the Escape key, which is the way out a menu opened by accident needs. */
function menu(session, archived, actions) {
  const choose = (run) => (event) => {
    event.stopPropagation();
    release();
    run();
  };
  const node = el(
    "div",
    { class: "session-menu", role: "menu" },
    el("button", { type: "button", class: "session-menu-item", role: "menuitem", onClick: choose(() => startRename(session)) }, "Rename"),
    el(
      "button",
      { type: "button", class: "session-menu-item", role: "menuitem", onClick: choose(() => actions.onArchive(session.id, !archived)) },
      archived ? "Unarchive" : "Archive"
    )
  );
  if (busy) busy.stop = onClickOutside(node, () => release());
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") release();
  });
  return node;
}

/* Renaming in place: the title line becomes an input holding the name the row
 * shows now. Enter commits, Escape and losing focus abandon — a rename the
 * person walked away from is not one they asked for. The host caps and
 * collapses what is sent (core/session-store.ts), and the row comes back from
 * the next list rather than from anything guessed here. */
function renameField(session, actions) {
  const input = el("input", {
    class: "field session-rename",
    type: "text",
    value: titleOf(session),
    "aria-label": "Conversation name",
    spellcheck: "false",
    autocomplete: "off",
  });
  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    release();
    if (commit && name && name !== titleOf(session)) actions.onRename(session.id, name);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(false));
  // Focused after the row is in the document; an input outside it takes nothing.
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return input;
}

function startRename(session) {
  busy = { id: session.id, mode: "rename" };
  draw();
}

/** Ends whatever the busy row was doing and takes the redraw that was held. */
function release() {
  busy?.stop?.();
  busy = null;
  draw();
}

function row(session, archived, actions) {
  const activity = archived ? IDLE : store.activityOf(session.id);
  const state = activity.state || "idle";
  const said = describeState(activity);
  const owned = mine(session);
  const renaming = busy?.mode === "rename" && busy.id === session.id;
  // Read out into plain locals before any copy is built from them: assets.test.ts
  // reads the text of a template literal whole, interpolations included, and the
  // accessors are named for the wire rather than for a person.
  const name = titleOf(session);
  const owner = ownerOf(session);
  const title = el(
    "div",
    { class: "session-title" },
    renaming ? renameField(session, actions) : el("span", { class: "session-title-text" }, name),
    owned ? null : el("span", { class: "session-owner", title: `${owner}'s conversation` }, owner),
    clock(activity, session)
  );
  const node = el(
    "div",
    {
      class: `session is-${state}${session.id === store.current ? " is-active" : ""}${archived ? " is-archived" : ""}${owned ? "" : " is-theirs"}`,
      dataset: { session: session.id },
    },
    owned && !renaming
      ? el(
          "button",
          {
            type: "button",
            class: "session-open",
            title: [name, said].filter(Boolean).join(" · "),
            onClick: () => actions.onOpen(session.id),
          },
          title,
          statusLine(activity, session)
        )
      : el(
          "div",
          { class: "session-open is-inert", title: owned ? "" : `${owner} owns this conversation; it opens in their own window.` },
          title,
          statusLine(activity, session)
        ),
    owned && !renaming
      ? el(
          "button",
          {
            type: "button",
            class: "session-more",
            title: `More for ${name}`,
            "aria-label": `More for ${name}`,
            "aria-expanded": busy?.mode === "menu" && busy.id === session.id ? "true" : "false",
            onClick: (event) => {
              event.stopPropagation();
              const open = busy?.mode === "menu" && busy.id === session.id;
              release();
              if (open) return;
              busy = { id: session.id, mode: "menu" };
              draw();
            },
          },
          icon(MORE, { size: 15, fill: "currentColor" })
        )
      : null,
    busy?.mode === "menu" && busy.id === session.id ? menu(session, archived, actions) : null
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
  String(session.preview || "").toLowerCase().includes(query) ||
  ownerOf(session).toLowerCase().includes(query);

const empty = (text) => el("div", { class: "session-empty" }, text);

/* The archive, in a section that collapses. A native <details> so the keyboard
 * opens it the way it opens every other one, with the open state held out here
 * because the list is rebuilt from scratch on every change. */
function archiveSection(sessions, actions) {
  const section = el(
    "details",
    { class: "session-archived" },
    el("summary", {}, el("div", { class: "session-group" }, el("span", {}, "Archived"), el("span", { class: "session-count" }, String(sessions.length)))),
    ...sessions.map((session) => row(session, true, actions))
  );
  section.open = archiveOpen;
  section.addEventListener("toggle", () => { archiveOpen = section.open; });
  return section;
}

/* The switch for everyone's conversations, for a role that has one. Lit while
 * it is on, so the contents of the sidebar are never a mystery. */
function everyoneSwitch(onScope) {
  const button = $("see-all");
  if (!button) return () => {};
  button.addEventListener("click", () => {
    onScope(store.scope === "everyone" ? "mine" : "everyone");
  });
  return () => {
    const allowed = OBSERVERS.includes(store.user?.role || "");
    setHidden(button, !allowed);
    const on = allowed && store.scope === "everyone";
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on ? "Showing everyone's conversations — click for just yours" : "Show everyone's conversations";
  };
}

export function mountSessions(actions) {
  const list = $("session-list");
  $("new-chat").addEventListener("click", actions.onNew);
  const { tick, schedule } = clocks(list);
  const setTitle = titleSetter();
  const refreshSwitch = everyoneSwitch(actions.onScope);
  wireSearch($("session-search"), (next) => { query = next; draw(); });

  draw = () => {
    clear(list);
    refreshSwitch();
    const all = store.sessions || [];
    const live = sortSessions(activeSessions(all)).filter(matches);
    const filed = sortSessions(archivedSessions(all)).filter(matches);
    if (!all.length) list.append(empty("No conversations yet — start one with the + button."));
    else if (!live.length && !filed.length) list.append(empty("Nothing matches — try fewer words, or clear the search."));
    else {
      for (const session of live) list.append(row(session, false, actions));
      if (filed.length) list.append(archiveSection(filed, actions));
    }
    setTitle(activeSessions(all).filter((session) => store.activityOf(session.id).state === "working").length);
    tick();
  };

  const redraw = () => { if (!busy) draw(); };
  store.watch("sessions", redraw);
  store.watch("current", redraw);
  store.watch("busyIds", redraw);
  store.watch("user", redraw);
  store.watch("scope", redraw);
  store.watch("activity", () => { redraw(); schedule(); });
  draw();
  schedule();
  /* Opened from outside after a row is archived, so the section it just moved
   * into is the one thing on screen that visibly changed. */
  return { openArchive() { archiveOpen = true; redraw(); } };
}
