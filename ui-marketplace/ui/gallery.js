/* The gallery: a search box, one chip per package type, a note on the index, and a card per package.
 * Installed packages come first, then what the registries offer. The search runs on the server through
 * the `search` command, because the index and its ranking live there; the page only keeps the last query
 * so coming back from a package page shows the same list. Clicking a card re-opens the place with the
 * package's name. */

import { stateBadges } from "./badges.js";

/** Kept across opens: the query a person came back to. */
const last = { q: "", type: "" };

export function openGallery(ext, root) {
  const { el, clear } = ext.dom;
  const { badge, busy, put, when } = ext.ui;
  let alive = true;
  let rows = [];
  let facts = { indexed: false, updatedAt: null, registries: [], total: 0 };
  const types = new Set();
  let timer = null;

  const input = el("input", { class: "input mk-search", type: "search", placeholder: "Search packages", "aria-label": "Search packages", value: last.q, spellcheck: "false" });
  input.addEventListener("input", () => {
    last.q = input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  });
  const chips = el("div", { class: "mk-chips", role: "group", "aria-label": "Package type" });
  const note = el("p", { class: "mk-note" });
  const cards = el("div", { class: "mk-cards" });
  const page = el("div", { class: "mk-gallery" }, el("div", { class: "mk-toolbar" }, input, chips), note, cards);
  root.append(page);

  async function load() {
    const stop = busy(cards, "Reading the marketplace…");
    try {
      const out = await ext.request("search", { args: { q: last.q, type: last.type } });
      if (!alive) return;
      const data = out?.data ?? {};
      rows = Array.isArray(data.rows) ? data.rows : [];
      facts = { indexed: !!data.indexed, updatedAt: data.updatedAt ?? null, registries: Array.isArray(data.registries) ? data.registries : [], total: data.total ?? 0 };
      for (const r of rows) if (r.type) types.add(r.type);
    } catch (err) {
      if (!alive) return;
      rows = [];
      ext.toast(err?.message || "The marketplace could not be read.", { tone: "error" });
    } finally {
      stop();
    }
    if (alive) draw();
  }

  function chip(type, label) {
    const active = last.type === type;
    return el("button", { type: "button", class: `mk-chip${active ? " is-active" : ""}`, "data-type": type, "aria-pressed": String(active), onClick: () => { last.type = type; void load(); } }, label);
  }

  function drawChips() {
    clear(chips);
    if (last.type) types.add(last.type);
    chips.append(chip("", "All"), ...[...types].sort().map((t) => chip(t, t)));
  }

  function noteText() {
    const installed = rows.filter((r) => r.installed).length;
    if (!facts.indexed) return `${installed} installed · no marketplace index yet`;
    const names = facts.registries.map((r) => r.name).join(", ") || "none";
    const failed = facts.registries.filter((r) => r.error).length;
    return `${facts.registries.length === 1 ? "registry" : "registries"} ${names} · refreshed ${when(facts.updatedAt) || "never"} · ${facts.total} ${facts.total === 1 ? "package" : "packages"}${failed ? ` · ${failed} failed to refresh` : ""}`;
  }

  function card(r) {
    return el(
      "button",
      { type: "button", class: `mk-card${r.installed ? " is-installed" : ""}`, "data-name": r.name, onClick: () => ext.open.place("marketplace", { name: r.name }) },
      el("div", { class: "mk-card-head" }, el("code", { class: "mk-card-name" }, r.name), el("span", { class: "mk-card-version" }, r.version)),
      el("p", { class: "mk-card-desc" }, r.description || "No description."),
      el("div", { class: "mk-card-foot" }, el("span", { class: "mk-card-meta" }, [r.type, r.registry].filter(Boolean).join(" · ")), el("div", { class: "tags" }, ...stateBadges(badge, r)))
    );
  }

  function draw() {
    drawChips();
    note.textContent = noteText();
    clear(cards);
    if (!rows.length) {
      put(cards, el("div", { class: "mk-empty" }, last.q || last.type ? "No package matches." : "Nothing is installed here, and no registry is configured."));
    } else put(cards, ...rows.map(card));
    if (!facts.indexed) put(cards, el("p", { class: "panel-hint mk-hint" }, "No marketplace index yet. Registries are configured under packages[\"@thetis/marketplace\"].registries; the service refreshes them on a timer."));
  }

  void load();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}
