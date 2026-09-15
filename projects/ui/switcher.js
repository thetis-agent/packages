/* The project switcher in the sidebar's head slot: a row "PROJECT <name>" with a caret that opens a
 * list: All conversations, each project with how many conversations it holds, New project…, and for the
 * chosen project a Settings item. Choosing narrows the sidebar; All clears it. The list closes on a
 * pick, on Escape, and on a click elsewhere; arrow keys move between items. Everything is built with
 * `ext.dom.el`; the shell's tokens and the `.pj-` rules in index.css do the drawing. */

const CARET = ["M5 8l5 5 5-5"];
const PLACE = "project";

export function mountSwitcher(ext, state, root) {
  const { el, icon, clear } = ext.dom;
  let menu = null;
  let stopOutside = null;

  const name = el("span", { class: "pj-head-name" });
  const button = el(
    "button",
    { type: "button", class: "pj-head-btn", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Choose a project", onClick: () => (menu ? close() : open()) },
    el("span", { class: "pj-head-label" }, "Project"),
    name,
    icon(CARET, { size: 10, width: 2 })
  );
  button.querySelector("svg").classList.add("pj-caret");
  const node = el("div", { class: "pj-head" }, button);
  root.append(node);

  function label() {
    const project = state.chosen ? state.project(state.chosen) : null;
    name.textContent = project ? project.name : "All conversations";
    node.classList.toggle("is-chosen", Boolean(project));
  }

  function item(text, { note, selected, onPick, tone } = {}) {
    return el(
      "button",
      {
        type: "button",
        role: "option",
        class: `pj-item${selected ? " is-selected" : ""}${tone ? ` is-${tone}` : ""}`,
        "aria-selected": selected ? "true" : "false",
        onClick: (event) => {
          event.stopPropagation();
          close();
          onPick();
        },
      },
      el("span", { class: "pj-item-label" }, text),
      note ? el("span", { class: "pj-item-note" }, note) : null
    );
  }

  function fill() {
    clear(menu);
    const chosen = state.chosen;
    menu.append(item("All conversations", { selected: !chosen, onPick: () => state.choose(null) }));
    for (const p of state.projects) {
      const n = p.conversations;
      menu.append(item(p.name, { note: `${n} ${n === 1 ? "conversation" : "conversations"}`, selected: p.id === chosen, onPick: () => state.choose(p.id) }));
    }
    menu.append(el("div", { class: "pj-menu-rule" }));
    if (chosen && state.project(chosen)) menu.append(item("Settings", { note: state.project(chosen).name, onPick: () => ext.open.place(PLACE, { id: chosen }) }));
    menu.append(item("New project…", { onPick: () => ext.open.place(PLACE, {}) }));
  }

  function items() {
    return [...menu.querySelectorAll(".pj-item")];
  }

  function navigate(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      button.focus();
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const list = items();
    const at = list.indexOf(document.activeElement);
    list[(at + step + list.length) % list.length]?.focus();
  }

  function open() {
    if (menu) return;
    menu = el("div", { class: "pj-menu", role: "listbox", "aria-label": "Projects", onKeydown: navigate });
    fill();
    node.append(menu);
    node.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    const listener = (event) => {
      if (!node.contains(event.target)) close();
    };
    setTimeout(() => document.addEventListener("click", listener), 0);
    stopOutside = () => document.removeEventListener("click", listener);
    (menu.querySelector(".pj-item.is-selected") ?? items()[0])?.focus();
    state.refresh();
  }

  function close() {
    if (!menu) return;
    stopOutside?.();
    stopOutside = null;
    menu.remove();
    menu = null;
    node.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  }

  const unwatch = state.watch(() => {
    label();
    if (!menu) return;
    const hadFocus = menu.contains(document.activeElement);
    fill();
    if (hadFocus) (menu.querySelector(".pj-item.is-selected") ?? items()[0])?.focus();
  });
  label();

  return () => {
    close();
    unwatch();
    node.remove();
  };
}
