/* The menu: the ≡ button in the sidebar head. It lists the places (Files, Extensions, Workflows, Project,
 * the Control panel, and whatever else a package declares under `places`), drawn from the registry so an
 * entry exists before its package's module has loaded; a package that failed to load leaves a
 * struck-through item. Each item shows its label and its one-line hint in full. The open place is marked.
 * The menu closes on a choice, on Escape, or on a click elsewhere, and redraws itself when a declaration
 * arrives while it is open. The skeleton adds nothing of its own: the control panel is a place like any
 * other, and it comes last, because it is where a person goes least often.
 *
 * The reading order is `menuOrder`: the everyday places first in the order a person reaches for them —
 * the files, the extensions, the workflows, the project — then any other place by its declared order,
 * then the control panel. A place's own `order` still sorts everything that is not named here. */

import { $, el, icon, onClickOutside } from "../lib/dom.js";
import { moveFocus } from "../lib/menu.js";
import * as registry from "../lib/registry.js";

/** The place ids the menu puts first, in this order; each is the id its package declares. */
export const EVERYDAY_PLACES = ["workspace", "marketplace", "workflows", "project"];

/** The places in the menu's reading order: the everyday ones, the rest by declared order, the control panel last. */
export function menuOrder(entries) {
  const rank = (entry) => {
    if (entry.package === registry.BUILTIN && entry.id === "panel") return 1000;
    const at = EVERYDAY_PLACES.indexOf(entry.id);
    return at >= 0 ? at - 100 : 0;
  };
  // Stable: entries arrive sorted by declared order, and a tie keeps that order.
  return entries.map((entry, at) => ({ entry, at })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.at - b.at).map(({ entry }) => entry);
}

export function mountMenu({ openPlace, currentPlace }) {
  const button = $("menu");
  const head = button.closest(".sidebar-head");
  let menu = null;
  let release = null;

  function item(entry) {
    const failed = registry.failureOf(entry.package);
    const label = entry.decl.label || entry.id;
    const active = currentPlace() === entry.key;
    return el(
      "button",
      {
        type: "button",
        role: "menuitem",
        class: `menu-item${failed ? " is-broken" : ""}${active ? " is-active" : ""}`,
        "data-place": entry.key,
        title: failed ? `The ${entry.package} extension could not load` : null,
        "aria-current": active ? "page" : null,
        onClick: () => {
          close(false);
          openPlace(entry.key);
        },
      },
      el("span", { class: "menu-icon" }, entry.decl.icon ? icon(entry.decl.icon, { size: 16, width: 1.6 }) : null),
      el("span", { class: "menu-text" }, el("span", { class: "menu-label" }, label), entry.decl.hint ? el("span", { class: "menu-hint" }, entry.decl.hint) : null)
    );
  }

  function items() {
    return menu ? [...menu.querySelectorAll(".menu-item")] : [];
  }

  function navigate(e) {
    moveFocus(items(), e);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    }
  }

  function open() {
    if (menu) return;
    const list = menuOrder(registry.entries("places")).map(item);
    menu = el("div", { class: "menu", role: "menu", "aria-label": "Menu", onKeydown: navigate }, list.length ? list : el("div", { class: "menu-empty" }, "Nothing to open yet."));
    head.append(menu);
    head.classList.add("is-menu-open");
    button.setAttribute("aria-expanded", "true");
    release = onClickOutside(menu, (e) => {
      if (!button.contains(e.target)) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    (menu.querySelector(".menu-item.is-active") || menu.querySelector(".menu-item"))?.focus();
  }

  function close(refocus) {
    if (!menu) return;
    release?.();
    release = null;
    document.removeEventListener("keydown", onKey, true);
    menu.remove();
    menu = null;
    head.classList.remove("is-menu-open");
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  }

  button.addEventListener("click", () => (menu ? close(true) : open()));
  registry.watch((change) => {
    if (menu && (change.kind === "declare" || change.kind === "fail")) {
      close(false);
      open();
    }
  });
  return { open, close: () => close(false), isOpen: () => menu !== null };
}
