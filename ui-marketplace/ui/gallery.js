/* The Extensions place: one toolbar -- a search box, the type chips (All, Tools, Skills, Pages, Models,
 * Background) and a line on whether everything is up to date -- the one-line legend of the types, then the
 * sections `placeSections` (state.js) sorts the families into:
 *
 * - **Needs your attention (n)**, only when n > 0: a compact to-do strip, one row per extension -- its label, one
 *   sentence why, and one action: **Update**, **Set up** or **Review**. **Update N** beside the heading updates
 *   exactly the Update rows, and says "Your own copies are not touched." The person's own changes waiting to be
 *   applied are a line above it, with **Apply**.
 * - **Installed (n)**: what the person has, with the pills **All · Added by you · For everyone · Customized**.
 *   `n` is the number the Control panel says too. Something an admin installed for them says "Given to you by
 *   <admin>".
 * - **Discover (n)**: what they could add. Never a version of something they already have, never an extension
 *   only an admin may have, unless they are one.
 * - Two folded sections: **Drafts in your folder** (extensions that exist only as folders under their home's
 *   `packages/`; hidden when there are none) and **Part of Thetis** (the parts that make it run -- for a person
 *   who is not an admin, only the ones they have).
 *
 * One card per extension family: an original, its copies and a shared copy of it are one extension with
 * several versions, and the card shows the person's own. A card is the label (its package id only as the
 * label's tooltip), the publisher line ("by Thetis · Tools"), a row of at most two chips, one line of what it
 * does, and what it brings with its version.
 *
 * Every row is read once, with the person's folder, and the search and the chips narrow them here, so a key
 * press is not a round trip; while a search or a type narrows the list, a section with nothing in it is not
 * drawn. The configuration report of each installed extension comes from one `config-list` call after the
 * rows, and folds into the rows so a card's Needs setup is the page's. The query, the type, the pill and which
 * folds are open are kept, so coming back from an extension's page shows the same list. While the place is
 * open the "Updates ready" card stays away: the status line says it. An admin also gets **Registries** in the
 * toolbar, the page in registries.js. */

import { chipNodes } from "./badges.js";
import { FILTERS, PILLS, WORDS, isCopy, kindsOf, placeSections } from "./state.js";
import { updater } from "./updates-notice.js";

/** Kept across opens: the query, the type chip, the Installed pill, and which folded sections are open. */
const last = { q: "", kind: "", pill: "", open: { drafts: false, thetis: false } };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "11 tools", "4 skills", "1 page", "Models", "Runs in the background": what an extension brings, for the card's foot. Never empty. */
export function bringsLine(r) {
  if (r.tools?.length) return plural(r.tools.length, "tool");
  if (r.skills) return plural(r.skills, "skill");
  if (r.pages) return plural(r.pages, "page");
  const kinds = kindsOf(r);
  if (kinds.includes("Models")) return "Models";
  if (kinds.includes("Skills")) return "Skills";
  if (kinds.includes("Page")) return "A page";
  return "Runs in the background";
}

/** The rows with each installed extension's configuration report folded on, so `stateOf` reads it. */
export function withConfig(rows, reports) {
  if (!reports?.size) return rows;
  return rows.map((r) => (r.installed && reports.has(r.name) ? { ...r, config: reports.get(r.name) } : r));
}

/**
 * The sections for a person, narrowed by the search, the type and the pill, and `all`: the same unnarrowed,
 * which is what the status line, the attention count and Update N go by. `own` is the person's own changes
 * waiting to be applied, from the `updates` answer. Exported for the tests: this is the whole of the store's
 * filtering.
 */
export function sections(rows, { user = "", admin = false, updates = null, q = "", kind = "", pill = "" } = {}) {
  const superseded = (updates?.forks ?? []).filter((f) => f.state === "superseded").map((f) => f.name);
  const all = placeSections(rows, { user, admin, superseded });
  const s = q || kind || pill ? placeSections(rows, { user, admin, superseded, q, kind, pill }) : all;
  return { ...s, all, own: updates?.own ?? [] };
}

