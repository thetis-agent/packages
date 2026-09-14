/* A pill that opens a list. Used for the model choice in the composer. The menu opens upward by default
 * because the composer sits at the foot of the page; `drop: "down"` for a pill in a top bar. Arrow keys
 * move, Home/End jump, Enter picks, Escape closes and hands focus back to the pill. */

import { el, icon, onClickOutside } from "./dom.js";

const CARET = ["M5 8l5 5 5-5"];

export class Picker {
  /**
   * @param {object} config
   * @param {() => { id: string, label: string, note?: string }[]} config.options
   * @param {() => string} config.selected
   * @param {(id: string) => void} config.onSelect
   * @param {() => string} config.label       what the pill says
   * @param {string} [config.title]
   * @param {"up"|"down"} [config.drop]
   * @param {boolean} [config.mono]
   * @param {boolean} [config.searchable]   adds a filter box when the list is long
   */
  constructor(config) {
    this.config = config;
    this.open = false;
    this.stop = null;
    this.menu = null;
    this.labelEl = el("span", { class: `picker-label${config.mono ? " mono" : ""}` });
    this.button = el(
      "button",
      { type: "button", class: "picker-btn", title: config.title, "aria-haspopup": "listbox", "aria-expanded": "false", onClick: () => (this.open ? this.close() : this.show()) },
      el("span", { class: "picker-dot" }),
      this.labelEl,
      icon(CARET, { size: 10, width: 2 })
    );
    this.button.querySelector("svg").classList.add("caret");
    this.node = el("div", { class: "picker" }, this.button);
    this.draw();
  }

  draw() {
    this.labelEl.textContent = this.config.label();
    if (this.open) this.fill();
  }

  items() {
    return [...this.menu.querySelectorAll(".picker-item")];
  }

  fill() {
    const query = (this.search?.value ?? "").trim().toLowerCase();
    const selected = this.config.selected();
    const list = this.list;
    list.replaceChildren();
    let shown = 0;
    for (const option of this.config.options()) {
      if (query && !`${option.label} ${option.note ?? ""} ${option.id}`.toLowerCase().includes(query)) continue;
      if (++shown > 200) break;
      list.append(
        el(
          "button",
          {
            type: "button",
            role: "option",
            class: `picker-item${option.id === selected ? " is-selected" : ""}`,
            "aria-selected": option.id === selected ? "true" : "false",
            onClick: (event) => {
              event.stopPropagation();
              this.close();
              if (option.id !== selected) this.config.onSelect(option.id);
            },
          },
          el("span", { class: "picker-item-label" }, option.label),
          option.note ? el("span", { class: "picker-item-note" }, option.note) : null
        )
      );
    }
    if (!shown) list.append(el("div", { class: "picker-empty" }, query ? "Nothing matches." : "Nothing to choose from."));
  }

  show() {
    if (this.open) return;
    this.open = true;
    const down = this.config.drop === "down";
    this.list = el("div", { class: "picker-list" });
    this.search = this.config.searchable && this.config.options().length > 12
      ? el("input", { class: "picker-search", type: "search", placeholder: "Filter…", "aria-label": "Filter the list", autocomplete: "off", spellcheck: "false", onInput: () => this.fill() })
      : null;
    this.menu = el("div", { class: `picker-menu${down ? " drops-down" : ""}`, role: "listbox", onKeydown: (event) => this.navigate(event) }, this.search, this.list);
    this.fill();
    this.node.append(this.menu);
    this.node.classList.add("is-open");
    this.button.setAttribute("aria-expanded", "true");
    this.stop = onClickOutside(this.menu, () => this.close());
    const target = this.search ?? this.menu.querySelector(".picker-item.is-selected") ?? this.items()[0];
    target?.focus();
    if (!this.search) this.menu.querySelector(".picker-item.is-selected")?.scrollIntoView({ block: "nearest" });
  }

  close() {
    if (!this.open) return;
    const inside = this.menu.contains(document.activeElement);
    this.stop?.();
    this.stop = null;
    this.menu.remove();
    this.menu = null;
    this.search = null;
    this.open = false;
    this.node.classList.remove("is-open");
    this.button.setAttribute("aria-expanded", "false");
    if (inside) this.button.focus();
  }

  navigate(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      return this.close();
    }
    const items = this.items();
    if (!items.length) return;
    const inSearch = event.target === this.search;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step && !((event.key === "Home" || event.key === "End") && !inSearch)) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next]?.focus();
    items[next]?.scrollIntoView({ block: "nearest" });
  }
}
