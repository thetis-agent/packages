/* The rail and the dock. The rail is the vertical strip of 32×32 buttons beside the main pane, one per
 * declared dock entry in declaration order, drawn before the package's module loads so a failed load
 * leaves a named button, not a gap. Clicking a button opens the dock on that entry: a header (title,
 * subtitle, actions, ✕) over a body the package's `draw()` answers; 360px wide, 620px for `wide`.
 * The active button, the ✕, or Escape closes it. The chat reflows beside it; nothing is modal. The rail
 * itself is hidden until something declares a dock entry, so a page without extensions looks as before. */

import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
const SQUARE = ["M4.5 4.5h11v11h-11z"];

export function mountDock() {
  const rail = $("rail");
  const buttons = $("rail-tabs");
  const dock = $("dock");
  const title = dock.querySelector(".panel-title");
  const sub = dock.querySelector(".panel-sub");
  const actions = dock.querySelector(".panel-actions");
  const body = dock.querySelector(".panel-body");
  let open = null; // the open entry's key

  dock.querySelector(".panel-close").addEventListener("click", () => close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open && !$("app").classList.contains("is-place") && !document.querySelector(".popover, .menu")) close();
  });

  function drawRail() {
    clear(buttons);
    const list = registry.entries("dock");
    setHidden(rail, !list.length);
    for (const entry of list) {
      const failed = registry.failureOf(entry.package);
      const label = entry.decl.label || entry.id;
      buttons.append(
        el(
          "button",
          { type: "button", class: `rail-btn${entry.key === open ? " is-active" : ""}${failed ? " is-broken" : ""}`, "data-dock": entry.key, title: failed ? `${label} — ${entry.package} could not load` : entry.decl.hint || label, "aria-label": label, "aria-pressed": entry.key === open ? "true" : "false", onClick: () => toggle(entry.key) },
          icon(entry.decl.icon || SQUARE, { size: 18, width: 1.6 })
        )
      );
    }
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
    drawRail();
  }

  function close() {
    if (!open) return;
    open = null;
    setHidden(dock, true);
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
