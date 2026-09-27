/* A pill that opens a list. Used for the model choice in the composer. The menu opens upward by default
 * because the composer sits at the foot of the page; `drop: "down"` for a pill in a top bar. Arrow keys
 * move, Home/End jump, Enter picks, Escape closes and hands focus back to the pill.
 *
 * The list is either flat (`options()`) or in sections (`sections()`: `{ id, title, collapsible?, options }`),
 * each with a small heading. A collapsible section is folded behind one row that says its title ("All
 * models (458)") until that row is chosen or the filter has text. With sections, `filter(sections, query)`
 * says what a query keeps (default: one "Matches" section of every row that contains it). A row may carry
 * `cols` (`[{ text, title }]`), drawn right-aligned beside its label, and `selected` to say itself whether it
 * is the choice (default: its id equals `selected()`). */

import { el, icon, onClickOutside } from "./dom.js";

const CARET = ["M5 8l5 5 5-5"];
const CHEVRON = ["M7.5 5.5 12 10l-4.5 4.5"];
const MAX_ROWS = 200;

export class Picker {
  /**
   * @param {object} config
   * @param {() => { id: string, label: string, note?: string, cols?: object[], selected?: boolean }[]} [config.options]
   * @param {() => { id: string, title: string, collapsible?: boolean, options: object[] }[]} [config.sections]
   * @param {(sections: object[], query: string) => object[]} [config.filter]
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
    this.unfolded = new Set(); // collapsible sections opened while this menu is open
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

  /** The sections to draw: the configured ones, or the flat list as one untitled section. */
  sections() {
    if (this.config.sections) return this.config.sections();
    return [{ id: "", title: "", options: this.config.options() }];
  }

  /** How many rows there are to choose from, for whether a filter box is worth its line. */
  count() {
    return this.sections().reduce((n, s) => n + s.options.length, 0);
  }

  fill() {
    const query = (this.search?.value ?? "").trim().toLowerCase();
    const selected = this.config.selected();
    const list = this.list;
    const focused = document.activeElement?.dataset?.row ?? null;
    list.replaceChildren();
    let sections = this.sections();
    if (query) sections = this.config.filter ? this.config.filter(sections, query) : [{ id: "", title: "", options: sections.flatMap((s) => s.options).filter((o) => `${o.label} ${o.note ?? ""} ${o.id}`.toLowerCase().includes(query)) }];
    let shown = 0;
    for (const section of sections) {
      if (!section.options.length) continue;
      const folded = section.collapsible && !query && !this.unfolded.has(section.id);
      if (section.collapsible && !query) {
        list.append(el(
          "button",
          { type: "button", class: `picker-item picker-fold${folded ? "" : " is-open"}`, "aria-expanded": folded ? "false" : "true", "data-row": `fold:${section.id}`, onClick: (event) => { event.stopPropagation(); this.toggle(section.id); } },
          el("span", { class: "picker-item-label" }, icon(CHEVRON, { size: 10, width: 2 }), section.title)
        ));
      } else if (section.title) {
        list.append(el("div", { class: "picker-head", role: "presentation" }, section.title));
      }
      if (folded) continue;
      for (const option of section.options) {
        if (++shown > MAX_ROWS) break;
        const isSelected = option.selected ?? option.id === selected;
        list.append(
          el(
            "button",
            {
              type: "button",
              role: "option",
              class: `picker-item${isSelected ? " is-selected" : ""}${option.cols?.length ? " has-cols" : ""}`,
              "aria-selected": isSelected ? "true" : "false",
              "data-row": `${section.id}:${option.id}`,
              title: option.title ?? null,
              onClick: (event) => {
                event.stopPropagation();
                this.close();
                if (option.id !== selected) this.config.onSelect(option.id);
              },
            },
            el("span", { class: "picker-item-main" }, el("span", { class: "picker-item-label" }, option.label), option.note ? el("span", { class: "picker-item-note" }, option.note) : null),
            option.cols?.length ? el("span", { class: "picker-item-cols" }, ...option.cols.map((c) => el("span", { class: `picker-col is-${c.kind ?? "plain"}`, title: c.title ?? null }, c.text))) : null
          )
        );
      }
      if (shown > MAX_ROWS) {
        list.append(el("div", { class: "picker-empty" }, "More than 200: type to narrow the list."));
        break;
      }
    }
    if (!shown && !list.querySelector(".picker-fold")) list.append(el("div", { class: "picker-empty" }, query ? "Nothing matches." : "Nothing to choose from."));
    if (focused) list.querySelector(`[data-row="${CSS.escape(focused)}"]`)?.focus();
  }

  /** Opens or folds a collapsible section. */
  toggle(id) {
    const opening = !this.unfolded.has(id);
    if (opening) this.unfolded.add(id);
    else this.unfolded.delete(id);
    this.fill();
    // Opened, the fold goes to the top of the list so the rows it let out are the ones in view.
    if (opening) this.list.querySelector(`[data-row="fold:${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.unfolded.clear();
    const down = this.config.drop === "down";
    this.list = el("div", { class: "picker-list" });
    this.search = this.config.searchable && this.count() > 12
      ? el("input", { class: "picker-search", type: "search", placeholder: "Filter…", "aria-label": "Filter the list", autocomplete: "off", spellcheck: "false", onInput: () => this.fill() })
      : null;
    this.menu = el("div", { class: `picker-menu${down ? " drops-down" : ""}`, role: "listbox", onKeydown: (event) => this.navigate(event) }, this.search, this.list);
    this.fill();
    this.node.append(this.menu);
    this.node.classList.add("is-open");
    this.button.setAttribute("aria-expanded", "true");
    this.stop = onClickOutside(this.menu, () => this.close());
    // Kept inside the window: on a phone the pill sits part-way along the composer, and a list as wide as
    // the screen hung from it would push the page sideways. Through the CSSOM, which the page's policy allows.
    const box = this.menu.getBoundingClientRect();
    const over = box.right - (window.innerWidth - 8);
    if (over > 0) this.menu.style.setProperty("left", `${-Math.min(over, box.left - 8)}px`);
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
