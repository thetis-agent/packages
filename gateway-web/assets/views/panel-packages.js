/* Extensions, the built-in section of the control panel: what is installed, in one list. Adding, updating,
 * configuring and removing extensions is the Extensions place of `@thetis/ui-marketplace` (place id
 * `marketplace`, from that package or a copy of it). When that place is here, this section lists every
 * extension installed for this person, each row opening its page there, with "Manage extensions" for the
 * rest. When it is not — never installed, removed, or its module failed to load — a person must still be able
 * to put one in place from the browser, so the section offers exactly that: install from a source, the list of
 * what is installed, and Remove (never on an extension Required by Thetis).
 *
 * Both lists use the columns every extension list uses: Extension (its label in Title Case and the publisher
 * line, "by Thetis · Tools"), Status (at most two chips, each with its tooltip), Version and What it does, and
 * the count is what is installed for this person, the same number the Extensions place and the admin's All
 * extensions give. The chips follow the Extensions contract's one state; the place's `lib/state.js` is the
 * reference, and the few rules this list needs are restated here (a page may import only its own package's
 * files), held to it by `test/panel-packages.test.js`.
 *
 * What the gateway itself can know comes from `src/panel.ts`, which serves `kernel.packages.list()` with this
 * person's own configuration state and imports no domain package. Everything the registries know (search,
 * pages, updates, publishing, a copy of an extension and the way back to the official one, what everyone
 * gets) lives in the Extensions place only, so this section has no second copy of any of it. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { busy, button, confirm, heading, put, table } from "../lib/panel-ui.js";
import * as registry from "../lib/registry.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

/** The id of the Extensions place, as `@thetis/ui-marketplace` declares it (a copy of that package declares the same). */
export const MARKETPLACE_ID = "marketplace";

// ---- the one state, as this list needs it (the Extensions place's lib/state.js is the reference) ----

/** The four chips, in the order they are shown, each with its tone and tooltip. */
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

function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ""] = String(v ?? "").split(/-(.*)/s);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

const listOf = (words) => {
  const w = words.filter(Boolean);
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
};

