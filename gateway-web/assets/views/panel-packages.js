/* Extensions, the built-in section of the control panel: the bootstrap and nothing more. Adding, updating,
 * configuring and removing extensions is the Extensions place of `@thetis/ui-marketplace` (place id
 * `marketplace`, from that package or a copy of it). When that place is here, this section says how many
 * extensions are installed and links to it ("Manage extensions"). When it is not — never installed,
 * removed, or its module failed to load — a person must still be able to put one in place from the
 * browser, so the section offers exactly that: install from a source, the list of what is installed, and
 * Remove.
 *
 * What the gateway itself can know comes from `src/panel.ts`, which serves `kernel.packages.list()` and
 * imports no domain package. Everything the registries know (search, pages, updates, publishing, a copy
 * of an extension and the way back to the official one, what everyone gets) lives in the Extensions place
 * only, so this section has no second copy of any of it. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { busy, button, confirm, heading, put, table } from "../lib/panel-ui.js";
import * as registry from "../lib/registry.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

/** The id of the Extensions place, as `@thetis/ui-marketplace` declares it (a copy of that package declares the same). */
export const MARKETPLACE_ID = "marketplace";

export function mountPackages(root, { user }, shell) {
  let installed = [];
  const body = el("div", { class: "panel-col ext-bootstrap" });
  root.append(body);

  /** The Extensions place, when a package declared it here and loaded: the way to manage extensions. */
  const place = () => {
    const entry = registry.entries("places").find((e) => e.id === MARKETPLACE_ID && !registry.failureOf(e.package));
    return entry && shell?.openPlace ? () => shell.openPlace(entry.key) : null;
  };

  async function load() {
    const stop = busy(body, "Reading what is installed…");
    try {
      installed = await api("/api/packages");
    } catch (err) {
      stop();
      clear(body);
      put(body, el("p", { class: "panel-hint is-error" }, `What is installed could not be read: ${err.message}`), button("Try again", { onClick: () => void load() }));
      return;
    }
    stop();
    draw();
  }

  function draw() {
    clear(body);
    const open = place();
    const count = `${installed.length} installed`;
    if (open) {
      put(
        body,
        heading("Extensions", count),
        el("p", { class: "panel-hint" }, "Extensions add tools, skills and pages to Thetis. You add, update, set up and remove them in the Extensions place."),
        el("div", { class: "row" }, button("Manage extensions", { tone: "primary", onClick: open }))
      );
      return;
    }
    put(
      body,
      heading("Extensions", count),
      el("p", { class: "panel-hint" }, "The Extensions place is not installed here, so this is the short way in: install one from a source, or remove one. Installing @thetis/ui-marketplace brings the Extensions place back."),
      addBlock(),
      table(
        [
          { key: "name", label: "Extension", render: (r) => el("code", { class: "cell-name", title: r.description || null }, r.name) },
          { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
          { key: "description", label: "What it does", render: (r) => el("span", { class: "text-dim" }, r.description || "—") },
          { key: "remove", label: "", render: (r) => button("Remove", { tone: "warn", onClick: (e) => { e.stopPropagation(); void removeRow(r, e.currentTarget); } }) },
        ],
        installed,
        { empty: "Nothing is installed here." }
      )
    );
  }

  function addBlock() {
    const input = el("input", { class: "input", type: "text", placeholder: "@thetis/ui-marketplace, packages/<name>, or a git URL", "aria-label": "Extension source", spellcheck: "false" });
    const go = button("Install", { tone: "primary", onClick: () => void add() });
    const block = el("div", { class: "card add-block" }, el("div", { class: "card-head" }, "Install from a source"), el("div", { class: "card-body" }, el("div", { class: "row" }, input, go), el("p", { class: "text-faint" }, `An extension that comes with Thetis goes in by name, such as @thetis/ui-marketplace. Anything else is a path under your home or a git source, built here; name your own @${user}/<name>. Building can take a minute.`)));
    async function add() {
      const source = input.value.trim();
      if (!source) return input.focus();
      const stop = busy(block, "Installing… this can take a minute.");
      go.disabled = true;
      try {
        const row = await api("/api/packages", { method: "POST", body: { source } });
        toast(`${row.name} ${row.version} is installed. It is used from your next message; a new page appears after a refresh.`, { tone: "good" });
        input.value = "";
        await load();
      } catch (err) {
        toast(err.message, { tone: "error" });
      } finally {
        stop();
        go.disabled = false;
      }
    }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } });
    return block;
  }

  async function removeRow(row, anchor) {
    const ok = await confirm(anchor, {
      title: "Remove this extension?",
      lines: [["extension", row.name], ["from", "your space"]],
      note: row.replaced ? `Its files stay where they are. ${row.replaced} comes back in its place.` : "Its files stay where they are; what it adds stops from your next message.",
      confirmLabel: "Remove",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(body, "Removing…");
    try {
      await api(`/api/packages/${enc(row.name)}`, { method: "DELETE" });
      toast(`${row.name} was removed.`, { tone: "good" });
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  // The Extensions place may be declared, load, or fail after this section was drawn: say the right thing.
  const unwatch = registry.watch((change) => {
    if (change.kind === "declare" || change.kind === "fail" || (change.kind === "register" && change.slot === "places" && change.id === MARKETPLACE_ID)) draw();
  });

  void load();
  return unwatch;
}
