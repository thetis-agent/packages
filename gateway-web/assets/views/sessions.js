/* The conversation sidebar. Rows are grouped by recency, most recent first, with the archive folded into a
 * section at the foot. A working row carries a pulsing dot, the live step under a sheen, and a clock that
 * counts up; the clocks tick in place so a hover or a sheen is never dropped by a redraw. Search filters
 * as you type. The row menu renames, archives and restores. A package may narrow the list further
 * with a filter (`store.sessionFilter`, set through `ext.sessions.filter`).
 *
 * The list is built whole only when the list itself changes: the sessions, the filter, the search, the
 * archive fold. What one conversation is doing changes many times a second while it works, and that
 * reaches the sidebar through `store.watchSession`, which redraws the inside of that one row and the
 * agent rows under it; the row node and its buttons stay, so a hover, a focus or a click in flight is not
 * lost under the reader. The bucket's working count, the title and the clock ticker follow. A row with
 * its menu open or its name being edited is left alone until that is over.
 *
 * The open conversation's subagents sit under its row, indented behind a rail with an elbow into each,
 * so the ownership reads at a glance: a dot, the label, the step while it works, then the outcome and
 * the cost. Clicking one shows it (its block in the conversation, or its own tab when one is open); the
 * glyph at the end opens it in a tab. Any other working row counts its agents among its facts. */

import { applyActivityPhase, fmtAgo, fmtCost, fmtDuration, shortModel, countWorking } from "../lib/activity.js";
import { $, clear, el, icon, onClickOutside } from "../lib/dom.js";
import { store } from "../lib/store.js";

