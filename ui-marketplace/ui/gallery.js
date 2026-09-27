/* The Extensions place: one toolbar -- a search box, the type chips (All, Tools, Skills, Pages, Models) and a line
 * on whether everything is up to date -- the one-line legend of the types, then the sections `placeSections`
 * (state.js) sorts the families into:
 *
 * - **Needs your attention (n)**, only when n > 0: what the person has that needs setting up or has an update,
 *   with **Update all** beside it, fed by the same `updates` answer as the "Updates ready" card, so the two
 *   agree. The person's own changes waiting to be applied are a line above it, with **Apply**.
 * - **Added by you (n)**: what they installed themselves or made.
 * - **Discover (n)**: what they could add. Never a version of something they already have, never an extension
 *   only an admin may add, unless they are one.
 * - Three folded sections: **Built in** (what everyone gets), **In your folder** (copies under their home's
 *   `packages/` that are not installed) and **Part of Thetis** (the parts that make it run).
 *
 * One card per extension family: an original, its copies and a promoted copy of it are one extension with
 * several versions, and the card shows the person's own. A card is the label with at most two chips, the
 * publisher line ("by Thetis · Tools"), two lines of description, and what it brings with its version.
 *
 * Every row is read once, with the person's folder, and the search and the type chips narrow them here, so a
 * key press is not a round trip; `matches` (state.js) is the search, with its synonyms. The configuration
 * report of each installed extension comes from one `config-list` call after the rows, and folds into the
 * rows so a card's Needs setup is the page's. The query, the type and which folds are open are kept, so
 * coming back from an extension's page shows the same list. Clicking a card re-opens the place with the name.
 * An admin also gets **Registries** in the toolbar, the page in registries.js. */

import { chipNodes } from "./badges.js";
import { FILTERS, WORDS, placeSections } from "./state.js";
import { updater } from "./updates-notice.js";

/** Kept across opens: the query, the type chip, and which folded sections are open. */
const last = { q: "", kind: "", open: { builtin: false, folder: false, thetis: false } };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "11 tools", "4 skills", "1 page": the first thing an extension brings, for the card's foot. */
export function bringsLine(r) {
  if (r.tools?.length) return plural(r.tools.length, "tool");
  if (r.skills) return plural(r.skills, "skill");
  if (r.pages) return plural(r.pages, "page");
  if (r.type === "provider") return "models";
  if (r.service) return "runs in the background";
  return "";
}

/** The rows with each installed extension's configuration report folded on, so `stateOf` reads it. */
export function withConfig(rows, reports) {
  if (!reports?.size) return rows;
  return rows.map((r) => (r.installed && reports.has(r.name) ? { ...r, config: reports.get(r.name) } : r));
}

/**
 * The sections, for a person, with the `updates` answer taken into account: an update the answer lists whose
 * extension has no card in "Needs your attention" (a search narrowed it away, or it is a version the card does
 * not show) is still counted there, as a plain line. Exported for the tests: this is the whole of the store's
 * filtering.
 */
export function sections(rows, { user = "", admin = false, updates = null, q = "", kind = "" } = {}) {
  const superseded = (updates?.forks ?? []).filter((f) => f.state === "superseded").map((f) => f.name);
  const s = placeSections(rows, { user, admin, superseded, q, kind });
  const shown = new Set(s.attention.map((e) => e.row.name));
  const extra = q || kind ? [] : (updates?.items ?? []).filter((i) => !shown.has(i.name));
  return { ...s, extra, own: updates?.own ?? [], items: updates?.items ?? [] };
}

