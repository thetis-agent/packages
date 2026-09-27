/* Extensions, the built-in section of the control panel: what is installed, in one list. Adding, updating,
 * configuring and removing extensions is the Extensions place of `@thetis/ui-marketplace` (place id
 * `marketplace`, from that package or a copy of it). When that place is here, this section lists every
 * extension installed for this person, each row opening its page there, with "Manage extensions" for the
 * rest. When it is not — never installed, removed, or its module failed to load — a person must still be able
 * to put one in place from the browser, so the section offers exactly that: install from a source, the list of
 * what is installed, and Remove (never on an extension Required by Thetis).
 *
 * Both lists use the columns every extension list uses: Extension (its label in Title Case and the publisher
 * line, "by Thetis · Tools"), Status (at most two chips, each with its tooltip), Version and What it does.
 *
 * One verdict everywhere: when the place is here, the section reads the place's own rows (its `search`
 * command) and judges them with the place's own rules — its browser module `state.js`, byte-identical to its
 * `lib/state.js`, imported from where the place's UI is served — so the labels, publisher lines, chips and the
 * Installed count ("24 installed · 6 part of Thetis", the place's `placeSections(...).counts.installed`) are
 * the place's and nothing is restated. Without the place, what is left is a short fallback (`FALLBACK`): the
 * label, the publisher line, Required, and the chips said plainly, held to the place's chips by
 * `test/panel-packages.test.js`.
 *
 * What the gateway itself can know comes from `src/panel.ts`, which serves `kernel.packages.list()` with this
 * person's own configuration state and imports no domain package. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { busy, button, confirm, heading, put, table } from "../lib/panel-ui.js";
import * as registry from "../lib/registry.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

/** The id of the Extensions place, as `@thetis/ui-marketplace` declares it (a copy of that package declares the same). */
export const MARKETPLACE_ID = "marketplace";

// ---- the fallback: what this list says without the Extensions place ----

/** The four chips, in the order they are shown, each with its tone and tooltip: the place's words. */
export const CHIPS = Object.freeze({
  needsSetup: Object.freeze({ id: "needsSetup", label: "Needs setup", tone: "err", tooltip: "Something must be set before it works. Open it to set it up." }),
  updateAvailable: Object.freeze({ id: "updateAvailable", label: "Update available", tone: "warn", tooltip: "A newer version is ready. Updating keeps your settings." }),
  customized: Object.freeze({ id: "customized", label: "Customized", tone: "dim", tooltip: "You are using your own changed copy instead of the official one." }),
  forEveryone: Object.freeze({ id: "forEveryone", label: "For everyone", tone: "accent", tooltip: "An admin gives this to every person." }),
});
const CHIP_ORDER = ["needsSetup", "updateAvailable", "customized", "forEveryone"];
/** Everyone's by an admin's act (a mark, a promotion) carries the chip; the installation's own list does not. */
const FOR_EVERYONE_BY = ["marked", "promoted", undefined, null];
export const WAITING = "Waiting for your admin to finish setting this up";
export const REQUIRED = Object.freeze({ types: ["gateway", "provider", "storage", "host"], names: ["@thetis/harness-core", "@thetis/marketplace", "@thetis/ui-marketplace", "@thetis/ui-admin", "@thetis/gateway-login", "@thetis/gateway-web"], label: "Required by Thetis" });

