/* Packages: what is installed here, one row per package. The person's own setup only: the name, the
 * version, the type, whether it is theirs alone ("Only me") or everyone's, and what it brings. The card
 * on the right shows the facts and the two actions the person can always take: remove, and delete a
 * package of their own with its files. Installing from a source stays here because it is the bootstrap:
 * with nothing else installed a person must still be able to install from the browser. Everything the
 * registries know (search, package pages, updates, an admin's installs for others) is the marketplace
 * place of `@thetis/ui-marketplace`; each row links there when that package has registered its place. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { badge, busy, button, card, confirm, heading, kv, put, table, tags } from "../lib/panel-ui.js";
import * as registry from "../lib/registry.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

/** The place a row links to: the marketplace package's, when it is installed and has loaded. */
export const MARKETPLACE_PLACE = "@thetis/ui-marketplace#marketplace";

export function mountPackages(root, { user }, shell) {
  let installed = [];
  let query = "";
  let selected = null;

  const filter = el("input", { class: "input", type: "search", placeholder: "Filter packages", "aria-label": "Filter packages", onInput: (e) => { query = e.target.value.trim().toLowerCase(); drawList(); } });
  const listEl = el("div", { class: "panel-col" });
  const detailEl = el("div", { class: "panel-col is-side" });
  root.append(el("div", { class: "panel-cols" }, listEl, detailEl));

  const marketplace = () => (registry.entry("places", MARKETPLACE_PLACE)?.impl?.open && shell?.openPlace ? (name) => shell.openPlace(MARKETPLACE_PLACE, { name }) : null);

  async function load() {
    const stop = busy(listEl, "Reading packages…");
    try {
      installed = await api("/api/packages");
    } catch (err) {
      toast(err.message, { tone: "error" });
      installed = [];
    }
    stop();
    if (selected && !installed.some((r) => r.name === selected)) selected = null;
    drawList();
    drawDetail();
  }

  const visible = () => installed.filter((r) => !query || r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query) || (r.description || "").toLowerCase().includes(query));

  const scopeBadge = (r) => (r.scope === "everyone" ? badge("Everyone", "accent") : badge("Only me", "dim"));
  const forkBadge = (r) => (r.forkedFrom ? badge(`fork of ${r.forkedFrom.name} ${r.forkedFrom.version}`, "warn") : null);

  /** A package the person can delete with its files: one of their own. */
  const ownRow = (r) => r.name.startsWith(`@${user}/`);

  function brings(r) {
    const parts = [];
    if (r.steps?.length) parts.push(`${r.steps.length} step${r.steps.length === 1 ? "" : "s"}`);
    if (r.tools?.length) parts.push(`${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}`);
    if (r.service) parts.push("a service");
    return el("span", { class: "text-dim" }, parts.join(", ") || "—");
  }

  function drawList() {
    clear(listEl);
    const shown = visible();
    put(
      listEl,
      el("div", { class: "toolbar" }, heading("Packages", `${installed.length} installed`), el("div", { class: "toolbar-gap" }), filter),
      table(
        [
          { key: "name", label: "Package", render: (r) => el("code", { class: "cell-name", title: r.description || null }, r.name) },
          { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
          { key: "type", label: "Type" },
          { key: "scope", label: "Scope", render: (r) => el("div", { class: "tags" }, scopeBadge(r), forkBadge(r)) },
          { key: "brings", label: "Brings", render: (r) => el("span", { class: "cell-name" }, brings(r)) },
        ],
        shown,
        { onRow: (r) => { selected = r.name; drawList(); drawDetail(); }, selectedKey: selected, empty: installed.length ? "No package matches the filter." : "Nothing is installed here." }
      ),
      addBlock(),
      !marketplace() && el("p", { class: "panel-hint" }, "The registries, package pages and updates are the Marketplace place of @thetis/ui-marketplace, which is not installed here.")
    );
  }

  function addBlock() {
    const input = el("input", { class: "input", type: "text", placeholder: "packages/<name>, a git URL, or url#dir", "aria-label": "Package source", spellcheck: "false" });
    const go = button("Put it in place", { tone: "primary", onClick: () => void add() });
    const block = el("div", { class: "card add-block" }, el("div", { class: "card-head" }, "Add a package from a source"), el("div", { class: "card-body" }, el("div", { class: "row" }, input, go), el("p", { class: "text-faint" }, `An admin can also name a shipped package, such as @thetis/gateway-web; anyone else's package.json must be scoped @${user}/<name>. Building can take a minute.`)));
    async function add() {
      const source = input.value.trim();
      if (!source) return input.focus();
      const stop = busy(block, "Putting it in place… this can take a minute.");
      go.disabled = true;
      try {
        const row = await api("/api/packages", { method: "POST", body: { source } });
        toast(`${row.name}@${row.version} is in place. It is live on the next turn.`, { tone: "good" });
        input.value = "";
        selected = row.name;
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

  function drawDetail() {
    clear(detailEl);
    const row = installed.find((r) => r.name === selected);
    if (!row) return put(detailEl, el("div", { class: "panel-hint" }, "Select a package to see what it brings and what you can do with it."));
    const actions = [button("Remove", { tone: "warn", onClick: (e) => void removeRow(row, e.currentTarget) })];
    const hints = [];
    if (ownRow(row)) {
      actions.push(button("Delete", { tone: "warn", onClick: (e) => void deleteRow(row, e.currentTarget) }));
      hints.push(row.replaced ? `Remove or Delete puts ${row.replaced} back in place.` : "Delete removes the package and its files under packages/.");
    }
    const open = marketplace();
    if (open) actions.push(button("Open in the marketplace", { onClick: () => open(row.name) }));
    put(
      detailEl,
      card(
        el("code", {}, row.name),
        row.description && el("p", {}, row.description),
        kv([
          ["version", el("code", {}, row.version)],
          ["type", row.type],
          ["scope", el("div", { class: "tags" }, scopeBadge(row), forkBadge(row))],
          row.forkedFrom && ["forked from", el("code", {}, `${row.forkedFrom.name}@${row.forkedFrom.version}`)],
          row.replaced && ["replaces", el("code", {}, row.replaced)],
        ].filter(Boolean)),
        heading("What it brings"),
        kv([
          ["steps", tags((row.steps || []).map((s) => `${s.phase}: ${s.id}`), "dim", "no steps")],
          ["tools", tags(row.tools || [], "ok", "no tools")],
          ["service", row.service ? badge("runs a service", "warn") : el("span", { class: "text-faint" }, "none")],
        ]),
        el("div", { class: "card-actions" }, ...actions)
      ),
      ...hints.map((h) => el("p", { class: "panel-hint" }, h))
    );
  }

  async function removeRow(row, anchor) {
    const ok = await confirm(anchor, {
      title: "Remove this package?",
      lines: [["package", row.name], ["from", "your own setup"]],
      note: row.replaced ? `Its files stay in place; only the link is removed. ${row.replaced} comes back on the next turn.` : row.scope === "everyone" ? "This is a system package. Steps and tools it brings stop on the next turn; an admin can add it back." : "Its files stay in place; only the link is removed. Steps and tools it brings stop on the next turn.",
      confirmLabel: "Remove",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Removing…");
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

  async function deleteRow(row, anchor) {
    const ok = await confirm(anchor, {
      title: "Delete this package?",
      lines: [["package", row.name], row.forkedFrom && ["forked from", `${row.forkedFrom.name}@${row.forkedFrom.version}`], ["comes back", row.replaced || "nothing"]].filter(Boolean),
      note: "This deletes the files under packages/ too. Steps and tools it brings stop on the next turn.",
      confirmLabel: "Delete",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Deleting…");
    try {
      const r = await api(`/api/packages/${enc(row.name)}?files=1`, { method: "DELETE" });
      toast(r.restored ? `${r.name} was deleted. ${r.restored} is back in place.` : `${r.name} was deleted.`, { tone: "good" });
      selected = r.restored || null;
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  // The marketplace's module may register after this section was drawn; redraw the links when it does.
  const unwatch = registry.watch((change) => {
    if (change.kind === "register" && change.slot === "places" && registry.keyOf(change.package, change.id) === MARKETPLACE_PLACE) {
      drawList();
      drawDetail();
    }
  });

  void load();
  return unwatch;
}