export function openGallery(ext, root, params) {
  const { el, clear } = ext.dom;
  const { badge, busy, put, when, button } = ext.ui;
  let alive = true;
  let rows = [];
  let who = { user: "", admin: false };
  let pending = null; // the `updates` answer, or null when this page cannot ask for it
  let reports = new Map(); // package -> its short configuration report, for installed packages
  let facts = { indexed: false, updatedAt: null, registries: [], total: 0 };

  const input = el("input", { class: "input mk-search", type: "search", placeholder: "Search extensions…", "aria-label": "Search extensions", value: last.q, spellcheck: "false" });
  input.addEventListener("input", () => {
    last.q = input.value.trim();
    draw();
  });
  const chips = el("div", { class: "mk-chips", role: "group", "aria-label": "Type" });
  const status = el("p", { class: "mk-status" });
  const body = el("div", { class: "mk-store" });
  // The admins' way to the registries themselves; nobody else can send those verbs, so nobody else sees it.
  const registriesBtn = ext.can("registries") ? button("Registries", { title: "Which registries are mirrored, and the key each private one is read with", onClick: () => ext.open.place("marketplace", { view: "registries" }) }) : null;
  const page = el(
    "div",
    { class: "place-page mk-gallery" },
    el("div", { class: "mk-toolbar" }, input, chips, status, registriesBtn),
    el("p", { class: "mk-legend" }, WORDS.legend),
    body
  );
  root.append(page);

  async function load() {
    const stop = busy(body, "Reading the extensions…");
    try {
      const [out, ups] = await Promise.all([ext.request("search", { args: { folder: true } }), ext.can("updates") ? ext.request("updates").catch(() => null) : null]);
      if (!alive) return;
      const data = out?.data ?? {};
      rows = Array.isArray(data.rows) ? data.rows : [];
      who = { user: data.user ?? "", admin: !!data.role && data.role !== "user" };
      pending = ups?.data ?? null;
      facts = { indexed: !!data.indexed, updatedAt: data.updatedAt ?? null, registries: Array.isArray(data.registries) ? data.registries : [], total: data.total ?? 0 };
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
    if (alive && params?.view === "updates") document.getElementById("mk-attention")?.scrollIntoView({ block: "start" });
    if (alive && rows.some((r) => r.installed)) await loadReports();
  }

  /** The raw text of a failure, folded away. */
  function details(text) {
    if (!text) return null;
    return el("details", { class: "mk-details" }, el("summary", {}, "Details"), el("pre", { class: "mk-wrap" }, String(text)));
  }

  /** The configuration reports. Drawn after the rows, so the store never waits on them; a failure leaves the cards as they are. */
  async function loadReports() {
    try {
      const out = await ext.request("config-list");
      if (!alive) return;
      reports = new Map((Array.isArray(out?.data) ? out.data : []).map((s) => [s.package, s]));
    } catch {
      return;
    }
    if (alive) draw();
  }

  function drawChips() {
    clear(chips);
    for (const f of FILTERS) {
      const active = last.kind === f.id;
      chips.append(el("button", { type: "button", class: `mk-chip${active ? " is-active" : ""}`, "data-kind": f.id, "aria-pressed": String(active), onClick: () => { last.kind = f.id; draw(); } }, f.label));
    }
  }

  /** "All up to date · checked 15 min ago", or how many updates are ready. The time is the index's last refresh. */
  function drawStatus() {
    const n = pending?.items?.length ?? 0;
    const checked = facts.updatedAt ? ` · checked ${when(facts.updatedAt) || "just now"}` : "";
    const failed = facts.registries.filter((r) => r.error).length;
    status.textContent = `${n ? `${plural(n, "update")} ready` : "All up to date"}${checked}${failed ? ` · ${failed} ${failed === 1 ? "registry" : "registries"} could not be checked` : ""}`;
  }

  function card(entry) {
    const r = entry.row;
    const { state } = entry;
    const brings = bringsLine(r);
    return el(
      "button",
      { type: "button", class: `mk-card${r.installed ? " is-installed" : ""}`, "data-name": r.name, title: r.name, onClick: () => ext.open.place("marketplace", { name: r.name }) },
      el("div", { class: "mk-card-head" }, el("span", { class: "mk-card-label" }, entry.label), state.chips.length ? el("div", { class: "tags" }, ...chipNodes(badge, state.chips)) : null),
      el("p", { class: "mk-card-by" }, entry.publisher),
      el("p", { class: "mk-card-desc" }, r.description || "No description."),
      state.waiting ? el("span", { class: "mk-card-waiting" }, WORDS.waiting) : null,
      el("span", { class: "mk-card-foot" }, el("span", {}, brings), r.version ? el("span", { class: "mk-card-version" }, `v${r.version}`) : null)
    );
  }

  /** An update whose extension has no card here (a search narrowed it away): a plain line, still counted. */
  function updateLine(item) {
    return el("div", { class: "mk-card mk-card-plain" }, el("span", { class: "mk-card-label" }, item.label), el("span", { class: "mk-card-foot" }, el("span", {}, "Update available"), el("span", { class: "mk-card-version" }, `${item.from} → ${item.to}`)));
  }

  function section(id, title, count, children, { action = null, empty = null } = {}) {
    return el(
      "section",
      { class: "mk-section", id, "aria-label": title },
      el("div", { class: "mk-section-head" }, el("h3", { class: "mk-section-title" }, `${title} (${count})`), action),
      count ? el("div", { class: "mk-cards" }, ...children) : empty ? el("p", { class: "mk-none" }, empty) : null
    );
  }

  /** A folded section. It opens by itself while a search has something in it, and otherwise keeps what the person chose. */
  function fold(key, id, title, entries) {
    const searching = !!(last.q || last.kind);
    const node = el(
      "details",
      { class: "mk-fold", id, open: (searching ? entries.length > 0 : last.open[key]) || null },
      el("summary", { class: "mk-fold-head" }, el("span", { class: "mk-section-title" }, `${title} (${entries.length})`)),
      entries.length ? el("div", { class: "mk-cards" }, ...entries.map(card)) : el("p", { class: "mk-none" }, "Nothing here.")
    );
    node.addEventListener("toggle", () => {
      if (!searching) last.open[key] = node.open;
    });
    return node;
  }

  function draw() {
    drawChips();
    drawStatus();
    clear(body);
    const s = sections(withConfig(rows, reports), { ...who, updates: pending, q: last.q, kind: last.kind });
    const u = updater();
    const attention = s.attention.length + s.extra.length;
    const updateAll = s.items.length && u ? button("Update all", { tone: "primary", onClick: () => void u.updateAll() }) : null;
    const ownLine = s.own.length && u
      ? el("div", { class: "mk-own" }, el("span", {}, `Your changes to ${s.own.map((o) => o.label).join(", ")} are ready to use.`), button("Apply", { tone: "primary", onClick: () => void u.applyOwn(pending, { asked: true }) }))
      : null;
    const narrowed = last.q || last.kind;
    put(
      body,
      ownLine,
      attention ? section("mk-attention", WORDS.sections.attention, attention, [...s.attention.map(card), ...s.extra.map(updateLine)], { action: updateAll }) : null,
      section("mk-added", WORDS.sections.added, s.added.length, s.added.map(card), { empty: narrowed ? "Nothing you added matches." : "Nothing added yet. Discover has what you can add." }),
      section("mk-discover", WORDS.sections.discover, s.discover.length, s.discover.map(card), { empty: narrowed ? "Nothing to add matches." : "Nothing else to add right now." }),
      el("div", { class: "mk-folds" }, fold("builtin", "mk-builtin", WORDS.sections.builtin, s.builtin), fold("folder", "mk-folder", WORDS.sections.folder, s.folder), fold("thetis", "mk-thetis", WORDS.sections.thetis, s.thetis)),
      !facts.indexed && who.admin ? el("p", { class: "panel-hint mk-hint" }, `No marketplace index yet. ${registriesBtn ? "Registries are set under Registries above" : "Registries are configured under packages[\"@thetis/marketplace\"].registries"}; the service refreshes them on a timer.`) : null
    );
  }

  void load();
  return () => {
    alive = false;
  };
}
