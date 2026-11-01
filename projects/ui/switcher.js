/* The project switcher in the sidebar's head slot: a row "PROJECT <name>" with a caret that opens a
 * list: each project with how many conversations it holds (and "n working" with a dot while any runs),
 * No project with its count, then Project settings for the current project and New project…. Picking one
 * enters that space: the shell swaps the sidebar list, the tabs and the draft. The list closes on a pick,
 * on Escape, and on a click elsewhere; arrow keys move between items. Everything is built with
 * `ext.dom.el`; the shell's tokens and the `.pj-` rules in index.css do the drawing. */

const CARET = ["M5 8l5 5 5-5"];
const PLACE = "project";

export function mountSwitcher(ext, state, root) {
  const { el, icon, clear } = ext.dom;
  let menu = null;
  let stopOutside = null;

  const name = el("span", { class: "pj-head-name" });
  // Something runs in a space you are not in: its tabs are parked, so the switcher is where that shows.
  const dot = el("span", { class: "pj-working-dot", title: "Working in another project", hidden: true });
  const button = el(
    "button",
    { type: "button", class: "pj-head-btn", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Choose a project", onClick: () => (menu ? close() : open()) },
    el("span", { class: "pj-head-label" }, "Project"),
    name,
    dot,
    icon(CARET, { size: 10, width: 2 })
  );
  button.querySelector("svg").classList.add("pj-caret");
  const node = el("div", { class: "pj-head" }, button);
  root.append(node);

  function label() {
    const project = state.chosen ? state.project(state.chosen) : null;
    name.textContent = project ? project.name : state.chosen && !state.known ? "" : "No project";
    node.classList.toggle("is-chosen", Boolean(project));
    const elsewhere = [...state.projects.map((p) => p.id), null].some((id) => id !== state.chosen && state.working(id) > 0);
    dot.hidden = !elsewhere;
  }

  /** "3 conversations", or "3 conversations · 2 working" while some of them run. */
  function noteFor(id) {
    const n = state.count(id);
    const busy = state.working(id);
    return `${n} ${n === 1 ? "conversation" : "conversations"}${busy ? ` · ${busy} working` : ""}`;
  }

  function item(text, { note, selected, onPick, tone, busy } = {}) {
    return el(
      "button",
      {
        type: "button",
        role: "option",
        class: `pj-item${selected ? " is-selected" : ""}${tone ? ` is-${tone}` : ""}${busy ? " is-working" : ""}`,
        "aria-selected": selected ? "true" : "false",
        onClick: (event) => {
          event.stopPropagation();
          close();
          onPick();
        },
      },
      el("span", { class: "pj-item-label" }, busy ? el("span", { class: "pj-working-dot", "aria-hidden": "true" }) : null, text),
      note ? el("span", { class: "pj-item-note" }, note) : null
    );
  }

  function fill() {
    clear(menu);
    const chosen = state.chosen;
    for (const p of state.projects) {
      menu.append(item(p.name, { note: noteFor(p.id), selected: p.id === chosen, busy: state.working(p.id) > 0, onPick: () => state.enter(p.id) }));
    }
    menu.append(item("No project", { note: noteFor(null), selected: !chosen, busy: state.working(null) > 0, onPick: () => state.enter(null) }));
    menu.append(el("div", { class: "pj-menu-rule" }));
    if (chosen && state.project(chosen)) menu.append(item("Project settings", { note: state.project(chosen).name, onPick: () => ext.open.place(PLACE, { id: chosen }) }));
    menu.append(item("New project…", { onPick: () => ext.open.place(PLACE, { new: true }) }));
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
