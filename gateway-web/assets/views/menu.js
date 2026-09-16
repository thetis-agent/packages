/* The menu: the ≡ button in the sidebar head. It lists the places (Control panel, Marketplace, Project,
 * and whatever else a package declares under `places`), drawn from the registry so an entry exists before
 * its package's module has loaded; a package that failed to load leaves a struck-through item. The open
 * place is marked. The menu closes on a choice, on Escape, or on a click elsewhere, and redraws itself when
 * a declaration arrives while it is open. The skeleton adds nothing of its own: the control panel is a
 * place like any other. */

import { $, el, icon, onClickOutside } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

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
        title: failed ? `${entry.package} could not load` : null,
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
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1].focus();
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    }
  }

  function open() {
    if (menu) return;
    const list = registry.entries("places").map(item);
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
