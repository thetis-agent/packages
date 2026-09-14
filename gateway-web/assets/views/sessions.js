/* The conversation sidebar. Rows are grouped by recency, most recent first, with the archive folded into a
 * section at the foot. A working row carries a pulsing dot, the live step under a sheen, and a clock that
 * counts up; the clocks tick in place so a hover or a sheen is never dropped by a redraw. Search filters
 * as you type. The row menu renames, archives and restores. */

import { applyActivityPhase, fmtAgo, fmtCost, fmtDuration, shortModel, countWorking } from "../lib/activity.js";
import { $, clear, el, icon, onClickOutside } from "../lib/dom.js";
import { store } from "../lib/store.js";

const dot = (y) => `M10 ${y}a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7z`;
const MORE = [dot(6.7), dot(11.35), dot(16)];
const TICK_MS = { working: 1000, idle: 30_000 };

export function titleOf(session) {
  return session?.title || "New conversation";
}

/** Today / Yesterday / This week / Earlier, from the row's own stamp. */
function bucket(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Earlier";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((start.getTime() - at.getTime()) / 86_400_000);
  if (at >= start) return "Today";
  if (days < 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

export function mountSessions({ onOpen, onNew, onArchive, onRename }) {
  const list = $("session-list");
  const search = $("session-search");
  let query = "";
  let busy = null; // { id, mode: "menu" | "rename", stop }
  let archiveOpen = false;
  const baseTitle = "Thetis";

  function release() {
    busy?.stop?.();
    busy = null;
  }

  // ---- one row ----

  function clock(session, activity) {
    const working = activity?.state === "working";
    const since = working ? activity.since : Date.parse(session.updatedAt);
    if (!since) return null;
    return el(
      "span",
      {
        class: `session-when${working ? " is-elapsed" : ""}`,
        "data-since": String(since),
        "data-mode": working ? "elapsed" : "ago",
        title: working ? `Working since ${new Date(since).toLocaleTimeString()}` : `Last activity ${new Date(since).toLocaleString()}`,
      },
      working ? fmtDuration(Date.now() - since) : fmtAgo(Date.now() - since)
    );
  }

  function statusLine(session, activity) {
    if (activity?.state === "working") {
      const facts = [];
      if (activity.steps > 0) facts.push(`${activity.steps} ${activity.steps === 1 ? "tool call" : "tool calls"}`);
      if (activity.cost >= 0.0005) facts.push(fmtCost(activity.cost));
      return el(
        "div",
        { class: "session-line is-working" },
        el("span", { class: "session-dot" }),
        el("span", { class: `session-step${activity.tool ? " mono" : ""}` }, activity.step),
        facts.length ? el("span", { class: "session-facts" }, facts.join(" · ")) : null
      );
    }
    if (activity?.state === "failed") return el("div", { class: "session-line is-failed" }, el("span", { class: "session-dot" }), el("span", {}, `Stopped: ${activity.outcome}`));
    if (activity?.state === "stopped") return el("div", { class: "session-line is-noted" }, el("span", {}, activity.outcome));
    return el("div", { class: "session-line" }, el("span", {}, session.preview || "No messages yet"));
  }

  /** Turns · cost · model: the facts a person wants without opening the conversation. */
  function factsLine(session) {
    const facts = [];
    if (session.turns > 0) facts.push(`${session.turns} ${session.turns === 1 ? "turn" : "turns"}`);
    if (typeof session.cost === "number" && session.cost > 0) facts.push(fmtCost(session.cost));
    if (session.model) facts.push(shortModel(session.model));
    if (!facts.length) return null;
    return el("div", { class: "session-meta", title: session.model ? `Model: ${session.model}` : undefined }, ...facts.map((f, i) => [i ? el("span", { class: "session-sep" }, "·") : null, el("span", { class: f === shortModel(session.model) && session.model ? "mono" : "" }, f)]));
  }

  function renameField(session) {
    const input = el("input", { class: "session-rename", type: "text", value: titleOf(session), "aria-label": "Rename the conversation", maxlength: "120", spellcheck: "false" });
    const done = (commit) => {
      if (!busy || busy.mode !== "rename") return;
      const value = input.value.trim();
      release();
      if (commit && value && value !== titleOf(session)) onRename(session.id, value);
      else draw();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        done(false);
      }
      event.stopPropagation();
    });
    input.addEventListener("blur", () => done(false));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return input;
  }

  function menu(session, more) {
    const item = (label, run) => el("button", { type: "button", class: "session-menu-item", role: "menuitem", onClick: () => { release(); run(); } }, label);
    const node = el(
      "div",
      { class: "session-menu", role: "menu" },
      item("Rename", () => {
        busy = { id: session.id, mode: "rename" };
        draw();
      }),
      item(session.archived ? "Restore" : "Archive", () => onArchive(session.id, !session.archived)),
      session.named ? item("Use the first message as the name", () => onRename(session.id, "")) : null
    );
    more.setAttribute("aria-expanded", "true");
    const stop = onClickOutside(node, () => {
      release();
      draw();
    });
    busy = { id: session.id, mode: "menu", stop: () => { stop(); node.remove(); more.setAttribute("aria-expanded", "false"); } };
    setTimeout(() => node.querySelector("button")?.focus(), 0);
    return node;
  }

  function row(session) {
    const active = session.id === store.get("current");
    const activity = store.activityOf(session.id);
    const state = activity?.state ?? "idle";
    const renaming = busy?.mode === "rename" && busy.id === session.id;
    const more = el(
      "button",
      { type: "button", class: "session-more", title: "More", "aria-label": `More for ${titleOf(session)}`, "aria-haspopup": "menu", "aria-expanded": "false" },
      icon(MORE, { size: 15, width: 0 })
    );
    more.querySelector("svg").querySelectorAll("path").forEach((p) => p.setAttribute("fill", "currentColor"));
    const title = el("div", { class: "session-title" }, renaming ? renameField(session) : el("span", { class: "session-title-text" }, titleOf(session)), renaming ? null : clock(session, activity));
    const node = el(
      "div",
      { class: `session is-${state}${active ? " is-active" : ""}${session.archived ? " is-archived" : ""}`, "data-session": session.id },
      renaming
        ? el("div", { class: "session-open is-inert" }, title, statusLine(session, activity), factsLine(session))
        : el("button", { type: "button", class: "session-open", title: `${titleOf(session)}${session.preview ? ` · ${session.preview}` : ""}`, onClick: () => onOpen(session.id) }, title, statusLine(session, activity), factsLine(session)),
      renaming ? null : more
    );
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      if (busy?.mode === "menu" && busy.id === session.id) {
        release();
        return draw();
      }
      release();
      node.append(menu(session, more));
    });
    applyActivityPhase(node, activity);
    return node;
  }

  // ---- the list ----

  function matches(session) {
    if (!query) return true;
    return `${session.title} ${session.preview}`.toLowerCase().includes(query);
  }

  function group(label, rows, working) {
    return el(
      "section",
      { class: "session-bucket", "aria-label": label },
      el("div", { class: "session-group" }, label, working ? el("span", { class: "session-count is-working" }, `${working} working`) : null),
      ...rows
    );
  }

  function draw() {
    if (busy?.mode === "menu") release();
    const sessions = store.get("sessions").filter(matches);
    const live = sessions.filter((s) => !s.archived);
    const archived = sessions.filter((s) => s.archived);
    clear(list);
    if (!live.length) list.append(el("p", { class: "session-empty" }, query ? "Nothing matches — try fewer words, or clear the search." : "No conversations yet — start one with the + button."));
    const buckets = new Map();
    for (const session of live) {
      const key = bucket(session.updatedAt);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(session);
    }
    for (const [label, rows] of buckets) {
      const working = rows.filter((s) => store.activityOf(s.id)?.state === "working").length;
      list.append(group(label, rows.map(row), working));
    }
    if (archived.length) {
      list.append(
        el(
          "details",
          { class: "session-archived", open: archiveOpen || query ? "" : null, onToggle: (event) => { if (!query) archiveOpen = event.target.open; } },
          el("summary", {}, el("span", { class: "session-group" }, "Archived", el("span", { class: "session-count" }, archived.length))),
          ...archived.map(row)
        )
      );
    }
    setTitle(countWorking());
    schedule();
  }

  const redraw = () => {
    if (busy?.mode === "rename") return;
    draw();
  };

  // ---- clocks tick in place ----

  const tick = () => {
    const now = Date.now();
    for (const node of list.querySelectorAll(".session-when[data-since]")) {
      const since = Number(node.dataset.since);
      const text = node.dataset.mode === "elapsed" ? fmtDuration(now - since) : fmtAgo(now - since);
      if (node.textContent !== text) node.textContent = text;
    }
  };
  let ticker = null;
  function schedule() {
    clearInterval(ticker);
    ticker = null;
    if (document.hidden) return;
    ticker = setInterval(tick, countWorking() ? TICK_MS.working : TICK_MS.idle);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
    schedule();
  });

  function setTitle(working) {
    const current = store.get("current");
    const name = current ? titleOf(store.session(current)) : "";
    const base = name ? `${name} — ${baseTitle}` : baseTitle;
    const wanted = working ? `(${working}) ${base}` : base;
    if (document.title !== wanted) document.title = wanted;
  }

  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      search.focus();
    }
  });
  $("new-chat").addEventListener("click", () => onNew());

  for (const key of ["sessions", "current", "activity"]) store.watch(key, redraw);
  draw();

  return {
    draw,
    openArchive: () => {
      archiveOpen = true;
      draw();
    },
    rename: (id) => {
      release();
      busy = { id, mode: "rename" };
      draw();
    },
  };
}
