/* The conversation sidebar: most-recent-first rows, a working dot, an overflow menu with Archive/Restore,
 * and the archive folded into a section at the foot. Search filters as you type. */

import { $, clear, el, icon, onClickOutside, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";

const DOTS = ["M6 10h.01M10 10h.01M14 10h.01"];

export function titleOf(session) {
  return session?.title || "New conversation";
}

function when(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function mountSessions({ onOpen, onNew, onArchive }) {
  const list = $("session-list");
  const search = $("session-search");
  let query = "";
  let openMenu = null; // () => void
  let archiveOpen = false;

  function closeMenu() {
    openMenu?.();
    openMenu = null;
  }

  function row(session) {
    const active = session.id === store.get("current");
    const running = store.isRunning(session.id);
    const line = el(
      "div",
      { class: `session-line${running ? " is-working" : ""}` },
      running ? el("span", { class: "session-dot" }) : null,
      el("span", {}, running ? "Working…" : session.preview || "No messages yet")
    );
    const more = el(
      "button",
      { type: "button", class: "session-more", title: "More", "aria-label": `More for ${titleOf(session)}`, "aria-haspopup": "menu", "aria-expanded": "false" },
      icon(DOTS, { size: 14, width: 2.2 })
    );
    const node = el(
      "div",
      { class: `session${active ? " is-active" : ""}`, "data-session": session.id },
      el(
        "button",
        { type: "button", class: "session-open", title: titleOf(session), onClick: () => onOpen(session.id) },
        el("div", { class: "session-title" }, el("span", { class: "session-title-text" }, titleOf(session)), el("span", { class: "session-when" }, when(session.updatedAt))),
        line
      ),
      more
    );
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openMenu) return closeMenu();
      const menu = el(
        "div",
        { class: "session-menu", role: "menu" },
        el(
          "button",
          { type: "button", class: "session-menu-item", role: "menuitem", onClick: () => { closeMenu(); onArchive(session.id, !session.archived); } },
          session.archived ? "Restore" : "Archive"
        )
      );
      node.append(menu);
      more.setAttribute("aria-expanded", "true");
      const stop = onClickOutside(menu, closeMenu);
      openMenu = () => {
        stop();
        menu.remove();
        more.setAttribute("aria-expanded", "false");
      };
      menu.querySelector("button").focus();
    });
    return node;
  }

  function matches(session) {
    if (!query) return true;
    return `${session.title} ${session.preview}`.toLowerCase().includes(query);
  }

  function draw() {
    closeMenu();
    const sessions = store.get("sessions").filter(matches);
    const live = sessions.filter((s) => !s.archived);
    const archived = sessions.filter((s) => s.archived);
    clear(list);
    if (!live.length) list.append(el("p", { class: "session-empty" }, query ? "No conversation matches." : "No conversations yet — start one with the + button."));
    for (const session of live) list.append(row(session));
    if (archived.length) {
      const details = el(
        "details",
        { class: "session-archived", open: archiveOpen || undefined, onToggle: (event) => { archiveOpen = event.target.open; } },
        el("summary", {}, el("span", { class: "session-group" }, "Archived", el("span", { class: "session-count" }, archived.length))),
        ...archived.map(row)
      );
      list.append(details);
    }
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

  store.watch("sessions", draw);
  store.watch("current", draw);
  store.watch("running", draw);
  setInterval(draw, 60_000);
  draw();

  return { draw, openArchive: () => { archiveOpen = true; draw(); } };
}
