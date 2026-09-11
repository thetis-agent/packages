/* A small dropdown: a pill with a menu.
 *
 * Generic on purpose: give it options and a change handler and it renders a
 * pill with a menu. Two of them sit in the composer (views/composer.js) — how
 * much a conversation may do, and which model answers it — and both are drawn
 * from what the environment said it offers rather than from anything this page
 * decided.
 *
 * The menu opens *upward* by default, because every picker there is today sits
 * in the composer at the foot of the screen. A picker in a bar at the top of a
 * pane needs the opposite, and gets it with `drop: "down"` — without that the
 * menu is drawn off the top of the viewport and none of its options can be
 * clicked. Opt-in rather than measured: which way a menu opens is a property of
 * where the pill lives, and the caller knows that without a layout read.
 *
 * The keyboard is a first-class way in, not an afterthought: the pill is a
 * button so Tab reaches it and Enter opens it, Down opens it too and lands on
 * the option already chosen, Up and Down walk the list, and Escape closes and
 * puts focus back where it was. That last part is why `close` is careful about
 * focus at all — the menu is rebuilt on every open and close, so a naive redraw
 * would drop focus on the body and strand somebody who never touched a mouse.
 */

import { clear, el, icon, onClickOutside } from "../lib/dom.js";

const CARET = "M5 8l5 5 5-5";

export class Picker {
  /**
   * @param {HTMLElement} mount
   * @param {object} config
   * @param {() => Array<{id, label, note?}>} config.options
   * @param {() => string} config.selected   currently selected id
   * @param {(id: string) => void} config.onSelect
   * @param {(selected) => string} config.render  text shown on the pill
   * @param {(selected) => string} [config.dotClass]  extra class for the dot
   * @param {boolean} [config.mono]  draw the pill's text in the monospace face
   * @param {string} [config.label]  what the pill is, for a screen reader
   * @param {"up"|"down"} [config.drop]  which way the menu opens; up by default
   */
  constructor(mount, config) {
    this.mount = mount;
    this.config = config;
    this.open = false;
    this.dispose = null;
    this.button = null;
    this.draw();
  }

  draw() {
    const selectedId = this.config.selected();
    const label = this.config.render(selectedId);

    const button = el(
      "button",
      {
        type: "button",
        class: "picker-btn",
        title: this.config.title || label,
        "aria-haspopup": "listbox",
        "aria-expanded": this.open ? "true" : "false",
        ...(this.config.label ? { "aria-label": `${this.config.label}: ${label}` } : {}),
        onClick: (event) => {
          event.stopPropagation();
          this.toggle();
        },
        onKeydown: (event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!this.open) this.show();
        },
      },
      el("span", { class: `picker-dot ${this.config.dotClass?.(selectedId) || ""}` }),
      el("span", { class: `picker-label${this.config.mono ? " mono" : ""}` }, label),
      (() => {
        const caret = icon(CARET, { size: 9 });
        caret.classList.add("caret");
        return caret;
      })()
    );

    this.button = button;
    clear(this.mount).append(button);
    this.mount.className = `picker${this.open ? " is-open" : ""}`;
    if (this.open) this.mount.append(this.menu(selectedId));
  }

  menu(selectedId) {
    const items = this.config.options().map((option) =>
      el(
        "button",
        {
          type: "button",
          role: "option",
          "aria-selected": option.id === selectedId ? "true" : "false",
          class: `picker-item${option.id === selectedId ? " is-selected" : ""}`,
          onClick: (event) => {
            event.stopPropagation();
            this.close();
            if (option.id !== selectedId) this.config.onSelect(option.id);
          },
        },
        el("div", { class: "picker-item-label" }, option.label),
        option.note && el("div", { class: "picker-item-note" }, option.note)
      )
    );

    const down = this.config.drop === "down";
    return el(
      "div",
      {
        class: `picker-menu${down ? " drops-down" : ""}`,
        role: "listbox",
        ...(this.config.label ? { "aria-label": this.config.label } : {}),
        // Bound to the menu rather than to the document so it never has to be
        // taken off again: the menu is thrown away every time it closes.
        onKeydown: (event) => this.navigate(event, items),
      },
      items
    );
  }

  /** Up, Down, Home and End walk the options; Escape gives up and goes back to the pill. */
  navigate(event, items) {
    if (event.key === "Escape") { event.stopPropagation(); this.close(); return; }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (at + step + items.length) % items.length;
    items[next]?.focus();
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.open = true;
    this.draw();
    // The option already chosen is where the keyboard starts, so the first
    // press moves off the current answer rather than from nowhere.
    const items = [...this.mount.querySelectorAll(".picker-item")];
    (items.find((item) => item.classList.contains("is-selected")) ?? items[0])?.focus();
    this.dispose = onClickOutside(this.mount, () => this.close());
  }

  close() {
    if (!this.open) return;
    // Focus is only taken back if it was inside the menu about to be thrown
    // away: closing because a click landed elsewhere must not steal it from
    // wherever it landed.
    const returning = this.mount.contains(document.activeElement);
    this.open = false;
    this.dispose?.();
    this.dispose = null;
    this.draw();
    if (returning) this.button.focus();
  }

  /** Re-renders in place, e.g. after the selection changed elsewhere. */
  refresh() {
    if (!this.open) this.draw();
  }
}
