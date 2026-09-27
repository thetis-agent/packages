/* The store: one toolbar (a search box, "Show system components", and behind that toggle the type chips and a
 * note on the index), then three sections.
 *
 * - **Updates (n)**: what has an update ready, from the same `updates` answer the "Updates ready" card is drawn
 *   from, so the number here and the number on the card are the same number. **Update all** is at the top.
 *   The person's own changes waiting to be applied are a line above it, with **Apply**.
 * - **Installed (n)**: what this person has.
 * - **Discover (n)**: what they could add: the installation's extensions they do not have, then what the
 *   registries offer.
 *
 * The parts that make the installation run (host packages, the storage driver, the gateways, the provider, the
 * harness, the index service, benchmarks, the page's own plumbing) are system components: `row.component`,
 * decided on the server in lib/rows.js. They are left out of Installed and Discover until the toggle is on; an
 * admin has the same toggle. An update to one of them is still listed under Updates, because it is still
 * something the person has to take.
 *
 * An installed extension whose configuration is missing something carries the kernel's one sentence about it,
 * from one `config-list` call after the rows. The search runs on the server through the `search` command,
 * because the index and its ranking live there; the page keeps the last query and the toggle, so coming back
 * from an extension's page shows the same list. Clicking a card re-opens the place with the name. An admin
 * also gets **Registries** in the toolbar, the page in registries.js. */

import { stateBadge, updateBadge } from "./badges.js";
import { updater } from "./updates-notice.js";

/** Kept across opens: the query, the type and the toggle a person came back to. */
const last = { q: "", type: "", system: false };

/** The rows each section shows. Exported for the tests: this is the whole of the store's filtering. */
export function sections(rows, { system = false, updates = null } = {}) {
  const visible = (r) => system || !r.component;
  const byName = new Map(rows.map((r) => [r.name, r]));
  const items = updates?.items ?? rows.filter((r) => r.update && r.update.apply !== "unfork").map((r) => ({ name: r.name, label: r.label ?? r.name, from: r.update.installed ?? "", to: r.update.version, apply: r.update.apply === "install" ? "install" : "apply" }));
  return {
    updates: items.map((i) => ({ item: i, row: byName.get(i.name) ?? null })),
    own: updates?.own ?? [],
    installed: rows.filter((r) => r.installed && visible(r)),
    discover: rows.filter((r) => !r.installed && visible(r)),
    hidden: rows.filter((r) => !visible(r)).length,
  };
}

