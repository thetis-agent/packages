/* The rail and the dock. The rail is the vertical strip of buttons beside the main pane, one per declared
 * dock entry in declaration order, drawn before the package's module loads so a failed load leaves a named
 * button, not a gap. Each button carries its label as its accessible name and its label and hint as its
 * tooltip; the ⇆ at the foot of the rail widens it so every button shows its label in words as well,
 * remembered on this screen. Clicking a button opens the dock on that entry: a header (title, subtitle,
 * actions, ✕) over a body the package's `draw()` answers; 360px wide, 620px for `wide`. The active button,
 * the ✕, or Escape (when the dock is the top layer, `lib/layers.js`) closes it. The chat reflows beside it;
 * nothing is modal. The rail is hidden until something declares a dock entry, so a page without extensions
 * looks as before.
 *
 * On a phone (under 600px) a permanent column costs an eighth of the width, so the rail is not drawn; a
 * "Panels" button at the end of the tab strip opens the same list as a menu, and the dock opens over the
 * whole screen. */

import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import { layers } from "../lib/layers.js";
import { openMenu } from "../lib/menu.js";
import * as registry from "../lib/registry.js";

const SQUARE = ["M4.5 4.5h11v11h-11z"];
const WIDEN = ["M7 6 3 10l4 4", "M13 6l4 4-4 4"];
const PANELS = ["M3.5 4.5h13v11h-13z", "M12 4.5v11"];
/** Where the rail remembers that it was widened: a property of this screen, not of the person. */
const WIDE_KEY = "thetis.rail.wide";

function storedWide() {
  try {
    return localStorage.getItem(WIDE_KEY) === "1";
  } catch {
    return false; // no storage: the narrow rail
  }
}

export function mountDock() {
  const rail = $("rail");
  const buttons = $("rail-tabs");
  const dock = $("dock");
  const title = dock.querySelector(".panel-title");
  const sub = dock.querySelector(".panel-sub");
  const actions = dock.querySelector(".panel-actions");
  const body = dock.querySelector(".panel-body");
  let open = null; // the open entry's key
  let wide = storedWide();

  const widen = el("button", { type: "button", class: "rail-btn rail-widen", onClick: () => setWide(!wide) }, icon(WIDEN, { size: 16, width: 1.6 }), el("span", { class: "rail-label" }, "Hide labels"));
  rail.append(el("div", { class: "rail-foot" }, widen));

  // The phone's way to the same list: a button at the end of the tab strip, shown by the stylesheet only
  // when the screen is narrow and only when there is something to list.
  const panelsBtn = el("button", { type: "button", id: "panels-btn", class: "icon-btn sm panels-btn", title: "Panels about this chat", "aria-label": "Panels", "aria-haspopup": "menu", hidden: true, onClick: () => openPanelsMenu() }, icon(PANELS, { size: 16, width: 1.6 }));
  $("tabs").append(panelsBtn);

  dock.querySelector(".panel-close").addEventListener("click", () => close());

  function setWide(on) {
    wide = on;
    try {
      localStorage.setItem(WIDE_KEY, on ? "1" : "0");
    } catch {
      /* not remembered */
    }
    drawRail();
  }

  /** The tooltip of a rail button: its label, then what it shows. */
  const tipOf = (entry, label) => {
    if (registry.failureOf(entry.package)) return `${label} — the ${entry.package} extension could not load`;
    return entry.decl.hint ? `${label} — ${entry.decl.hint}` : label;
  };

  function drawRail() {
    clear(buttons);
    const list = registry.entries("dock");
    setHidden(rail, !list.length);
    setHidden(panelsBtn, !list.length);
    rail.classList.toggle("is-wide", wide);
    widen.title = wide ? "Hide the labels" : "Show the labels";
    widen.setAttribute("aria-label", widen.title);
    widen.setAttribute("aria-pressed", String(wide));
    for (const entry of list) {
      const failed = registry.failureOf(entry.package);
      const label = entry.decl.label || entry.id;
      buttons.append(
        el(
          "button",
          { type: "button", class: `rail-btn${entry.key === open ? " is-active" : ""}${failed ? " is-broken" : ""}`, "data-dock": entry.key, title: tipOf(entry, label), "aria-label": label, "aria-pressed": entry.key === open ? "true" : "false", onClick: () => toggle(entry.key) },
          icon(entry.decl.icon || SQUARE, { size: 18, width: 1.6 }),
          el("span", { class: "rail-label", "aria-hidden": "true" }, label)
        )
      );
    }
  }

  function openPanelsMenu() {
    const items = registry.entries("dock").map((entry) => ({
      label: entry.decl.label || entry.id,
      hint: registry.failureOf(entry.package) ? "could not load" : entry.decl.hint,
      icon: entry.decl.icon || SQUARE,
      disabled: Boolean(registry.failureOf(entry.package)),
      run: () => show(entry.key),
    }));
    openMenu(panelsBtn, items);
  }

  function draw() {
    const entry = open && registry.entry("dock", open);
    if (!entry) return;
    clear(body);
    clear(actions);
    title.textContent = entry.decl.label || entry.id;
    sub.textContent = entry.decl.hint || "";
    if (!entry.impl?.draw) return body.append(registry.failureOf(entry.package) ? registry.broken(entry.package) : el("div", { class: "panel-empty" }, "Loading…"));
    const out = registry.guard(entry.package, "dock", entry.impl.draw);
    const view = out.ok && out.value && typeof out.value === "object" ? out.value : null;
    if (!view) return body.append(registry.broken(entry.package));
    if (view.title) title.textContent = view.title;
    sub.textContent = view.subtitle || "";
    if (view.body instanceof Node) body.append(view.body);
    for (const action of view.actions ?? []) if (action instanceof Node) actions.append(action);
  }

  function show(key) {
    const entry = registry.entry("dock", key);
    if (!entry) return;
    open = key;
    dock.classList.toggle("is-wide", Boolean(entry.decl.wide));
    draw();
    setHidden(dock, false);
    layers.open("dock", close);
    drawRail();
  }

  function close() {
    if (!open) return;
    open = null;
    setHidden(dock, true);
    layers.remove("dock");
    clear(body);
    drawRail();
  }

  const toggle = (key) => (open === key ? close() : show(key));

  registry.watch((change) => {
    if (change.kind === "declare" || change.kind === "fail") drawRail();
    if (!open) return;
    const entry = registry.entry("dock", open);
    if (change.kind === "register" && change.slot === "dock" && registry.keyOf(change.package, change.id) === open) draw();
    if (change.kind === "redraw" && change.package === entry.package && (!change.id || change.id === entry.id)) draw();
  });
  drawRail();

  return { open: show, close, toggle, current: () => open };
}