const dot = (y) => `M10 ${y}a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7z`;
const MORE = [dot(6.7), dot(11.35), dot(16)];
const OPEN_TAB = ["M4 4h6M4 4v6M4 4l7 7", "M9 16h7v-7"];
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

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function mountSessions({ onOpen, onNew, onArchive, onRename, onAgent, onOpenAgent }) {
  const list = $("session-list");
  const search = $("session-search");
  let query = "";
  let busy = null; // { id, mode: "menu" | "rename", stop }
  let archiveOpen = false;
  let activeRoot = null; // the conversation whose row is highlighted and carries the agent rows
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
      if (activity.steps > 0) facts.push(plural(activity.steps, "tool call"));
      if (activity.agents > 0) facts.push(plural(activity.agents, "agent"));
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
    if (session.turns > 0) facts.push(plural(session.turns, "turn"));
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

  /** A subagent's row, under the conversation that spawned it. `data-parent` ties it to that row for a swap. */
  function agentRow(agent, parent, last) {
    const activity = store.activityOf(agent.id);
    const working = activity?.state === "working" || store.isRunning(agent.id);
    const label = agent.label || "subagent";
    const outcome = agent.outcome || (activity?.state === "failed" ? "failed" : activity?.state === "stopped" ? "stopped" : "done");
    const state = working ? "working" : outcome;
    const step = activity?.state === "working" ? (activity.tool ? activity.step : activity.step.toLowerCase()) : "";
    const facts = working ? ["working", step].filter(Boolean) : [outcome, agent.cost > 0 ? fmtCost(agent.cost) : ""].filter(Boolean);
    const node = el(
      "div",
      { class: `session-agent is-${state}${last ? " is-last" : ""}`, "data-agent": agent.id, "data-parent": parent },
      el(
        "button",
        { type: "button", class: "session-agent-go", title: working ? `${label} is working — show it in the conversation` : `${label} · ${facts.join(" · ")} — show it in the conversation`, onClick: () => onAgent(agent.id) },
        el("span", { class: "session-agent-dot" }),
        el("span", { class: "session-agent-label" }, label),
        el("span", { class: `session-agent-state${activity?.tool && working ? " has-tool" : ""}` }, facts.join(" · "))
      ),
      el("button", { type: "button", class: "session-agent-open", title: "Open in a tab", "aria-label": `Open ${label} in a tab`, onClick: () => onOpenAgent(agent.id) }, icon(OPEN_TAB, { size: 13, width: 1.7 }))
    );
    applyActivityPhase(node, working ? { state: "working" } : null);
    return node;
  }

  /** The rows of the open conversation's subagents; none for any other conversation. */
  function agentRows(session) {
    if (session.id !== activeRoot) return [];
    const agents = store.agentsOf(session.id);
    return agents.map((agent, i) => agentRow(agent, session.id, i === agents.length - 1));
  }

  /** A conversation's row and the rows of its subagents. */
  function rows(session) {
    return [row(session), ...agentRows(session)];
  }

  function row(session) {
    const activity = store.activityOf(session.id);
    const state = activity?.state ?? "idle";
    const renaming = busy?.mode === "rename" && busy.id === session.id;
    const more = el(
      "button",
      { type: "button", class: "session-more", title: "More", "aria-label": `More for ${titleOf(session)}`, "aria-haspopup": "menu", "aria-expanded": "false" },
      icon(MORE, { size: 15, width: 0 })
    );
    more.querySelectorAll("path").forEach((p) => p.setAttribute("fill", "currentColor"));
    const title = el("div", { class: "session-title" }, renaming ? renameField(session) : el("span", { class: "session-title-text" }, titleOf(session)), renaming ? null : clock(session, activity));
    const node = el(
      "div",
      { class: `session is-${state}${session.id === activeRoot ? " is-active" : ""}${session.archived ? " is-archived" : ""}`, "data-session": session.id },
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
    const filter = store.get("sessionFilter");
    if (filter && !filter(session)) return false;
    if (!query) return true;
    return `${session.title} ${session.preview}`.toLowerCase().includes(query);
  }

  function group(label, sessions) {
    return el("section", { class: "session-bucket", "aria-label": label }, el("div", { class: "session-group" }, label, el("span", { class: "session-count is-working", hidden: true })), ...sessions.flatMap(rows));
  }

  /** The "n working" beside a bucket's label, from the rows it holds right now. */
  function countBucket(section) {
    const count = section?.querySelector(":scope > .session-group > .session-count");
    if (!count) return;
    const n = section.querySelectorAll(":scope > .session.is-working").length;
    count.textContent = n ? `${n} working` : "";
    count.hidden = !n;
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
    for (const [label, sessions] of buckets) list.append(group(label, sessions));
    if (archived.length) {
      list.append(
        el(
          "details",
          { class: "session-archived", open: archiveOpen || query ? "" : null, onToggle: (event) => { if (!query) archiveOpen = event.target.open; } },
          el("summary", {}, el("span", { class: "session-group" }, "Archived", el("span", { class: "session-count" }, archived.length))),
          ...archived.flatMap(rows)
        )
      );
    }
    for (const section of list.querySelectorAll(".session-bucket")) countBucket(section);
    settle();
  }

  const redraw = () => {
    if (busy?.mode === "rename") return;
    draw();
  };

  /** Swaps one conversation's row, and the agent rows under it, for one drawn from the store now. */
  function refresh(id) {
    if (busy?.id === id) return;
    const node = list.querySelector(`.session[data-session="${CSS.escape(id)}"]`);
    const session = store.session(id);
    if (!node || !session) return;
    const fresh = row(session);
    const open = node.querySelector(":scope > .session-open");
    node.className = fresh.className;
    open.title = fresh.querySelector(".session-open").title;
    open.replaceChildren(...fresh.querySelector(".session-open").childNodes);
    applyActivityPhase(node, store.activityOf(id));
    for (const agent of list.querySelectorAll(`.session-agent[data-parent="${CSS.escape(id)}"]`)) agent.remove();
    node.after(...agentRows(session));
    countBucket(node.closest(".session-bucket"));
    settle();
  }

  /** The open conversation moved: the old root loses its highlight and its agent rows, the new one takes them. */
  function moveActive(current) {
    const was = activeRoot;
    activeRoot = current ? store.rootOf(current) : null;
    if (was && was !== activeRoot) refresh(was);
    if (activeRoot) refresh(activeRoot);
    settle();
  }

  // ---- what follows every change: the title, and the clocks ticking in place ----

  const tick = () => {
    const now = Date.now();
    for (const node of list.querySelectorAll(".session-when[data-since]")) {
      const since = Number(node.dataset.since);
      const text = node.dataset.mode === "elapsed" ? fmtDuration(now - since) : fmtAgo(now - since);
      if (node.textContent !== text) node.textContent = text;
    }
  };
  let ticker = null;
  let tickMode = null; // "working" | "idle" | null (hidden), so a burst of changes never restarts the clock
  function schedule(working) {
    const mode = document.hidden ? null : working ? "working" : "idle";
    if (mode === tickMode) return;
    tickMode = mode;
    clearInterval(ticker);
    ticker = mode ? setInterval(tick, TICK_MS[mode]) : null;
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
    schedule(countWorking() > 0);
  });

  function settle() {
    const working = countWorking();
    setTitle(working);
    schedule(working > 0);
  }

  function setTitle(working) {
    const name = activeRoot ? titleOf(store.session(activeRoot)) : "";
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

  store.watch("sessions", redraw);
  store.watch("sessionFilter", redraw);
  store.watch("current", moveActive);
  store.watchSession(refresh);
  moveActive(store.get("current"));
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