export function openGallery(ext, root, params) {
  const { el, clear } = ext.dom;
  const { badge, busy, put, when, button } = ext.ui;
  let alive = true;
  let rows = [];
  let pending = null; // the `updates` answer, or null when this page cannot ask for it
  let summaries = new Map(); // package -> { summary, broken }, for installed packages
  let facts = { indexed: false, updatedAt: null, registries: [], total: 0 };
  const types = new Set();
  let timer = null;

  const input = el("input", { class: "input mk-search", type: "search", placeholder: "Search extensions", "aria-label": "Search extensions", value: last.q, spellcheck: "false" });
  input.addEventListener("input", () => {
    last.q = input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  });
  const toggleBox = el("input", { type: "checkbox", class: "mk-system-box" });
  toggleBox.checked = last.system;
  toggleBox.addEventListener("change", () => {
    last.system = toggleBox.checked;
    if (!last.system && last.type) {
      last.type = "";
      void load();
      return;
    }
    draw();
  });
  const toggle = el("label", { class: "mk-system-toggle", title: "The parts that make the installation run: the gateways, the storage driver, the model provider, the harness and the like" }, toggleBox, " Show system components");
  const chips = el("div", { class: "mk-chips", role: "group", "aria-label": "Type" });
  const note = el("p", { class: "mk-note" });
  const body = el("div", { class: "mk-store" });
  // The admins' way to the registries themselves; nobody else can send those verbs, so nobody else sees it.
  const registriesBtn = ext.can("registries") ? button("Registries", { title: "Which registries are mirrored, and the key each private one is read with", onClick: () => ext.open.place("marketplace", { view: "registries" }) }) : null;
  const page = el("div", { class: "place-page mk-gallery" }, el("div", { class: "mk-toolbar" }, input, toggle, registriesBtn), el("div", { class: "mk-toolbar mk-toolbar-system" }, chips, note), body);
  root.append(page);

  async function load() {
    const stop = busy(body, "Reading the extensions…");
    try {
      const [out, ups] = await Promise.all([ext.request("search", { args: { q: last.q, type: last.type } }), ext.can("updates") ? ext.request("updates").catch(() => null) : null]);
      if (!alive) return;
      const data = out?.data ?? {};
      rows = Array.isArray(data.rows) ? data.rows : [];
      pending = ups?.data ?? null;
      facts = { indexed: !!data.indexed, updatedAt: data.updatedAt ?? null, registries: Array.isArray(data.registries) ? data.registries : [], total: data.total ?? 0 };
      for (const r of rows) if (r.type) types.add(r.type);
    } catch (err) {
      if (!alive) return;
      rows = [];
      // One plain sentence; the raw text is kept under Details rather than put in front of the person.
      clear(body);
      body.append(el("p", { class: "mk-error" }, "The extensions could not be read just now."), details(err?.message));
      return;
    } finally {
      stop();
    }
    if (alive) draw();
    if (alive && params?.view === "updates") document.getElementById("mk-updates")?.scrollIntoView({ block: "start" });
    if (alive && rows.some((r) => r.installed)) await loadSummaries();
  }

  /** The raw text of a failure, folded away. */
  function details(text) {
    if (!text) return null;
    return el("details", { class: "mk-details" }, el("summary", {}, "Details"), el("pre", { class: "mk-wrap" }, String(text)));
  }

  /** The one sentence per installed package. Drawn after the rows, so the store never waits on it; a failure leaves the cards as they are. */
  async function loadSummaries() {
    try {
      const out = await ext.request("config-list");
      if (!alive) return;
      summaries = new Map((Array.isArray(out?.data) ? out.data : []).map((s) => [s.package, s]));
    } catch {
      return;
    }
    if (alive) draw();
  }

  function chip(type, label) {
    const active = last.type === type;
    return el("button", { type: "button", class: `mk-chip${active ? " is-active" : ""}`, "data-type": type, "aria-pressed": String(active), onClick: () => { last.type = type; void load(); } }, label);
  }

  /** The type chips and the index note: both are about the machinery, so both wait behind the toggle. */
  function drawSystemBar() {
    clear(chips);
    clear(note);
    chips.parentElement.hidden = !last.system;
    if (!last.system) return;
    if (last.type) types.add(last.type);
    chips.append(chip("", "All"), ...[...types].sort().map((t) => chip(t, t)));
    if (!facts.indexed) return note.append("no marketplace index yet");
    const names = facts.registries.map((r) => r.name).join(", ") || "none";
    const failed = facts.registries.filter((r) => r.error).length;
    note.append(facts.registries.length === 1 ? "registry " : "registries ", el("code", {}, names), ` · refreshed ${when(facts.updatedAt) || "never"}${failed ? ` · ${failed} failed to refresh` : ""}`);
  }

  function card(r, extra = null) {
    const summary = r.installed ? summaries.get(r.name) : null;
    return el(
      "button",
      { type: "button", class: `mk-card${r.installed ? " is-installed" : ""}`, "data-name": r.name, onClick: () => ext.open.place("marketplace", { name: r.name }) },
      el("div", { class: "mk-card-head" }, el("span", { class: "mk-card-label" }, r.label ?? r.name), el("div", { class: "tags" }, stateBadge(badge, r), updateBadge(badge, r))),
      el("p", { class: "mk-card-desc" }, r.description || "No description."),
      summary?.broken ? el("span", { class: "mk-card-broken" }, `Setup needed: ${summary.summary}`) : null,
      extra,
      el("span", { class: "mk-card-meta" }, [r.name, r.version].filter(Boolean).join(" · "))
    );
  }

  /** An update whose extension is not among the rows (a search narrowed it away): a plain line, still counted. */
  function updateLine(item) {
    return el("div", { class: "mk-card mk-card-plain" }, el("span", { class: "mk-card-label" }, item.label), el("span", { class: "mk-card-meta" }, `${item.from} → ${item.to}`));
  }

  function section(id, title, count, children, action = null, empty = null) {
    return el(
      "section",
      { class: "mk-section", id, "aria-label": title },
      el("div", { class: "mk-section-head" }, el("h3", { class: "mk-section-title" }, `${title} (${count})`), action),
      count ? el("div", { class: "mk-cards" }, ...children) : empty ? el("p", { class: "mk-none" }, empty) : null
    );
  }

  function draw() {
    drawSystemBar();
    clear(body);
    const s = sections(rows, { system: last.system, updates: pending });
    const u = updater();
    const updateAll = s.updates.length && u ? button("Update all", { tone: "primary", onClick: () => void u.updateAll() }) : null;
    const ownLine = s.own.length && u
      ? el("div", { class: "mk-own" }, el("span", {}, `Your changes to ${s.own.map((o) => o.label).join(", ")} are ready to use.`), button("Apply", { tone: "primary", onClick: () => void u.applyOwn(pending, { asked: true }) }))
      : null;
    const narrowed = last.q || last.type;
    put(
      body,
      ownLine,
      section("mk-updates", "Updates", s.updates.length, s.updates.map(({ item, row }) => (row ? card(row) : updateLine(item))), updateAll, "Everything is up to date."),
      section("mk-installed", "Installed", s.installed.length, s.installed.map((r) => card(r)), null, narrowed ? "Nothing you have matches." : "Nothing installed yet."),
      section("mk-discover", "Discover", s.discover.length, s.discover.map((r) => card(r)), null, narrowed ? "Nothing to add matches." : "Nothing else to add right now."),
      !last.system && s.hidden ? el("p", { class: "panel-hint" }, `${s.hidden} system ${s.hidden === 1 ? "component is" : "components are"} not shown.`) : null,
      last.system && !facts.indexed ? el("p", { class: "panel-hint mk-hint" }, `No marketplace index yet. ${registriesBtn ? "Registries are set under Registries above" : "Registries are configured under packages[\"@thetis/marketplace\"].registries"}; the service refreshes them on a timer.`) : null
    );
  }

  void load();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}
