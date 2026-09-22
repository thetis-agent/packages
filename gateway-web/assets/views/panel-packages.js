/* Packages: what is installed here, one row per package. The person's own setup only: the name, the
 * version, the type, whether it is theirs alone ("Only me") or everyone's, and what it brings. The card
 * on the right shows the facts and the two actions the person can always take: remove, and delete a
 * package of their own with its files. Installing from a source stays here because it is the bootstrap:
 * with nothing else installed a person must still be able to install from the browser. Everything the
 * registries know (search, package pages, updates, an admin's installs for others) is the marketplace
 * place of `@thetis/ui-marketplace`; each row links there when that package has registered its place.
 *
 * One thing this section shows that it cannot work out for itself: whether a package's version here is
 * newer than the version the registries hold, or has never been published at all. That answer needs the
 * marketplace index, and the gateway imports no domain package -- `src/panel.ts` serves these rows out of
 * `kernel.packages.list()` and nothing else, which is what keeps the built-in section the bootstrap it is
 * meant to be. So it is asked for, softly, from the marketplace package's own `search` verb, the same
 * soft link this file already makes for the place: when `@thetis/ui-marketplace` is not installed, or has
 * not declared that verb, nothing is asked and nothing is drawn. The request goes out after the table, so
 * the section never waits on it, and a failure leaves the rows exactly as they are. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { badge, busy, button, card, confirm, heading, kv, put, table, tags } from "../lib/panel-ui.js";
import * as registry from "../lib/registry.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

/** How long the page waits for the package that replaced a forked gateway to answer in its place. */
const SETTLE_MS = 30_000;

/**
 * A request that lost its gateway, as against one a gateway refused with a sentence. Replacing a forked
 * gateway stops the service answering this page, which leaves either no answer at all (status 0) or the
 * door's own 502/503 while the socket is gone; anything else came from a gateway that is still there.
 */
const lostGateway = (err) => {
  const status = Number(err?.status);
  return !Number.isFinite(status) || status === 0 || status >= 502;
};

/** Asks the new gateway for the package list until it answers, or until the deadline passes. */
async function settle(deadline = Date.now() + SETTLE_MS) {
  for (;;) {
    try {
      await api("/api/packages");
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((done) => setTimeout(done, 700));
    }
  }
}

/** The marketplace package, and the place a row links to when it is installed and has loaded. */
export const MARKETPLACE_PKG = "@thetis/ui-marketplace";
export const MARKETPLACE_PLACE = `${MARKETPLACE_PKG}#marketplace`;

