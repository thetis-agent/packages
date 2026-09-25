/* A popup menu, the shape of the shell's places menu: `div.menu[role=menu]` of `button.menu-item
 * [role=menuitem]` rows, arrow keys that wrap, Home and End, Escape and a click elsewhere to close. The
 * shell will lift its own into `ext.ui.menu`; until it does, this module draws one itself, appended to
 * `document.body` and kept inside the viewport, positioned below an anchor element or at a right-click
 * point. One menu at a time: opening another closes the first. Escape is caught on the capture phase and
 * stopped, so the place under the menu does not close with it (`views/places.js` also checks for `.menu`
 * before it acts). `setExt(ext)` hands the module the seam once, from `install`.
 *
 * Items are `{ label, icon?, key?, hint?, danger?, disabled?, run, hintLater? }` or `"-"`. `hintLater()`
 * is a promise of the hint text, filled in after the menu is drawn (the zip size). */

let ext = null;
let current = null; // { node, close }

export function setExt(seam) {
  ext = seam;
}

export function closeMenu() {
  current?.close(false);
}

export function openMenu(at, items, { onClose } = {}) {
  if (ext?.ui?.menu && typeof ext.ui.menu === "function") {
    const out = ext.ui.menu(at, items, { onClose });
    // The shell draws `hint` once and knows nothing of `hintLater`: fill those rows in when the
    // promise answers, finding each by its label in the floating menu the shell appended.
    for (const item of items) {
      if (!item || typeof item.hintLater !== "function") continue;
      Promise.resolve()
        .then(() => item.hintLater())
        .then((text) => {
          const rows = document.querySelectorAll(".menu.is-floating .menu-item");
          const row = [...rows].find((r) => r.querySelector(".menu-label")?.textContent === item.label);
          if (!row) return;
          let hint = row.querySelector(".menu-hint");
          if (!hint && text) {
            hint = ext.dom.el("span", { class: "menu-hint" });
            (row.querySelector(".menu-text") ?? row).append(hint);
          }
          if (hint) hint.textContent = text || "";
        })
        .catch(() => {});
    }
    if (typeof out === "function") return out;
    if (out && typeof out.close === "function") return () => out.close();
    return () => {};
  }
  return local(at, items, { onClose });
}

function local(at, items, { onClose } = {}) {
  if (!ext) throw new Error("the workspace menu was opened before install(ext) ran.");
  const { el, icon } = ext.dom;
  closeMenu();

  let open = true;
  const rows = [];
  for (const item of items) {
    if (item === "-") {
      rows.push(el("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if (!item) continue;
    const hint = el("span", { class: "menu-hint" }, item.hint ?? "");
    const row = el(
      "button",
      {
        type: "button",
        role: "menuitem",
        class: `menu-item${item.danger ? " is-danger" : ""}`,
        disabled: item.disabled ? true : null,
        onClick: (event) => {
          event.stopPropagation();
          if (item.disabled) return;
          close(false);
          try {
            item.run?.();
          } catch (err) {
            console.error("a workspace menu item threw:", err);
          }
        },
      },
      el("span", { class: "menu-icon" }, item.icon ? icon(item.icon, { size: 16, width: 1.6 }) : null),
      el("span", { class: "menu-text" }, el("span", { class: "menu-label" }, item.label), item.hint || item.hintLater ? hint : null),
      item.key ? el("span", { class: "menu-key" }, item.key) : null
    );
    rows.push(row);
    if (typeof item.hintLater === "function") {
      Promise.resolve()
        .then(() => item.hintLater())
        .then((text) => {
          if (open) hint.textContent = text ?? "";
        })
        .catch(() => {
          if (open) hint.textContent = "";
        });
    }
  }

  const node = el("div", { class: "menu ws-menu", role: "menu", tabindex: "-1", onKeydown: navigate }, rows.length ? rows : el("div", { class: "menu-empty" }, "Nothing to do here."));
  document.body.append(node);
  place(node, at);

  const items$ = () => [...node.querySelectorAll(".menu-item:not(:disabled)")];

  function navigate(event) {
    const list = items$();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      list[event.key === "Home" ? 0 : list.length - 1].focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    close(true);
  }

  function onPointer(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(node) || node.contains(event.target)) return;
    close(false);
  }

  const onResize = () => close(false);

  function close(refocus) {
    if (!open) return;
    open = false;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("contextmenu", onPointer, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("blur", onResize);
    node.remove();
    if (current?.node === node) current = null;
    if (refocus && at instanceof Element) at.focus?.();
    try {
      onClose?.();
    } catch (err) {
      console.error("a workspace menu onClose threw:", err);
    }
  }

  document.addEventListener("keydown", onKey, true);
  // Deferred a tick, so the click or contextmenu that opened the menu does not close it on the way up.
  setTimeout(() => {
    if (!open) return;
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("contextmenu", onPointer, true);
  }, 0);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onResize);

  current = { node, close };
  (items$()[0] ?? node).focus();
  return () => close(false);
}

/** Puts the menu below the anchor (or at the point) and pulls it back inside the viewport. */
function place(node, at) {
  const margin = 8;
  let x;
  let y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else {
    x = Number(at?.x) || 0;
    y = Number(at?.y) || 0;
  }
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + w > vw - margin) x = Math.max(margin, vw - w - margin);
  if (y + h > vh - margin) {
    const above = at instanceof Element ? at.getBoundingClientRect().top - h - 4 : y - h;
    y = above >= margin ? above : Math.max(margin, vh - h - margin);
  }
  node.style.setProperty("--ws-menu-x", `${Math.round(x)}px`);
  node.style.setProperty("--ws-menu-y", `${Math.round(y)}px`);
}