const scopeOf = (name) => /^@([^/]+)\//.exec(String(name ?? ""))?.[1] ?? "";
const baseOf = (name) => String(name ?? "").replace(/^@[^/]+\//, "");
const originNameOf = (r) => r?.fork?.name ?? r?.forkedFrom?.name ?? null;
const isCopy = (r) => !!originNameOf(r);
const isPromoted = (r) => r?.everyoneBy === "promoted";

/** Nothing removes it, for anyone: a copy of one of these is required too. */
export const isRequired = (r) => REQUIRED.types.includes(r?.type) || REQUIRED.names.includes(r?.name) || REQUIRED.names.includes(originNameOf(r));

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);
const titleCase = (label) => String(label ?? "").trim().split(/\s+/).map((w, i) => (/[A-Z]/.test(w) || (i > 0 && SMALL.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

/** The name a person reads, in Title Case: the manifest's label, else the bare name with dashes as spaces. */
export const labelOf = (r) => titleCase(r?.label || baseOf(r?.name).replace(/^ui-/, "").replace(/[-_.]+/g, " ") || r?.name);

/** What an extension brings, first two: "Tools · Page". */
export function typeOf(r) {
  const kinds = [];
  if ((r?.tools?.length ?? 0) > 0) kinds.push("Tools");
  if (r?.hasSkills || r?.type === "skill") kinds.push("Skills");
  if ((r?.pages ?? 0) > 0 || r?.type === "ui") kinds.push("Page");
  if (r?.type === "provider") kinds.push("Models");
  if (r?.service || ["service", "loader", "gateway", "storage", "host", "skill-type"].includes(r?.type)) kinds.push("Background");
  return kinds.slice(0, 2).join(" · ");
}

/** Who it is by: "by Thetis", "by you", "by <person>". A shared copy is by the person whose original is among `rows`. */
export function publisherOf(r, { user = "", rows = [] } = {}) {
  const scope = scopeOf(r?.name);
  if (isPromoted(r)) {
    const original = rows.find((m) => m !== r && scopeOf(m.name) && scopeOf(m.name) !== "thetis" && baseOf(m.name) === baseOf(r.name) && !isCopy(m));
    const who = original ? scopeOf(original.name) : "";
    return !who ? "by Thetis" : who === user ? "by you" : `by ${who}`;
  }
  if (scope === "thetis") return "by Thetis";
  if ((user && scope === user) || r?.source === "local") return "by you";
  return scope ? `by ${scope}` : "by you";
}

export const publisherLine = (r, ctx) => [publisherOf(r, ctx), typeOf(r)].filter(Boolean).join(" · ");

/**
 * The state of one installed row without the place: `{ chips, attention, reason, waiting }`. The chips are the
 * place's (a customised copy behind its official version is Customized, never Update available); the sentence is
 * said plainly, since the place's full wording lives in the place. A missing setting only an admin can set is
 * Needs setup for an admin and the grey waiting line for anyone else.
 */
export function stateOf(r, { admin = false } = {}) {
  const report = r?.config;
  const keys = Array.isArray(report?.keys) ? report.keys.filter((k) => k && k.state === "missing") : [];
  const adminsFix = (k) => k.scope === "system" || (Array.isArray(k.missing) && k.missing.length > 0 && k.source !== "user");
  const mine = keys.filter((k) => !adminsFix(k)).length || (report?.broken && !keys.length);
  const admins = keys.filter(adminsFix).length;
  const setup = report && mine ? { chip: true, waiting: false } : report && admins ? (admin ? { chip: true, waiting: false } : { chip: false, waiting: true }) : { chip: false, waiting: false };
  const newer = r?.update?.apply === "install" && r.update.version !== r.version ? r.update.version : null;
  const update = newer ? `Version ${newer} is ready; you have ${r.version}.` : r?.loaded && r.loaded !== r.version ? `Version ${r.version} is ready; you have ${r.loaded}.` : null;
  const on = { needsSetup: setup.chip, updateAvailable: !!update, customized: isCopy(r) && !r.fork?.identical, forEveryone: !!r?.everyone && FOR_EVERYONE_BY.includes(r.everyoneBy) };
  const chips = CHIP_ORDER.filter((id) => on[id]).slice(0, 2).map((id) => CHIPS[id]);
  const reason = setup.chip ? `${labelOf(r)} needs setting up before it works. Open it to set it up.` : update ?? (setup.waiting ? `${WAITING}.` : "");
  return { chips, attention: setup.chip || !!update, reason, waiting: setup.waiting };
}

/** The installed rows with what the place's rows add: a registry's newer commit, as `update`. */
export function withKnown(mine, all = []) {
  const byName = new Map(all.map((r) => [r.name, r]));
  return mine.map((r) => {
    const u = byName.get(r.name)?.update;
    return u?.apply === "install" ? { ...r, update: { apply: "install", version: u.version } } : r;
  });
}

/** The fallback's rules, in the shape `judged` reads. */
export const FALLBACK = Object.freeze({ place: false });

/**
 * One installed row as a surface draws it: `{ label, publisher, state }`. With the place's module (`rules.place`)
 * it is exactly the place's verdict, family and giver included; without it, the fallback's.
 */
export function judged(r, rows, { rules = FALLBACK, user = "", admin = false } = {}) {
  if (!rules.place) return { label: labelOf(r), publisher: publisherLine(r, { user, rows }), state: stateOf(r, { admin, user }) };
  const m = rules.place;
  const family = m.familyOf(r, rows);
  const origin = m.officialOf(r, family);
  const label = m.labelOf(r, origin);
  const giver = typeof m.giverOf === "function" ? m.giverOf(r, { user, family: family.members }) : undefined;
  return { label, publisher: m.publisherLine(r, { user, family: family.members }), state: m.stateOf(r, { admin, origin, label, user, giver }) };
}

/** "24 installed · 6 part of Thetis": the place's Installed count, with its own parts apart. */
export function countLine(rows, { rules = FALLBACK, user = "", admin = false } = {}) {
  const have = rows.filter((r) => r.installed !== false);
  if (!rules.place) return `${have.length} installed`;
  const n = rules.place.placeSections(rows, { user, admin }).counts.installed;
  const parts = have.filter((r) => r.component).length;
  return `${n} installed${parts ? ` · ${parts} part of Thetis` : ""}`;
}

/** The row's chips as badges with their tooltips, and the grey waiting line when only an admin can finish it. */
function statusCell(said) {
  const chips = said.state.chips.map((c) => el("span", { class: `badge is-${c.tone}`, title: c.tooltip }, c.label));
  return el("span", { class: "tags" }, ...chips, said.state.waiting ? el("span", { class: "text-faint" }, WAITING) : null);
}

/** The Extension cell: the label with the raw id as its tooltip, and the publisher line under it. */
const extensionCell = (r, said) => el("span", { class: "cell-name", title: r.name }, el("span", {}, said.label), el("div", { class: "text-faint" }, said.publisher));

/** What the place's browser module must answer for the section to use it rather than the fallback. */
const PLACE_RULES = ["placeSections", "stateOf", "familyOf", "officialOf", "labelOf", "publisherLine"];

export function mountPackages(root, { user, role }, shell) {
  let installed = [];
  let known = []; // every row the Extensions place knows, for whose a shared copy is
  let rules = FALLBACK; // the place's own rules when its module loaded, else the fallback
  const body = el("div", { class: "panel-col ext-bootstrap" });
  root.append(body);

  /** The Extensions place, when a package declared it here and loaded: the way to manage extensions. With a
   *  name it opens that extension's page there. */
  const place = () => {
    const entry = registry.entries("places").find((e) => e.id === MARKETPLACE_ID && !registry.failureOf(e.package));
    return entry && shell?.openPlace ? (name) => shell.openPlace(entry.key, typeof name === "string" ? { name } : undefined) : null;
  };

  /**
   * Every row the Extensions place knows (installed, on disk, in a registry, in the person's folder), from its
   * `search` command, when the place is here: a shared copy finds the person whose original it was made from
   * among them, and an installed row learns of a registry's newer commit. Without the place, or when it does not
   * answer, the list says what the gateway itself knows.
   */
  async function everyRow() {
    const entry = registry.entries("places").find((e) => e.id === MARKETPLACE_ID && !registry.failureOf(e.package));
    if (!entry) return [];
    try {
      const out = await api(`/api/ext/${entry.package}/search`, { method: "POST", body: { args: { folder: true } } });
      return Array.isArray(out?.data?.rows) ? out.data.rows : [];
    } catch {
      return [];
    }
  }

  /** The place's own rules: its browser module `state.js`, from where its UI is served, or the fallback. */
  async function placeRules() {
    const entry = registry.entries("places").find((e) => e.id === MARKETPLACE_ID && !registry.failureOf(e.package));
    if (!entry) return FALLBACK;
    try {
      const base = registry.declared(entry.package)?.base || `ext/${entry.package}/`;
      const mod = await import(new URL(`${base}state.js`, document.baseURI).href);
      return PLACE_RULES.every((k) => typeof mod[k] === "function") ? { place: mod } : FALLBACK;
    } catch {
      return FALLBACK;
    }
  }

  async function load() {
    const stop = busy(body, "Reading what is installed…");
    try {
      const [mine, all, found] = await Promise.all([api("/api/packages"), everyRow(), placeRules()]);
      known = all;
      installed = withKnown(mine, all);
      // The place's verdict needs the place's rows; without them the fallback speaks.
      rules = found.place && all.some((r) => r.installed) ? found : FALLBACK;
    } catch (err) {
      stop();
      clear(body);
      put(body, el("p", { class: "panel-hint is-error" }, `What is installed could not be read: ${err.message}`), button("Try again", { onClick: () => void load() }));
      return;
    }
    stop();
    draw();
  }

  /** The columns every extension list uses. */
  function columns() {
    const every = rules.place ? known : [...installed, ...known.filter((k) => !installed.some((r) => r.name === k.name))];
    const ctx = { rules, user, admin: role === "admin" };
    const saying = new Map();
    const said = (r) => saying.get(r.name) ?? saying.set(r.name, judged(r, every, ctx)).get(r.name);
    return [
      { key: "name", label: "Extension", render: (r) => extensionCell(r, said(r)) },
      { key: "status", label: "Status", render: (r) => statusCell(said(r)) },
      { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
      { key: "description", label: "What it does", render: (r) => el("span", { class: "text-dim" }, r.description || "—") },
    ];
  }

  function draw() {
    clear(body);
    const open = place();
    const listed = rules.place ? known.filter((r) => r.installed) : installed;
    const count = countLine(rules.place ? known : installed, { rules, user, admin: role === "admin" });
    const name = (r) => (rules.place ? judged(r, known, { rules, user, admin: role === "admin" }).label : labelOf(r));
    const rows = [...listed].sort((a, b) => name(a).localeCompare(name(b)));
    if (open) {
      put(
        body,
        heading("Extensions", count),
        el("div", { class: "row" }, el("p", { class: "panel-hint" }, "Every extension installed for you. Open one to see it, set it up, update or remove it."), button("Manage extensions", { tone: "primary", onClick: () => open() })),
        table(columns(), rows, { empty: "Nothing is installed here.", onRow: (r) => open(r.name) })
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
          ...columns(),
          // Thetis cannot work without a Required extension: there is no Remove for it, here or anywhere.
          { key: "remove", label: "", render: (r) => (isRequired(r) ? el("span", { class: "text-faint" }, REQUIRED.label) : button("Remove", { tone: "warn", onClick: (e) => { e.stopPropagation(); void removeRow(r, e.currentTarget); } })) },
        ],
        rows,
        { empty: "Nothing is installed here." }
      )
    );
  }

  function addBlock() {
    const input = el("input", { class: "input", type: "text", placeholder: "@thetis/ui-marketplace, packages/<name>, or a git URL", "aria-label": "Extension source", spellcheck: "false" });
    const go = button("Install", { tone: "primary", onClick: () => void add() });
    const block = el("div", { class: "card add-block" }, el("div", { class: "card-head" }, "Install from a source"), el("div", { class: "card-body" }, el("div", { class: "row" }, input, go), el("p", { class: "text-faint" }, `A Thetis extension goes in by its name, such as @thetis/ui-marketplace. Anything else is a path under your home or a git source, built here; name your own @${user}/<name>. Building can take a minute.`)));
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
      lines: [["extension", labelOf(row)], ["from", "your space"]],
      note: `Your saved settings are kept. ${row.replaced ? `Its files stay where they are. ${row.replaced} comes back in its place.` : "Its files stay where they are; what it adds stops from your next message."}`,
      confirmLabel: "Remove",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(body, "Removing…");
    try {
      await api(`/api/packages/${enc(row.name)}`, { method: "DELETE" });
      toast(`${labelOf(row)} was removed.`, { tone: "good" });
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
