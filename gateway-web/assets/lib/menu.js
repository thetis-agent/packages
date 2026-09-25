/* A floating menu, the shape of the places menu in the sidebar head: `div.menu[role=menu]` of
 * `button.menu-item[role=menuitem]` rows, the arrow keys wrapping, Home and End, Enter or Space to choose,
 * Escape and a click elsewhere to close. This one is appended to `document.body` and placed below an
 * element (flipped above it when the bottom of the window is in the way) or at a point (a right-click),
 * always pulled back inside the viewport. It is what a package gets as `ext.ui.menu`, so a file's menu
 * and a row's ⋯ read as the shell's own. One menu at a time: opening another closes the first. Escape is
 * caught on the capture phase and stopped, exactly as `views/menu.js` does, so `#place` and the dock do
 * not close under it — they also check for `.menu` before they act. `moveFocus` is the keyboard walk both
 * menus share.
 *
 * Items are `{ label, icon?, key?, hint?, danger?, disabled?, run }` or `"-"` for a rule. `icon` is a path
 * or list of paths for `dom.icon`; `key` is the shortcut shown after the label, `hint` a second line. */

import { el, icon, onClickOutside } from "./dom.js";

let current = null; // the close function of the open menu, or null

/**
 * ArrowUp and ArrowDown move the focus through `list` and wrap; Home and End go to the ends. Answers true
 * when the key was one of those, with the event's default already prevented.
 */
export function moveFocus(list, event) {
  if (!list.length) return false;
  const at = list.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    list[(at + step + list.length) % list.length].focus();
    return true;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    list[event.key === "Home" ? 0 : list.length - 1].focus();
    return true;
  }
  return false;
}

/**
 * Opens the menu at `at` — an Element, or `{ x, y }` in viewport pixels — and answers its close function.
 * `onClose()` runs once, however the menu went. The first enabled item takes the focus; when `at` is an
 * element it gets the focus back on Escape or a choice, and keeps it where the click landed otherwise.
 */
export function openMenu(at, items, { onClose } = {}) {
  current?.();
  let open = true;
  const anchor = at instanceof Element ? at : null;
  const rows = [];
  const runs = new Map(); // row -> its item, for Enter and Space

  function choose(row) {
    const item = runs.get(row);
    if (!open || !item || item.disabled) return;
    close(true);
    try {
      item.run?.();
    } catch (err) {
      console.error("a menu item threw:", err);
    }
  }

  for (const item of items ?? []) {
    if (item === "-") {
      rows.push(el("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if (!item) continue;
    const row = el(
      "button",
      { type: "button", role: "menuitem", class: `menu-item${item.danger ? " is-danger" : ""}`, disabled: item.disabled ? true : null, onClick: (event) => { event.stopPropagation(); choose(row); } },
      el("span", { class: "menu-icon" }, item.icon ? icon(item.icon, { size: 16, width: 1.6 }) : null),
      el(
        "span",
        { class: "menu-text" },
        el("span", { class: "menu-label" }, item.label ?? ""),
        item.key ? el("span", { class: "menu-key" }, item.key) : null,
        item.hint ? el("span", { class: "menu-hint" }, item.hint) : null
      )
    );
    runs.set(row, item);
    rows.push(row);
  }

  const enabled = () => rows.filter((row) => runs.has(row) && !runs.get(row).disabled);

  function onMenuKey(event) {
    if (moveFocus(enabled(), event)) return;
    if ((event.key === "Enter" || event.key === " ") && runs.has(event.target)) {
      event.preventDefault(); // the button's own click would choose it a second time, after the menu is gone
      choose(event.target);
    } else if (event.key === "Tab") close(false);
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    close(true);
  }

  const node = el("div", { class: "menu is-floating", role: "menu", tabindex: "-1", onKeydown: onMenuKey }, rows.length ? rows : el("div", { class: "menu-empty" }, "Nothing to do here."));
  document.body.append(node);
  place(node, at);

  const release = onClickOutside(node, () => close(false));
  document.addEventListener("keydown", onKey, true);

  function close(refocus) {
    if (!open) return;
    open = false;
    release();
    document.removeEventListener("keydown", onKey, true);
    node.remove();
    if (current === close) current = null;
    if (refocus && anchor) anchor.focus?.();
    try {
      onClose?.();
    } catch (err) {
      console.error("a menu's onClose threw:", err);
    }
  }

  current = close;
  (enabled()[0] ?? node).focus();
  return () => close(true);
}

/** Below the anchor, or at the point; flipped above the anchor when the bottom is in the way; inside the viewport always. */
function place(node, at) {
  const margin = 8;
  const gap = 4;
  const rect = at instanceof Element ? at.getBoundingClientRect() : null;
  let x = rect ? rect.left : Number(at?.x) || 0;
  let y = rect ? rect.bottom + gap : Number(at?.y) || 0;
  const w = node.offsetWidth || 0;
  const h = node.offsetHeight || 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + w > vw - margin) x = Math.max(margin, vw - w - margin);
  if (y + h > vh - margin) {
    const above = rect ? rect.top - gap - h : y - h;
    y = above >= margin ? above : Math.max(margin, vh - h - margin);
  }
  node.style.left = `${Math.round(Math.max(margin, x))}px`;
  node.style.top = `${Math.round(Math.max(margin, y))}px`;
}