/** A key's help as a thing a person can be asked for; nothing about the server's `.env`, which is the admin's. */
function phraseOf(help) {
  let s = String(help ?? "").trim();
  if (!s) return null;
  s = s.split(/(?<=[.!?])\s+/)[0];
  s = s.split(/;|\s[—–]\s/)[0];
  s = s.replace(/,?\s*e\.g\..*$/i, "");
  if (/\.env\b|\benvironment\b/i.test(s)) return null;
  s = s.replace(/[.,:!?\s]+$/, "").trim();
  if (!s) return null;
  if (s.length > 90) s = s.split(",")[0].trim();
  if (/^[A-Z][a-z]/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}
const needText = (k) => `${phraseOf(k?.help) ?? (k?.secret ? "a secret value" : "a value")} (${k.key})`;

/** Whose version a copy goes back to: "Thetis's", "your", "bitmuse's". */
const ownerWord = (name, user) => {
  const scope = scopeOf(name);
  return !scope || scope === "thetis" ? "Thetis's" : scope === user ? "your" : `${scope}'s`;
};

/**
 * The state of one installed row for this person: `{ chips, attention, reason, waiting }`. Needs setup is a
 * missing key the person can set; one only an admin can set (a `${VAR}` the server lacks, a system-scoped key)
 * is Needs setup for an admin and the grey waiting line for everyone else. Update available is a newer copy on
 * disk than this person's workspace loaded, or a customised copy whose official version moved past the one it
 * was made from. The sentences are the place's.
 */
export function stateOf(r, { admin = false, user = "" } = {}) {
  const report = r?.config;
  const keys = Array.isArray(report?.keys) ? report.keys.filter((k) => k && k.state === "missing") : [];
  const adminsFix = (k) => k.scope === "system" || (Array.isArray(k.missing) && k.missing.length > 0 && k.source !== "user");
  let mine = keys.filter((k) => !adminsFix(k));
  const admins = keys.filter(adminsFix);
  if (report?.broken && !keys.length) mine = [{ key: "" }];
  let setup = { chip: false, waiting: false, reason: "" };
  if (report && mine.length) {
    const named = mine.filter((k) => k.key);
    setup = { chip: true, waiting: false, reason: named.length ? `Add ${listOf(named.map(needText))} in Settings to start using it.` : `${report.summary || "Something is missing"}. Open Settings to fix it.` };
  } else if (report && admins.length) {
    const k = admins[0];
    const where = `Set it for everyone in Control panel → Extensions → ${labelOf(r)} → Settings.`;
    setup = !admin ? { chip: false, waiting: true, reason: `${WAITING}.` } : { chip: true, waiting: false, reason: Array.isArray(k.missing) && k.missing.length ? `${listOf(k.missing)} ${k.missing.length === 1 ? "is" : "are"} not in the server's environment, so ${k.key} has no value. ${where}` : `${k.key} is not set. ${where}` };
  }
  const shipped = r?.fork?.shipped;
  const base = r?.fork?.version ?? r?.forkedFrom?.version;
  const owner = ownerWord(originNameOf(r), user);
  const whose = owner === "your" ? "Your original" : `${owner.charAt(0).toUpperCase()}${owner.slice(1)} version`;
  const update = r?.loaded ? `Version ${r.version} is ready; you have ${r.loaded}. Updating keeps your settings.` : isCopy(r) && shipped && base && compareVersions(shipped, base) > 0 ? `${whose} ${shipped} is newer than the ${base} your copy was made from.` : null;
  const on = { needsSetup: setup.chip, updateAvailable: !!update, customized: isCopy(r) && !r.fork?.identical, forEveryone: !!r?.everyone && FOR_EVERYONE_BY.includes(r.everyoneBy) };
  const chips = CHIP_ORDER.filter((id) => on[id]).slice(0, 2).map((id) => CHIPS[id]);
  const reason = setup.chip ? setup.reason : update ?? (setup.waiting ? setup.reason : "");
  return { chips, attention: setup.chip || !!update, reason, waiting: setup.waiting };
}

/** The row's chips as badges with their tooltips, and the grey waiting line when only an admin can finish it. */
function statusCell(r, ctx) {
  const state = stateOf(r, ctx);
  const chips = state.chips.map((c) => el("span", { class: `badge is-${c.tone}`, title: c.tooltip }, c.label));
  return el("span", { class: "tags" }, ...chips, state.waiting ? el("span", { class: "text-faint" }, WAITING) : null);
}

/** The Extension cell: the label with the raw id as its tooltip, and the publisher line under it. */
const extensionCell = (r, ctx) => el("span", { class: "cell-name", title: r.name }, el("span", {}, labelOf(r)), el("div", { class: "text-faint" }, publisherLine(r, ctx)));

export function mountPackages(root, { user, role }, shell) {
  let installed = [];
  const body = el("div", { class: "panel-col ext-bootstrap" });
  root.append(body);

  /** The Extensions place, when a package declared it here and loaded: the way to manage extensions. With a
   *  name it opens that extension's page there. */
  const place = () => {
    const entry = registry.entries("places").find((e) => e.id === MARKETPLACE_ID && !registry.failureOf(e.package));
    return entry && shell?.openPlace ? (name) => shell.openPlace(entry.key, typeof name === "string" ? { name } : undefined) : null;
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

  /** The columns every extension list uses. */
  function columns() {
    const ctx = { user, admin: role === "admin", rows: installed };
    return [
      { key: "name", label: "Extension", render: (r) => extensionCell(r, ctx) },
      { key: "status", label: "Status", render: (r) => statusCell(r, ctx) },
      { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
      { key: "description", label: "What it does", render: (r) => el("span", { class: "text-dim" }, r.description || "—") },
    ];
  }

  function draw() {
    clear(body);
    const open = place();
    const count = `${installed.length} installed`;
    const rows = [...installed].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
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
