/* A directory picker, anchored to a control like the confirm popover. The shell owns how it looks; the
 * caller owns where the directories come from, through one async `browse(path)` that answers
 * `{ path, parent, kind, readable, truncated, entries: [{ name, path }] }` — the shape of the kernel's
 * `mounts.browse`. So a package with no reach of its own can still offer a picker, and the picker can
 * never read a path the package could not read itself.
 *
 * The point of it is that a path you pick is a path that exists: the chosen line says what the host holds
 * there, and the confirm button stays off until that is a directory. You may still type a path, because
 * typing is faster than clicking through ten levels; the listing follows what you type, so a typo shows
 * as "not on the host" before you can choose it.
 */

import { el, icon, onClickOutside } from "./dom.js";
import { button } from "./panel-ui.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
const UP = ["M10 15V5", "M5.5 9.5 10 5l4.5 4.5"];
const FOLDER = ["M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6L9.4 6h6.6a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-9Z"];

/** One sentence about the path in the box, and whether it can be chosen. */
function stateOf(listing) {
  if (!listing) return { ok: false, text: "Reading…", tone: "dim" };
  if (listing.kind === "none") return { ok: false, text: "Not on the host.", tone: "warn" };
  if (listing.kind === "file") return { ok: false, text: "A file, not a directory.", tone: "warn" };
  if (!listing.readable) return { ok: false, text: "A directory, but it cannot be read from here.", tone: "warn" };
  const n = listing.entries.length;
  const inside = n === 0 ? "no directories inside" : `${n}${listing.truncated ? "+" : ""} ${n === 1 ? "directory" : "directories"} inside`;
  return { ok: true, text: `A directory: ${inside}.`, tone: "ok" };
}

/**
 * Opens the picker and resolves the chosen absolute path, or null when it is cancelled. `extra` is a
 * control the caller puts in the footer (a mode select, say); it is read by the caller after the promise
 * resolves, so it keeps whatever the person set.
 */
export function pickDirectory(anchor, { title = "Choose a directory", start = "/", browse, note, confirmLabel = "Use this directory", extra = null } = {}) {
  return new Promise((done) => {
    let settled = false;
    let listing = null;
    let at = typeof start === "string" && start.startsWith("/") ? start : "/";
    let token = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      stop();
      pop.remove();
      document.removeEventListener("keydown", onKey);
      done(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };

    const path = el("input", { class: "input dp-path", type: "text", value: at, spellcheck: "false", autocomplete: "off", "aria-label": "Path" });
    const status = el("p", { class: "dp-status" });
    const list = el("div", { class: "dp-list", role: "listbox", "aria-label": "Directories" });
    const use = button(confirmLabel, { tone: "primary", onClick: () => finish(at) });

    async function go(next, { type = true } = {}) {
      at = next;
      if (type) path.value = next;
      const mine = ++token;
      listing = null;
      paint();
      let answer = null;
      try {
        answer = await browse(next);
      } catch (err) {
        if (mine !== token) return;
        listing = { path: next, parent: null, kind: "none", readable: false, truncated: false, entries: [] };
        status.textContent = err?.message || "The path could not be read.";
        status.className = "dp-status is-warn";
        use.disabled = true;
        return;
      }
      if (mine !== token) return;
      listing = answer && typeof answer === "object" ? answer : null;
      paint();
    }

    function row(label, target, { up = false } = {}) {
      const b = el("button", { type: "button", class: `dp-row${up ? " is-up" : ""}`, onClick: () => void go(target) }, icon(up ? UP : FOLDER, { size: 13, width: 1.7 }), el("span", { class: "dp-row-name" }, label));
      return b;
    }

    function paint() {
      const state = stateOf(listing);
      status.textContent = state.text;
      status.className = `dp-status is-${state.tone}`;
      use.disabled = !state.ok;
      list.replaceChildren();
      if (!listing) return;
      if (listing.parent) list.append(row(listing.parent === "/" ? "/" : listing.parent, listing.parent, { up: true }));
      for (const e of listing.entries) list.append(row(e.name, e.path));
      if (listing.truncated) list.append(el("p", { class: "dp-more" }, "More directories than the picker shows. Type a path to go straight there."));
      if (listing.readable && !listing.entries.length) list.append(el("p", { class: "dp-more" }, "Nothing inside. This directory can still be chosen."));
    }

    path.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const value = path.value.trim().replace(/(?!^)\/+$/, "");
      if (value.startsWith("/")) void go(value, { type: false });
    });
    let typing = 0;
    path.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(() => {
        const value = path.value.trim().replace(/(?!^)\/+$/, "");
        if (value.startsWith("/")) void go(value, { type: false });
      }, 250);
    });

    const pop = el(
      "div",
      { class: "popover dp", role: "dialog", "aria-label": title },
      el("div", { class: "popover-head" }, el("span", {}, title), el("button", { type: "button", class: "icon-btn sm", title: "Cancel", "aria-label": "Cancel", onClick: () => finish(null) }, icon(X, { size: 11, width: 1.9 }))),
      path,
      status,
      list,
      note ? el("p", { class: "popover-note" }, note) : null,
      el("div", { class: "popover-actions dp-actions" }, extra, button("Cancel", { onClick: () => finish(null) }), use)
    );

    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`;
    const below = r.bottom + 8;
    pop.style.top = `${below + 320 > window.innerHeight - 12 ? Math.max(12, window.innerHeight - 332) : below}px`;
    const stop = onClickOutside(pop, () => finish(null));
    document.addEventListener("keydown", onKey);
    void go(at);
    path.focus();
    path.setSelectionRange(path.value.length, path.value.length);
  });
}
