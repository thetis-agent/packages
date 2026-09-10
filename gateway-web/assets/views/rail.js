/* The context rail: one persistent, non-modal home for an inspector.
 *
 * A vertical strip of tabs on the right edge and a docked panel beside it. The
 * panel reflows the chat rather than covering it, so the transcript stays
 * readable and the composer stays typable with it open. Escape or a second
 * click on the active tab collapses back to the strip.
 *
 * Environment is the only inspector left in this build — the legacy Branch,
 * Files, Context, Skills, Tools and Models tabs addressed hosts capabilities
 * (branch sandboxes, a workspace filesystem, a skills/tools catalogue) that
 * this wire has no equivalent of — but the chrome here stays generic so a
 * future inspector can register a tab without rewriting it.
 */

import { $, clear, el, icon } from "../lib/dom.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];

let tabs = [];
let strip = null;
let panel = null;
let current = null;
/** Set when the user collapses the rail themselves; stops auto-opens. */
let userClosed = false;

export function mountRail(tabList) {
  tabs = tabList;
  strip = $("rail-tabs");
  panel = $("rail-panel");

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) close(true);
  });

  drawStrip();
}

export function isOpen(id) {
  return current === id;
}

export function activeTab() {
  return current;
}

/** True until the user collapses the rail by hand. */
export function wantsAutoOpen() {
  return !userClosed && !current;
}

export function close(byUser = false) {
  if (byUser) userClosed = true;
  current = null;
  panel.hidden = true;
  panel.className = "rail-panel";
  clear(panel);
  drawStrip();
}

/** Takes a tab out of the strip (or puts it back). A tab the user's role
 *  cannot use — Files for someone denied the workspace — is not shown at
 *  all rather than shown and refused. Closing it if it was open. */
export function setTabHidden(id, hidden) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || Boolean(tab.hidden) === Boolean(hidden)) return;
  tab.hidden = Boolean(hidden);
  if (hidden && current === id) close(false);
  else drawStrip();
}

/** Activates a tab by id — the tab's own `activate` does the drawing. */
export function show(id) {
  tabs.find((t) => t.id === id)?.activate();
}

/**
 * Opens (or re-renders) the panel for one tab. Same config the old modal
 * panel took, plus optional `head` nodes rendered beside the title.
 */
export function open(config) {
  const tab = tabs.find((t) => t.id === config.id);
  current = config.id;
  panel.hidden = false;
  panel.className = `rail-panel${tab?.wide ? " is-wide" : ""}`;

  const body = config.blocks
    ? el("div", { class: "panel-list" }, config.blocks.filter(Boolean))
    : config.items === undefined
      ? el("div", { class: "panel-note" }, "Loading…")
      : config.items.length === 0
        ? el("div", { class: "panel-note" }, config.empty || "Nothing to show.")
        : el("div", { class: "panel-list" }, config.items.map(config.renderItem));

  clear(panel).append(
    el(
      "header",
      { class: "panel-head" },
      el(
        "div",
        { class: "panel-heading" },
        el("h2", { class: "panel-title" }, config.title),
        config.subtitle && el("p", { class: "panel-sub" }, config.subtitle)
      ),
      el(
        "div",
        { class: "panel-head-actions" },
        ...(config.head || []),
        el(
          "button",
          { class: "icon-btn sm", title: "Collapse (Esc)", "aria-label": "Collapse", onClick: () => close(true) },
          icon(X, { size: 14, width: 1.8 })
        )
      )
    ),
    el("div", { class: "panel-body" }, body)
  );

  drawStrip();
}

function drawStrip() {
  if (!strip) return;
  clear(strip).append(
    ...tabs.filter((tab) => !tab.hidden).map((tab) =>
      el(
        "button",
        {
          type: "button",
          class: `rail-tab${current === tab.id ? " is-active" : ""}`,
          title: tab.hint || tab.label,
          "aria-label": tab.label,
          onClick: () => {
            if (current === tab.id) close(true);
            else {
              userClosed = false;
              tab.activate();
            }
          },
        },
        tab.icon()
      )
    )
  );
}

// --- tab icons ------------------------------------------------------------------

function svg(children, viewBox = "0 0 20 20") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", viewBox);
  node.setAttribute("width", "17");
  node.setAttribute("height", "17");
  node.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of children) {
    const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    child.setAttribute("fill", attrs.fill ?? "none");
    if ((attrs.fill ?? "none") === "none") {
      child.setAttribute("stroke", "currentColor");
      child.setAttribute("stroke-width", attrs["stroke-width"] ?? "1.6");
      child.setAttribute("stroke-linecap", "round");
      child.setAttribute("stroke-linejoin", "round");
    }
    node.append(child);
  }
  return node;
}

export const ICONS = {
  /** A ready/unready dot inside a boundary — the environment the conversation
   *  runs in, standing in for the branch/files/context/skills/tools/people/
   *  models set of icons the legacy rail offered one each of. */
  environment: () =>
    svg([
      ["circle", { cx: "10", cy: "10", r: "6.5" }],
      ["circle", { cx: "10", cy: "10", r: "2", fill: "currentColor" }],
    ]),
};
