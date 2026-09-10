/* A small dropdown: a pill with a menu.
 *
 * Generic on purpose: give it options and a change handler and it renders a
 * pill with a menu. It is lifted from the legacy surface unchanged in behaviour
 * because the affordances that will use it are lifted too — the parity record
 * (§3.2) names three, and all three are downstream of a decision about where
 * model and mode actually live in this runtime (a profile field changed through
 * the generation machine, ADR 0012 §1, rather than a per-conversation frame the
 * way legacy had it). It therefore lands here with no caller yet: the surface
 * this wire speaks carries no mode, model or revision to pick between. Nothing
 * imports it until that decision is taken, and it is deliberately kept
 * dependency-free of anything but lib/dom.js so it cannot rot in the meantime.
 *
 * The menu opens *upward* by default, because every picker there was when this
 * was written sits in the composer at the foot of the screen. A picker in a bar
 * at the top of a pane needs the opposite, and gets it with `drop: "down"` —
 * without that the menu is drawn off the top of the viewport and none of its
 * options can be clicked. Opt-in rather than measured: which way a menu opens is
 * a property of where the pill lives, and the caller knows that without a
 * layout read.
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
   * @param {"up"|"down"} [config.drop]  which way the menu opens; up by default
   */
  constructor(mount, config) {
    this.mount = mount;
    this.config = config;
    this.open = false;
    this.dispose = null;
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
        onClick: (event) => {
          event.stopPropagation();
          this.toggle();
        },
      },
      el("span", { class: `picker-dot ${this.config.dotClass?.(selectedId) || ""}` }),
      el("span", { class: "picker-label" }, label),
      (() => {
        const caret = icon(CARET, { size: 9 });
        caret.classList.add("caret");
        return caret;
      })()
    );

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
    return el("div", { class: `picker-menu${down ? " drops-down" : ""}`, role: "listbox" }, items);
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.open = true;
    this.draw();
    this.dispose = onClickOutside(this.mount, () => this.close());
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.dispose?.();
    this.dispose = null;
    this.draw();
  }

  /** Re-renders in place, e.g. after the selection changed elsewhere. */
  refresh() {
    if (!this.open) this.draw();
  }
}