export function mountPackages(root, { user }, shell) {
  let installed = [];
  let query = "";
  let selected = null;
  let ahead = new Map(); // package name -> { state, version, published, registry }, when the marketplace can say

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
    await loadAhead();
  }

  /**
   * What is newer here than the registries hold, from the marketplace package's `search`, which merges the
   * installed list with the index and puts `ahead` on each row. Soft in both directions: the verb is only
   * sent when that package declared it, and any failure leaves `ahead` as it was. Nothing here throws.
   */
  async function loadAhead() {
    if (!(registry.declared(MARKETPLACE_PKG)?.commands ?? []).includes("search")) return;
    try {
      const out = await api(`/api/ext/${MARKETPLACE_PKG}/search`, { method: "POST", body: { args: {} } });
      const rows = Array.isArray(out?.data?.rows) ? out.data.rows : [];
      ahead = new Map(rows.filter((r) => r.installed && r.ahead).map((r) => [r.name, r.ahead]));
    } catch {
      return;
    }
    drawList();
    drawDetail();
  }

  const visible = () => installed.filter((r) => !query || r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query) || (r.description || "").toLowerCase().includes(query));

  const scopeBadge = (r) => (r.scope === "everyone" ? badge("Everyone", "accent") : badge("Only me", "dim"));

  /* A fork, said against the package it was copied from as that package stands now. "fork of X 0.1.1" on
   * its own is the sentence that lets a fork sit for months missing every fix to X, because it is equally
   * true the day the fork is made and a year later. The strongest true form wins. */
  const forkBadge = (r) => {
    const fork = r.fork;
    if (!fork) return r.forkedFrom ? badge(`fork of ${r.forkedFrom.name} ${r.forkedFrom.version}`, "warn") : null;
    /* The origin is what everyone here gets by default, and this row is the one place its holder is told:
     * an admin making a package the default for everyone cannot make it theirs, because the kernel will
     * not install a package over somebody's fork of it. A clause, not a sentence of its own -- it is the
     * context for acting on the rest of the badge, never the reason to. */
    const everyone = fork.everyone ? " · everyone else gets that one" : "";
    if (fork.identical && fork.shipped) return badge(`identical to ${fork.name} ${fork.shipped}, which is shipped${everyone}`, "warn");
    if (fork.shipped && fork.shipped !== fork.version) return badge(`fork of ${fork.name} ${fork.version} · ${fork.shipped} is shipped now${everyone}`, "warn");
    return badge(`fork of ${fork.name} ${fork.version}${everyone}`, "warn");
  };

  /* Work that is here and nowhere else. Whoever maintains a package is also running it, out of the same
   * checkout every fence loads, so a version bump is in service here the moment it lands while the registry
   * every other installation reads still holds the old one. Nothing in this table has ever said so. Short,
   * because it sits in a cell beside two other badges. */
  const aheadBadge = (r) => {
    const a = ahead.get(r.name);
    if (!a) return null;
    // Dim for a package no registry ever listed, which is a quiet fact and true of most of them at once on
    // a maintainer's machine; warn for a version here that is past what a registry holds, which is a gap
    // between what this installation runs and what anybody else can get. See `aheadBadge` in ui-marketplace.
    return a.state === "unpublished" ? badge("never published", "dim") : badge(`${a.version} here, ${a.published} published`, "warn");
  };

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
          { key: "scope", label: "Scope", render: (r) => el("div", { class: "tags" }, scopeBadge(r), forkBadge(r), aheadBadge(r)) },
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
    if (row.fork?.shipped) {
      actions.unshift(button(`Go back to ${row.fork.name}`, { tone: "primary", onClick: (e) => void unforkRow(row, e.currentTarget) }));
      hints.push(
        row.fork.identical
          ? `Your fork holds the same files as ${row.fork.name}@${row.fork.shipped}, which is shipped here: it is changing nothing, and it will never see another fix. Going back keeps your files under packages/.`
          : `You forked ${row.fork.name} at ${row.fork.version}; ${row.fork.shipped} is shipped now. Going back keeps your files under packages/, so you can fork again from the new one.`
      );
    }
    if (ownRow(row)) {
      actions.push(button("Delete", { tone: "warn", onClick: (e) => void deleteRow(row, e.currentTarget) }));
      hints.push(row.replaced ? `Remove or Delete puts ${row.replaced} back in place.` : "Delete removes the package and its files under packages/.");
    }
    const open = marketplace();
    if (open) actions.push(button("Open in the marketplace", { onClick: () => open(row.name) }));
    // Publishing is the marketplace package's action, in its own page, where the registry picker, the
    // version choice and the dry run in front of the confirm live. This section says the gap exists and
    // points at the one place that can close it; it does not grow a second half of that flow.
    if (ahead.get(row.name) && open) hints.push(ahead.get(row.name).state === "unpublished" ? `No registry lists ${row.name}. Publish is on its page in the marketplace.` : `${ahead.get(row.name).version} is here and ${ahead.get(row.name).published} is what ${ahead.get(row.name).registry} holds. Publish is on its page in the marketplace.`);
    put(
      detailEl,
      card(
        el("code", {}, row.name),
        row.description && el("p", {}, row.description),
        kv([
          ["version", el("code", {}, row.version)],
          ["type", row.type],
          ["scope", el("div", { class: "tags" }, scopeBadge(row), forkBadge(row), aheadBadge(row))],
          // Said in full here, where there is room for it, and only when the marketplace could answer.
          ahead.get(row.name)?.state === "ahead" && ["published", el("span", {}, el("code", {}, ahead.get(row.name).published), ` in ${ahead.get(row.name).registry} — ${row.version} is what is here`)],
          ahead.get(row.name)?.state === "unpublished" && ["published", el("span", { class: "text-faint" }, "nowhere: no registry lists this package")],
          row.forkedFrom && ["forked from", el("code", {}, `${row.forkedFrom.name}@${row.forkedFrom.version}`)],
          row.fork && ["shipped now", row.fork.shipped ? el("code", {}, `${row.fork.name}@${row.fork.shipped}${row.fork.identical ? " — the same files as this fork" : ""}`) : el("span", { class: "text-faint" }, "not here any more")],
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

  /* Goes back to the package this fork was copied from. The forked package is very often this gateway --
   * it is the one a person looks at their own setup through -- so the request carrying the click dies with
   * the service it stops. That is the success: the kernel has already checked the origin is on disk before
   * removing anything, and the origin's service binds the same socket a moment later, so the page is asked
   * again until it answers. The fork's files are kept; Delete is what removes them. */
  async function unforkRow(row, anchor) {
    const ok = await confirm(anchor, {
      title: `Go back to ${row.fork.name}?`,
      lines: [["fork", `${row.name}@${row.version}`], ["goes back to", `${row.fork.name}@${row.fork.shipped}`], ["your files", "kept where they are"]],
      note: `${row.name} is removed from your setup and ${row.fork.name} takes its place, with every change it has had since you forked it.${row.type === "gateway" ? " This page is served by the package being replaced, so it will go quiet for a second and come back on its own." : ""} Your copy stays under packages/.`,
      confirmLabel: `Go back to ${row.fork.name}`,
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(detailEl, `Going back to ${row.fork.name}…`);
    try {
      let back = null;
      try {
        back = await api(`/api/packages/${enc(row.name)}?unfork=1`, { method: "DELETE" });
      } catch (err) {
        if (!lostGateway(err)) throw err;
        if (!(await settle())) {
          toast(`${row.fork.name} has not answered for 30 seconds. Reload this page, or ask an admin to run thetis packages unfork ${row.name}.`, { tone: "error" });
          return;
        }
      }
      toast(`${back?.name ?? row.fork.name} is back in place. Your fork's files are still under packages/.`, { tone: "good" });
      selected = back?.name ?? row.fork.name;
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
      // Its declaration is what lets this section ask what is unpublished; before it arrived there was
      // nobody to ask.
      void loadAhead();
    }
  });

  void load();
  return unwatch;
}