/** "All up to date", or "Updates ready: Orleans Docs and Web Gateway" -- the one verdict, from the Update rows. */
export function statusText(all, { checked = "", failed = 0 } = {}) {
  const labels = all.attention.filter((e) => e.todo.kind === "update").map((e) => e.label);
  const head = labels.length ? `Updates ready: ${labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : listWords(labels)}` : "All up to date";
  return `${head}${checked ? ` · checked ${checked}` : ""}${failed ? ` · ${failed} ${failed === 1 ? "registry" : "registries"} could not be checked` : ""}`;
}

const listWords = (w) => (w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`);

export function openGallery(ext, root, params) {
  const { el, clear } = ext.dom;
  const { badge, busy, put, when, button } = ext.ui;
  let alive = true;
  let rows = [];
  let who = { user: "", admin: false };
  let pending = null; // the `updates` answer, or null when this page cannot ask for it
  let reports = new Map(); // package -> its short configuration report, for installed packages
  let facts = { indexed: false, updatedAt: null, registries: [], total: 0 };
  // While the place is open the "Updates ready" card stays away; the status line says what it would.
  const release = updater()?.hold?.() ?? null;

  const input = el("input", { class: "input mk-search", type: "search", placeholder: "Search extensions…", "aria-label": "Search extensions", value: last.q, spellcheck: "false" });
  input.addEventListener("input", () => {
    last.q = input.value.trim();
    draw();
  });
  const chips = el("div", { class: "mk-chips", role: "group", "aria-label": "Type" });
  const status = el("p", { class: "mk-status", role: "status" });
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

  /** The status line: the one update verdict, and when the registries were last read. */
  function drawStatus(all) {
    const checked = facts.updatedAt ? when(facts.updatedAt) || "just now" : "";
    status.textContent = statusText(all, { checked, failed: facts.registries.filter((r) => r.error).length });
  }

  const open = (name, extra = {}) => ext.open.place("marketplace", { name, ...extra });

  function card(entry) {
    const r = entry.row;
    const { state } = entry;
    return el(
      "button",
      { type: "button", class: `mk-card${r.installed ? " is-installed" : ""}`, "data-name": r.name, onClick: () => open(r.name) },
      el("div", { class: "mk-card-head" }, el("span", { class: "mk-card-label", title: r.name }, entry.label), r.version ? el("span", { class: "mk-card-version" }, `v${r.version}`) : null),
      el("p", { class: "mk-card-by" }, entry.publisher),
      el("div", { class: "mk-card-chips tags" }, ...chipNodes(badge, state.chips)),
      el("p", { class: "mk-card-desc" }, entry.summary || "No description."),
      entry.given ? el("span", { class: "mk-card-note" }, entry.given) : state.waiting ? el("span", { class: "mk-card-note" }, WORDS.waiting) : null,
      el("span", { class: "mk-card-foot" }, el("span", {}, bringsLine(r)))
    );
  }

  /** One to-do row: the label (which opens the page), the one sentence, and the one action. */
  function todoRow(entry, u) {
    const { todo, row: r } = entry;
    const act = () => {
      if (todo.kind === "update" && u) return void u.updateSome([r.name]);
      open(r.name, todo.kind === "setup" || todo.kind === "optional" ? { tab: "settings" } : {});
    };
    return el(
      "li",
      { class: `mk-todo is-${todo.tone}`, "data-name": r.name, "data-kind": todo.kind },
      el("button", { type: "button", class: "mk-todo-label", title: r.name, onClick: () => open(r.name) }, entry.label),
      el("span", { class: "mk-todo-reason" }, todo.reason),
      button(todo.action, { tone: todo.kind === "update" || todo.kind === "setup" ? "primary" : "quiet", onClick: act })
    );
  }

  function section(id, title, count, content, { action = null, empty = null, extra = null } = {}) {
    return el(
      "section",
      { class: "mk-section", id, "aria-label": title },
      el("div", { class: "mk-section-head" }, el("h3", { class: "mk-section-title" }, `${title} (${count})`), action),
      extra,
      count ? content : empty ? el("p", { class: "mk-none" }, empty) : null
    );
  }

  const cards = (entries) => el("div", { class: "mk-cards" }, ...entries.map(card));

  /** A folded section. It opens by itself while a search has something in it, and otherwise keeps what the person chose. */
  function fold(key, id, title, entries, note) {
    const searching = !!(last.q || last.kind);
    const node = el(
      "details",
      { class: "mk-fold", id, open: (searching ? entries.length > 0 : last.open[key]) || null },
      el("summary", { class: "mk-fold-head" }, el("span", { class: "mk-section-title" }, `${title} (${entries.length})`), note ? el("span", { class: "mk-fold-note" }, note) : null),
      cards(entries)
    );
    node.addEventListener("toggle", () => {
      if (!searching) last.open[key] = node.open;
    });
    return node;
  }

  /** The pills over Installed, each with how many it holds. */
  function pills(counts) {
    return el(
      "div",
      { class: "mk-pills", role: "group", "aria-label": "Show" },
      ...PILLS.map((p) => {
        const active = last.pill === p.id;
        const n = p.id ? counts[p.id] : counts.installed;
        return el("button", { type: "button", class: `mk-pill-btn${active ? " is-active" : ""}`, "data-pill": p.id, "aria-pressed": String(active), disabled: !n && !active ? true : null, onClick: () => { last.pill = p.id; draw(); } }, p.label, el("span", { class: "mk-pill-n" }, String(n)));
      })
    );
  }

  function draw() {
    drawChips();
    const s = sections(withConfig(rows, reports), { ...who, updates: pending, q: last.q, kind: last.kind, pill: last.pill });
    drawStatus(s.all);
    clear(body);
    const u = updater();
    const narrowed = !!(last.q || last.kind);
    const updateNames = s.all.updates;
    const updateN = updateNames.length && u ? button(`Update ${updateNames.length}`, { tone: "primary", title: "Update exactly the extensions with an Update button below", onClick: () => void u.updateSome(updateNames) }) : null;
    const ownLine = s.own.length && u
      ? el("div", { class: "mk-own" }, el("span", {}, `Your changes to ${s.own.map((o) => o.label).join(", ")} are ready to use.`), button("Apply", { tone: "primary", onClick: () => void u.applyOwn(pending, { asked: true }) }))
      : null;
    const attention = s.attention.length
      ? section("mk-attention", WORDS.sections.attention, s.attention.length, el("ul", { class: "mk-todos" }, ...s.attention.map((e) => todoRow(e, u))), {
          // The note only where it is news: a person with copies of their own.
          action: updateN ? el("div", { class: "mk-update-n" }, rows.some((r) => r.installed && isCopy(r)) ? el("span", { class: "mk-update-note" }, WORDS.updateAllNote) : null, updateN) : null,
        })
      : null;
    // While a search or a type narrows the list, a section with nothing in it is not drawn at all.
    const installed = narrowed && !s.installed.length
      ? null
      : section("mk-installed", WORDS.sections.installed, s.installed.length, cards(s.installed), {
          extra: s.all.counts.installed ? pills(s.all.counts) : null,
          empty: last.pill ? "None of these." : narrowed ? null : "Nothing installed yet. Discover has what you can add.",
        });
    const discover = narrowed && !s.discover.length ? null : section("mk-discover", WORDS.sections.discover, s.discover.length, cards(s.discover), { empty: "Nothing else to add right now." });
    const drafts = s.drafts.length ? fold("drafts", "mk-drafts", WORDS.sections.drafts, s.drafts, "Extensions in your home's packages folder that are not installed.") : null;
    const thetis = s.thetis.length ? fold("thetis", "mk-thetis", WORDS.sections.thetis, s.thetis, who.admin ? "The parts that make Thetis run." : "The parts that make Thetis run, as you have them.") : null;
    const nothing = narrowed && !s.attention.length && !s.installed.length && !s.discover.length && !s.drafts.length && !s.thetis.length ? el("p", { class: "mk-none" }, "Nothing matches.") : null;
    put(
      body,
      ownLine,
      attention,
      installed,
      discover,
      drafts || thetis ? el("div", { class: "mk-folds" }, drafts, thetis) : null,
      nothing,
      !facts.indexed && who.admin ? el("p", { class: "panel-hint mk-hint" }, `No marketplace index yet. ${registriesBtn ? "Registries are set under Registries above" : "Registries are configured under packages[\"@thetis/marketplace\"].registries"}; the service refreshes them on a timer.`) : null
    );
  }

  void load();
  return () => {
    alive = false;
    release?.();
  };
}
