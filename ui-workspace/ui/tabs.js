/* The tab strip over the editor: one `.ws-tab` per open file from `model.tabs`, the active one marked,
 * a dirty dot when the buffer differs from disk, a lock glyph on a read-only file, and a close button on
 * every tab (a read-only tab closes like any other). To the right, `.ws-tabs-right` is a cluster
 * the active view fills through the `right` element this module hands back: the Rendered | Source
 * segment, Save, Revert, Download, ⋯. Clicking activates through the model; closing a dirty tab asks
 * with the shell's confirm first. Arrow keys move along the strip, Enter and Space activate, Delete
 * closes; the strip redraws itself on every `tabs` event of the model.
 *
 * `mountTabs(host, { model, ext, onActivate, onClose })` → `{ update(), right, destroy() }`. */

import { ICONS } from "./icons.js";
import { parentOf } from "./model.js";

export function mountTabs(host, { model, ext, onActivate, onClose } = {}) {
  const { el, icon } = ext.dom;
  let alive = true;
  host.classList.add("ws-tabs");
  const list = el("div", { class: "ws-tabs-list", role: "tablist", "aria-label": "Open files" });
  const right = el("div", { class: "ws-tabs-right" });
  host.append(list, right);

  async function close(tab, anchor) {
    if (!alive) return;
    if (tab.dirty) {
      const ok = await ext.ui.confirm(anchor ?? host, {
        title: "Close without saving?",
        lines: [["File", tab.name]],
        note: "The unsaved changes in this tab are dropped. Save first to keep them.",
        confirmLabel: "Close",
        tone: "warn",
      });
      if (!ok || !alive) return;
    }
    try {
      onClose?.(tab);
    } catch (err) {
      console.error("a workspace tab onClose threw:", err);
    }
    model.tabs.close(tab.path);
  }

  function activate(tab) {
    model.tabs.activate(tab.path);
    try {
      onActivate?.(tab);
    } catch (err) {
      console.error("a workspace tab onActivate threw:", err);
    }
  }

  function tabNode(tab, active) {
    const ro = tab.mode === "ro";
    const node = el(
      "div",
      {
        class: `ws-tab${active ? " is-active" : ""}${tab.dirty ? " is-dirty" : ""}${ro ? " is-ro" : ""}`,
        role: "tab",
        "aria-selected": String(active),
        tabindex: active ? "0" : "-1",
        "data-path": tab.path,
        title: tab.path,
        onClick: () => activate(tab),
        onAuxclick: (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          close(tab, node);
        },
        onMousedown: (event) => {
          if (event.button === 1) event.preventDefault(); // no autoscroll cursor on middle-click
        },
        onKeydown: (event) => onKey(event, tab, node),
      },
      el("span", { class: "ws-tab-name" }, tab.name),
      el("span", { class: "ws-tab-path" }, shortParent(tab.path)),
      el("span", { class: "ws-tab-dirty", "aria-label": tab.dirty ? "unsaved" : null, "aria-hidden": tab.dirty ? null : "true" }, "●"),
      ro ? el("span", { class: "ws-tab-lock", title: "Read-only" }, icon(ICONS.lock, { size: 12, width: 1.8 })) : null,
      el("button", { type: "button", class: "ws-tab-close", title: `Close ${tab.name}`, "aria-label": `Close ${tab.name}`, tabindex: "-1", onClick: (event) => { event.stopPropagation(); close(tab, node); } }, icon(ICONS.x, { size: 11, width: 1.9 }))
    );
    return node;
  }

  function onKey(event, tab, node) {
    const tabs = [...list.querySelectorAll(".ws-tab")];
    const at = tabs.indexOf(node);
    const go = (index) => {
      event.preventDefault();
      const next = tabs[(index + tabs.length) % tabs.length];
      next?.focus();
    };
    switch (event.key) {
      case "ArrowRight":
        return go(at + 1);
      case "ArrowLeft":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(tabs.length - 1);
      case "Enter":
      case " ":
        event.preventDefault();
        return activate(tab);
      case "Delete":
      case "Backspace":
        event.preventDefault();
        return close(tab, node);
      default:
        return;
    }
  }

  function draw() {
    if (!alive) return;
    const active = model.tabs.active();
    const tabs = model.tabs.list();
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren(...tabs.map((tab) => tabNode(tab, active?.path === tab.path)));
    host.classList.toggle("is-empty", !tabs.length);
    if (hadFocus) list.querySelector(".ws-tab.is-active")?.focus();
    list.querySelector(".ws-tab.is-active")?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }

  const stop = model.watch((event) => {
    if (event.kind === "tabs") draw();
  });
  draw();

  return {
    update: draw,
    right,
    destroy() {
      alive = false;
      stop();
      host.replaceChildren();
      host.classList.remove("ws-tabs", "is-empty");
    },
  };
}

/** The parent shown beside the name: the last two segments, `~` for the home root when it is one. */
function shortParent(path) {
  const parent = parentOf(path);
  if (!parent) return "";
  const parts = parent.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parent;
}
