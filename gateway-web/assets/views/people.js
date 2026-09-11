/* Who is in this conversation, and who can see that it exists.
 *
 * The honest answer today is "just you", and the panel exists because that
 * answer is not obvious and its two edges are not obvious at all. A conversation
 * is one person's: it is kept in their own environment, reached over the one
 * endpoint their own gateway is given, and nobody else's browser has a path to
 * it — not a colleague's, not an administrator's. docs/adr/0052 works through
 * why, and what it would take to change; everything drawn here is a reading of
 * what this wire actually carries, and nothing here is drawn from a guess.
 *
 * That is also why this is a built-in tab beside Environment rather than a
 * contributed panel. The whole content is `store.user` — who this connection is
 * signed in as, and with what standing — and the owner stamped on rows in an
 * everyone-scoped list. Neither is on `lib/surface.js`, and neither belongs to
 * any package: a contributor would have to be handed the surface's own identity
 * to draw them, which is a wider seam than the panel it would buy.
 *
 * Two facts here are real and are stated nowhere else in the UI. The first is
 * that a conversation cannot be opened by anyone but its owner. The second is
 * that its *name and first line* can still be seen by an account allowed to
 * look across people — `session.list` answers a fan-out with a title and a
 * preview per row (lib/socket/sessions.ts) — and that is a genuinely different
 * thing from reading it. Saying both out loud is most of the point.
 *
 * There is no invite control and no presence, because there is nothing behind
 * either. Nothing on this wire lists the accounts a deployment knows
 * (gateway-web/admin.ts's `#accounts` says so for the control panel too), and
 * nobody but the owner can be reading a conversation, so "who is here" has one
 * answer and it is already on screen.
 */

import { fmtAgo } from "../lib/activity.js";
import { avatarFor } from "../lib/avatar.js";
import { el } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { section } from "./panel.js";
import * as rail from "./rail.js";

const ID = "people";

/* The roles whose account may be allowed to look across people, mirroring
 * views/sessions.js's list of the same name and wire.ts's `observers`. It
 * decides nothing here either: it only chooses which of two true sentences to
 * write, since an account that cannot look across people would be puzzled by
 * one that tells it where its own switch is. */
const OBSERVERS = ["admin", "reviewer"];

/** The people in the list, excluding this one, with how much of each is on
 *  screen. Empty unless the list is showing everyone's conversations — an
 *  ordinary reply carries no owner at all, so there is nothing to count. */
function othersInList() {
  const me = store.user?.name || "";
  const counts = new Map();
  for (const row of store.sessions) {
    const owner = row && row.owner;
    if (!owner || owner === me) continue;
    const seen = counts.get(owner) || { rows: 0, last: 0 };
    counts.set(owner, { rows: seen.rows + 1, last: Math.max(seen.last, Number(row.updatedMs || row.createdMs || 0)) });
  }
  return [...counts].map(([name, seen]) => ({ name, ...seen })).sort((left, right) => right.last - left.last);
}

/** One face and one or two lines about whoever it belongs to. `--avatar-lg` is
 *  narrowed on the row rather than in the tile, the way the sidebar's own
 *  identity block narrows it: the tile is the look, the holder is the size. */
function personRow(name, tags, lines) {
  return el(
    "div",
    { class: "person" },
    avatarFor("person", name),
    el(
      "div",
      { class: "person-copy" },
      el("div", { class: "person-name" }, name, ...tags.map((tag) => el("span", { class: "person-tag" }, tag))),
      ...lines.filter(Boolean).map((line) => el("div", { class: "person-meta" }, line))
    )
  );
}

/** When this conversation was started, as a sentence rather than a stamp. The
 *  list is the only thing that knows — the stream carries no such moment — so a
 *  conversation opened before its first list reply simply says nothing. */
function startedLine() {
  const row = store.sessions.find((value) => value.id === store.current);
  const at = Number(row && row.createdMs) || 0;
  return at ? `Started this conversation ${fmtAgo(Date.now() - at)}` : null;
}

function draw() {
  if (!store.current) {
    rail.open({ id: ID, title: "People", items: [], empty: "Open a conversation to see who is in it." });
    return;
  }

  const me = store.user?.name || "You";
  const observer = OBSERVERS.includes(store.user?.role || "");
  const others = othersInList();
  const blocks = [personRow(me, ["you"], [startedLine()])];

  blocks.push(
    section({
      title: "Who else can see it",
      note:
        "Nobody else can open this conversation or read what was said in it. It is kept with your account, " +
        "on your own copy of the system, and yours is the only sign-in that reaches it.",
    })
  );
  blocks.push(
    el(
      "p",
      { class: "panel-section-note" },
      "Whoever looks after this place can be allowed to see a conversation's name and its first line in a list " +
        "of everyone's. Even then they cannot open one or read a word of it."
    )
  );

  if (observer && others.length) {
    blocks.push(
      section({
        title: "Other people here",
        count: others.length,
        note: "Names and first lines, from the list on the left. None of these can be opened.",
      })
    );
    for (const other of others) {
      const count = `${String(other.rows)} conversation${other.rows === 1 ? "" : "s"}`;
      blocks.push(personRow(other.name, [], [other.last ? `${count} · last one ${fmtAgo(Date.now() - other.last)}` : count]));
    }
  } else if (observer) {
    blocks.push(
      el(
        "p",
        { class: "panel-section-note" },
        "Your own account is allowed to. The button at the top of the list on the left switches it to everyone's " +
          "conversations, and this panel then names who else is here."
      )
    );
  }

  blocks.push(
    section({
      title: "Adding someone",
      note:
        "You cannot bring another person into a conversation yet. A conversation runs with your files, your " +
        "settings and your model, so handing one over would hand those over too — it is not offered until it can " +
        "be done without that.",
    })
  );

  rail.open({ id: ID, title: "People", subtitle: "Just you", blocks });
}

export function mountPeople() {
  // Four things move this panel: who we are, which conversation is on screen,
  // whose conversations the list holds, and the list itself.
  for (const key of ["user", "current", "scope", "sessions"]) {
    store.watch(key, () => {
      if (rail.isOpen(ID)) draw();
    });
  }
  return { id: ID, label: "People", hint: "Who is in this conversation, and who can see that it exists", icon: rail.ICONS.people, activate: draw };
}
