// One state per extension: the same answer on every screen. This file is the reference. It is pure -- no DOM,
// no imports, no I/O -- so the browser module `ui/state.js` is a byte-identical copy of it (a page may import
// only its own files, and a test holds the two together), and `@thetis/ui-admin` mirrors its rules, pinned by a
// test of its own that gives both the same fixture rows.
//
// What it answers, for a row of `lib/rows.js` (with `config`, the kernel's `config.show` report, folded on when
// the page has one):
//
// - `stateOf(row)`: at most two chips, whether the extension needs the person's attention, and the one
//   sentence the page's banner says.
// - `publisherOf(row)` and `typeOf(row)`: the line under every name, "by Thetis · Tools".
// - `familiesOf(rows)`: one card per extension family -- an original, its copies, and a promoted copy of it
//   are one extension with several versions, and the person sees the one that is theirs.
// - `placeSections(rows)`: which section of the Extensions place each family's card goes in.
// - `isRequired(row)` and `isAdminOnly(row)`: what nobody removes, and what a person never installs.
// - `matches(row, q)`: the search, with a small list of synonyms.
//
// The rules are data (`CHIPS`, `CHIP_ORDER`, `REQUIRED`, `ADMIN_ONLY`, `FOR_EVERYONE_BY`, `KINDS`, `FILTERS`,
// `SYNONYMS`, `WORDS`), so a second surface can read the same rules rather than restate them.

/** The four chips, in the order they are shown. `tone` is the shell's badge tone: err is red, warn amber, dim neutral, accent blue. */
export const CHIPS = Object.freeze({
  needsSetup: Object.freeze({ id: "needsSetup", label: "Needs setup", tone: "err", tooltip: "Something must be set before it works. Open it to set it up." }),
  updateAvailable: Object.freeze({ id: "updateAvailable", label: "Update available", tone: "warn", tooltip: "A newer version is ready. Updating keeps your settings." }),
  customized: Object.freeze({ id: "customized", label: "Customized", tone: "dim", tooltip: "You are using your own changed copy instead of the official one." }),
  forEveryone: Object.freeze({ id: "forEveryone", label: "For everyone", tone: "accent", tooltip: "An admin gives this to every person." }),
});
export const CHIP_ORDER = Object.freeze(["needsSetup", "updateAvailable", "customized", "forEveryone"]);
export const MAX_CHIPS = 2;

/**
 * Who decided an extension is everyone's, for the chip. `config` is the installation's own list of what every
 * person starts with: those are Thetis's built-in extensions, and a chip on every one of them says nothing. An
 * admin's mark and a promotion are an admin's act, and those carry the chip. A row whose `everyoneBy` is not
 * known (an older kernel) and is everyone's carries it too.
 */
export const FOR_EVERYONE_BY = Object.freeze(["marked", "promoted", null]);

/** What nothing removes: the button area says "Required by Thetis". A copy of one of these is required too. */
export const REQUIRED = Object.freeze({
  types: Object.freeze(["gateway", "provider", "storage", "host"]),
  names: Object.freeze(["@thetis/harness-core", "@thetis/marketplace", "@thetis/ui-marketplace", "@thetis/ui-admin", "@thetis/gateway-login", "@thetis/gateway-web"]),
  label: "Required by Thetis",
});

/** What only an admin sees offered: never in a person's Discover, never an Install for them. */
export const ADMIN_ONLY = Object.freeze({
  audience: "admin",
  types: Object.freeze(["host", "storage"]),
  names: Object.freeze(["@thetis/gateway-login"]),
  line: "Only an admin can add this.",
});

/** What an extension brings, in the order the publisher line names them. `test` reads a row. */
export const KINDS = Object.freeze([
  Object.freeze({ id: "Tools", test: (r) => (r.tools?.length ?? 0) > 0 }),
  Object.freeze({ id: "Skills", test: (r) => (r.skills ?? 0) > 0 || !!r.hasSkills || r.type === "skill" }),
  Object.freeze({ id: "Page", test: (r) => (r.pages ?? 0) > 0 || r.type === "ui" }),
  Object.freeze({ id: "Models", test: (r) => r.type === "provider" }),
  Object.freeze({ id: "Background", test: (r) => !!r.service || ["service", "loader", "gateway", "storage", "host", "skill-type"].includes(r.type) }),
]);

/** The gallery's type filter: the chip's label and the kind it keeps. */
export const FILTERS = Object.freeze([
  Object.freeze({ id: "", label: "All" }),
  Object.freeze({ id: "Tools", label: "Tools" }),
  Object.freeze({ id: "Skills", label: "Skills" }),
  Object.freeze({ id: "Page", label: "Pages" }),
  Object.freeze({ id: "Models", label: "Models" }),
]);

/** Words a person types for the same thing. A term matches when it, or any word in its group, is found. */
export const SYNONYMS = Object.freeze([Object.freeze(["web", "internet", "google", "search"])]);

/** The fixed sentences, kept together so every surface says the same ones. */
export const WORDS = Object.freeze({
  legend: "Tools let your assistant do things. Skills teach it how. Pages add a screen. Models add a model provider.",
  waiting: "Waiting for your admin to finish setting this up",
  required: REQUIRED.label,
  adminOnly: ADMIN_ONLY.line,
  sections: Object.freeze({ attention: "Needs your attention", added: "Added by you", discover: "Discover", builtin: "Built in", folder: "In your folder", thetis: "Part of Thetis" }),
  settingsPath: (label) => `Control panel → Extensions → ${label} → Settings`,
});

// ---- small pure helpers ----------------------------------------------------------------------------------

/** "a", "a and b", "a, b and c". */
export function listOf(words) {
  const w = words.filter(Boolean);
  if (w.length <= 1) return w.join("");
  return `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

/** Semver-ish order: numeric parts compared as numbers, a pre-release before its release. */
export function compareVersions(a, b) {
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

/** `@bitmuse/notion` → `bitmuse`; `notion` → "". */
export const scopeOf = (name) => (/^@([^/]+)\//.exec(String(name ?? ""))?.[1] ?? "");
/** `@bitmuse/notion` → `notion`. */
export const baseOf = (name) => String(name ?? "").replace(/^@[^/]+\//, "");

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);

/** "extensions and helper chats" → "Extensions and Helper Chats". A word that already has a capital keeps its case. */
export function titleCase(label) {
  return String(label ?? "")
    .trim()
    .split(/\s+/)
    .map((w, i) => (/[A-Z]/.test(w) || (i > 0 && SMALL.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The origin a copy was made from, by name: the kernel's `fork` when the copy is installed, else the manifest's `forkedFrom`. */
export const originNameOf = (row) => row?.fork?.name ?? row?.forkedFrom?.name ?? null;
/** The version of the origin the copy was made from. */
const baseVersionOf = (row) => row?.fork?.version ?? row?.forkedFrom?.version ?? null;
/** A person's copy of another extension. */
export const isCopy = (row) => !!originNameOf(row);
/** A copy promoted into Thetis for everyone: `@thetis/<n>` made from `@<person>/<n>`. */
export const isPromoted = (row) => row?.everyoneBy === "promoted";

/** Nothing removes it, for anyone. */
export function isRequired(row) {
  if (!row) return false;
  if (REQUIRED.types.includes(row.type)) return true;
  return REQUIRED.names.includes(row.name) || REQUIRED.names.includes(originNameOf(row));
}

/** Only an admin is offered it. */
export function isAdminOnly(row) {
  if (!row) return false;
  if (row.audience === ADMIN_ONLY.audience) return true;
  if (ADMIN_ONLY.types.includes(row.type)) return true;
  return ADMIN_ONLY.names.includes(row.name) || ADMIN_ONLY.names.includes(originNameOf(row));
}

/** The kinds an extension brings, in `KINDS` order: ["Tools", "Page"]. */
export function kindsOf(row) {
  return KINDS.filter((k) => k.test(row ?? {})).map((k) => k.id);
}

/** The type half of the publisher line: the first two kinds, "Tools · Page", or "". */
export const typeOf = (row) => kindsOf(row).slice(0, 2).join(" · ");

/** Which label the person reads: the official member's for a copy, Title Case either way. */
export function labelOf(row, origin = null) {
  const own = row?.label || baseOf(row?.name) || String(row?.name ?? "");
  if (isCopy(row) && origin?.label) return titleCase(origin.label);
  return titleCase(own);
}

/**
 * Who an extension is by, as the line under its name says it, without the type: "by Thetis", "by you",
 * "by bitmuse", "from thirteen-games". `family` is the other rows of its family, which is how a promoted copy
 * knows whose original it was made from; `user` is who is reading.
 */
export function publisherOf(row, { user = "", family = [] } = {}) {
  const scope = scopeOf(row?.name);
  if (isPromoted(row)) {
    const original = family.find((m) => m !== row && scopeOf(m.name) && scopeOf(m.name) !== "thetis" && baseOf(m.name) === baseOf(row.name) && !isCopy(m));
    const who = original ? scopeOf(original.name) : "";
    if (!who) return { text: "by Thetis", who: "thetis" };
    return who === user ? { text: "by you", who: "you" } : { text: `by ${who}`, who: "person", person: who };
  }
  if (scope === "thetis") return { text: "by Thetis", who: "thetis" };
  if ((user && scope === user) || row?.local || row?.folder || row?.own) return { text: "by you", who: "you" };
  if (row?.registry && !row?.system) return { text: `from ${row.registry}`, who: "registry", registry: row.registry };
  return scope ? { text: `by ${scope}`, who: "person", person: scope } : { text: "by you", who: "you" };
}

/** The whole line under the name: "by bitmuse · Tools". */
export function publisherLine(row, ctx = {}) {
  const type = typeOf(row);
  return type ? `${publisherOf(row, ctx).text} · ${type}` : publisherOf(row, ctx).text;
}

/** Whose version a copy goes back to, in the possessive: "Thetis's", "your", "bitmuse's". */
export function ownerWord(name, user = "") {
  const scope = scopeOf(name);
  if (!scope || scope === "thetis") return "Thetis's";
  return scope === user ? "your" : `${scope}'s`;
}

/** The action that puts a copy back on its origin: "Use Thetis's version", "Use your original", "Use bitmuse's version". */
export function useOriginLabel(row, user = "") {
  const word = ownerWord(originNameOf(row), user);
  return word === "your" ? "Use your original" : `Use ${word} version`;
}

// ---- what an extension needs before it works ---------------------------------------------------------

/**
 * A key's help as a thing a person can be asked for: the first clause of its first sentence, with the article
 * lower-cased and anything that talks about the server's `.env` left out -- that is the admin's business, and
 * a person cannot act on it. `null` when nothing usable is left.
 */
export function phraseOf(help) {
  let s = String(help ?? "").trim();
  if (!s) return null;
  s = s.split(/(?<=[.!?])\s+/)[0];
  s = s.split(/;|\s[—–]\s/)[0];
  s = s.replace(/,?\s*e\.g\..*$/i, "");
  if (/\.env\b|\benvironment\b/i.test(s)) return null;
  s = s.replace(/[.,:!?\s]+$/, "").trim();
  if (!s) return null;
  if (s.length > 90) s = s.split(",")[0].trim();
  // "The Exa API key" → "the Exa API key"; "Base URL of…" → "base URL of…"; "URL…" stays.
  if (/^[A-Z][a-z]/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}

/** One key as the Needs line names it: "the Exa API key (apiKey)". */
export function needText(k) {
  const phrase = phraseOf(k?.help) ?? (k?.secret ? "a secret value" : "a value");
  return `${phrase} (${k.key})`;
}

/**
 * What an extension needs before it works, from its manifest: the keys a person must give, which is every
 * required key without a default that is not an admin's to set. `row.needs` is `[{ key, secret, help }]`, filled
 * by `lib/rows.js` from the declaration.
 */
export const needsOf = (row) => (Array.isArray(row?.needs) ? row.needs : []);

/** "Needs: the Exa API key (apiKey)", or null. */
export function needsLine(row) {
  const needs = needsOf(row);
  return needs.length ? `Needs: ${listOf(needs.map(needText))}` : null;
}

/**
 * The setup problems of an installed extension, from its configuration report: `row.config`, the kernel's
 * `config.show` answer (or `config-list`'s short form, which carries the same `keys` for the missing ones).
 *
 * A problem is the admin's when a person cannot fix it: a `${VAR}` a default or the admin's layer refers to that
 * is not in the server's environment, or a key declared `scope: "system"`. Everything else -- a required key
 * nobody set, or a `${VAR}` the person wrote themselves -- is the person's.
 *
 * Answers `{ mine, admins, chip, waiting, reason }`. For an admin both kinds are `Needs setup`, with where the
 * admin's kind is fixed; for anyone else the admin's kind is the grey waiting line and never the chip.
 */
export function setupOf(row, { admin = false, label = null } = {}) {
  const report = row?.config;
  const none = { mine: [], admins: [], chip: false, waiting: false, reason: "" };
  if (!row?.installed || !report) return none;
  const keys = Array.isArray(report.keys) ? report.keys.filter((k) => k && k.state === "missing") : [];
  const adminsFix = (k) => k.scope === "system" || (Array.isArray(k.missing) && k.missing.length > 0 && k.source !== "user");
  let mine = keys.filter((k) => !adminsFix(k));
  const admins = keys.filter(adminsFix);
  // A short report that says it is broken and names no key is still broken, and the person is the one asked.
  if (report.broken && !keys.length) mine = [{ key: "", state: "missing", summary: report.summary }];
  const name = label ?? labelOf(row);
  if (mine.length) {
    const named = mine.filter((k) => k.key);
    const reason = named.length ? `Add ${listOf(named.map(needText))} in Settings to start using it.` : `${report.summary || "Something is missing"}. Open Settings to fix it.`;
    return { mine, admins, chip: true, waiting: false, reason };
  }
  if (!admins.length) return none;
  if (!admin) return { mine, admins, chip: false, waiting: true, reason: `${WORDS.waiting}.` };
  const k = admins[0];
  const where = `Set it for everyone in ${WORDS.settingsPath(name)}.`;
  const reason = Array.isArray(k.missing) && k.missing.length
    ? `${listOf(k.missing)} ${k.missing.length === 1 ? "is" : "are"} not in the server's environment, so ${k.key} has no value. ${where}`
    : `${k.key} is not set. ${where}`;
  return { mine, admins, chip: true, waiting: false, reason };
}

// ---- something newer ---------------------------------------------------------------------------------

/**
 * Whether something newer than what the person runs is ready, and what catches it up: `update` (a registry's
 * newer commit, or files on disk newer than what the space loaded) or `origin` (a copy whose official version
 * moved past the version it was made from, or took in all its changes: `superseded`, from the `updates`
 * answer). `origin` is the official member's row, for a copy without the kernel's `fork` facts.
 */
export function updateOf(row, { origin = null, superseded = false, user = "" } = {}) {
  if (!row?.installed) return null;
  const u = row.update;
  if (u && u.apply !== "unfork") {
    const to = u.apply === "reload" ? u.available : u.version;
    const from = u.apply === "reload" ? u.installed : row.version;
    return { kind: "update", to, from, reason: `Version ${to} is ready; you have ${from}. Updating keeps your settings.` };
  }
  if (!isCopy(row)) return null;
  const base = baseVersionOf(row);
  const official = row.fork?.shipped ?? origin?.version ?? null;
  const owner = ownerWord(originNameOf(row), user);
  const whose = owner === "your" ? "Your original" : `${owner.charAt(0).toUpperCase()}${owner.slice(1)} version`;
  if (superseded) return { kind: "origin", to: official, from: base, reason: `${whose}${official ? ` ${official}` : ""} has every change your copy made.` };
  if (official && base && compareVersions(official, base) > 0) return { kind: "origin", to: official, from: base, reason: `${whose} ${official} is newer than the ${base} your copy was made from.` };
  return null;
}

/** A copy that differs from its origin. A copy with no changes at all is not customized, whatever it is called. */
export const isCustomized = (row) => isCopy(row) && !row.fork?.identical;

/** Whether the "For everyone" chip applies: everyone's by an admin's act, not by the installation's own list. */
export const isForEveryone = (row) => !!row?.everyone && FOR_EVERYONE_BY.includes(row.everyoneBy ?? null);

// ---- the one state -------------------------------------------------------------------------------------

/**
 * The state of one extension for one person, the same on every screen.
 *
 * `ctx`: `admin` (whether the reader is an admin), `origin` (the official member's row, for a copy), `label`
 * (what the reader calls it, for the admin's where-to-fix sentence), `superseded` (the `updates` answer's word
 * that a copy's changes are all in the official version), `user` (who is reading).
 *
 * Answers `{ chips, attention, reason, waiting, update, setup }`: `chips` at most two in `CHIP_ORDER`;
 * `attention` Needs setup or Update available on something installed; `reason` one sentence for the banner,
 * or ""; `waiting` the grey line a non-admin reads instead of an admin's problem.
 */
export function stateOf(row, ctx = {}) {
  const label = ctx.label ?? labelOf(row, ctx.origin);
  const setup = setupOf(row, { admin: !!ctx.admin, label });
  const update = updateOf(row, ctx);
  const on = {
    needsSetup: setup.chip,
    updateAvailable: !!update,
    customized: isCustomized(row),
    forEveryone: isForEveryone(row),
  };
  const chips = CHIP_ORDER.filter((id) => on[id]).slice(0, MAX_CHIPS).map((id) => CHIPS[id]);
  const reason = setup.chip ? setup.reason : update ? update.reason : setup.waiting ? setup.reason : "";
  return { chips, attention: !!row?.installed && (setup.chip || !!update), reason, waiting: setup.waiting, update, setup };
}

// ---- families ------------------------------------------------------------------------------------------

/**
 * The name of the original a row's family grows from. A copy follows `forkedFrom` (through a copy of a copy);
 * a promoted `@thetis/<n>` joins the `@<person>/<n>` it was made from when that row is here. A row nothing joins
 * is its own origin.
 */
export function originOf(row, byName) {
  const seen = new Set();
  let name = row.name;
  let cur = row;
  while (cur && !seen.has(name)) {
    seen.add(name);
    const up = originNameOf(cur);
    if (up) {
      name = up;
      cur = byName.get(up) ?? null;
      continue;
    }
    if (isPromoted(cur)) {
      const base = baseOf(cur.name);
      const original = [...byName.values()].find((m) => m !== cur && scopeOf(m.name) !== "thetis" && baseOf(m.name) === base && !isCopy(m) && !isPromoted(m));
      if (original) {
        name = original.name;
        cur = original;
        continue;
      }
    }
    break;
  }
  return name;
}

/**
 * The member a person sees on the card: the one they have installed (a copy before the original, since a
 * copy displaces what it was made from); else the one everyone gets; else the official or registry one; else
 * the original; else a copy in their folder.
 */
export function headlineOf(members, origin = null) {
  const rank = (r) => {
    if (r.installed) return isCopy(r) ? 0 : r.own || r.local ? 1 : r.everyone ? 2 : 3;
    if (r.everyone) return 4;
    if (!r.folder && scopeOf(r.name) === "thetis") return 5;
    if (!r.folder && r.available) return 6;
    if (r.name === origin) return 7;
    return r.folder ? 9 : 8;
  };
  return [...members].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * The rows grouped into families: `[{ key, origin, members, headline }]`, in the order the rows came. `key` is
 * the unscoped name of the origin (what the contract calls the family key); `origin` its full name, which is
 * what the grouping goes by, so two unrelated packages sharing an unscoped name stay apart.
 */
export function familiesOf(rows) {
  const byName = new Map();
  for (const r of rows) if (!byName.has(r.name)) byName.set(r.name, r);
  const groups = new Map();
  for (const r of rows) {
    const origin = originOf(r, byName);
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin).push(r);
  }
  return [...groups.entries()].map(([origin, members]) => ({ key: baseOf(origin), origin, members, headline: headlineOf(members, origin) }));
}

/** The family a row belongs to, among `rows`. */
export function familyOf(row, rows) {
  const all = rows.some((r) => r.name === row.name) ? rows : [...rows, row];
  return familiesOf(all).find((f) => f.members.some((m) => m.name === row.name)) ?? { key: baseOf(row.name), origin: row.name, members: [row], headline: row };
}

/** The official member a copy's label and version are read from: its direct origin when that row is here. */
export function officialOf(row, family) {
  const name = originNameOf(row);
  return name ? (family.members.find((m) => m.name === name) ?? null) : null;
}

/**
 * The other versions of a family, one line each, as the page's side panel lists them:
 * `{ row, name, relation, status, text, install }`: "@bitmuse/notion — your original · published to thetis",
 * "notion-read — your copy in your folder · not installed". `name` is the unscoped folder name for a copy in
 * the person's folder and the full id otherwise.
 */
export function otherVersions(family, shown, { user = "", admin = false } = {}) {
  const promoted = family.members.find(isPromoted) ?? null;
  return family.members
    .filter((m) => m !== shown && m.name !== shown?.name)
    .map((m) => {
      const scope = scopeOf(m.name);
      const inFolder = !!m.folder && !m.installed;
      const name = inFolder && isCopy(m) ? baseOf(m.name) : m.name;
      const relation = isPromoted(m)
        ? "shared with everyone"
        : isCopy(m)
          ? inFolder ? "your copy in your folder" : scope === user || m.local ? "your copy" : `${scope}'s copy`
          : scope === user || m.local
            ? promoted ? "your original" : "yours"
            : scope === "thetis"
              ? "Thetis's version"
              : m.registry && !m.system
                ? `from ${m.registry}`
                : `by ${scope}`;
      const status = m.installed ? "installed" : m.available && m.registry ? `published to ${m.registry}` : "not installed";
      const install = !m.installed && (admin || !isAdminOnly(m)) && !!(m.system || m.folder || m.source);
      return { row: m, name, relation, status, text: `${name} — ${relation} · ${status}`, install };
    });
}

// ---- the place's sections ------------------------------------------------------------------------------

/** Whether a person may be offered this row at all: an admin-only extension is shown to a non-admin only when they have it. */
export const offeredTo = (row, admin) => admin || !isAdminOnly(row) || !!row.installed;

/** Whether a row is one of Thetis's own parts: `row.component`, decided in lib/rows.js. */
const isPart = (r) => !!r.component;

/** Given to the person by default rather than added by them. */
const givenByDefault = (r) => !!r.everyone && !r.own && !r.local && !isCopy(r);

/**
 * The Extensions place, from every row: one entry per family, in the section the headline member decides.
 *
 * - `attention`: installed extensions with Needs setup or Update available -- the person's own, never
 *   something they do not have.
 * - `added`: what the person installed themselves, or made (their own, their copies).
 * - `discover`: what they could add, never a member of a family they already have, never an admin's-only
 *   extension for a non-admin.
 * - `builtin`: what everyone gets, installed for them by default.
 * - `folder`: copies in their home's `packages/` that are not installed.
 * - `thetis`: the parts that make Thetis run, installed or not.
 *
 * `q` and `kind` narrow it to the families any member of which matches (`matches`). Each entry is
 * `{ family, row, state, label, publisher }`. `installed` counts the rows installed for this
 * person, which is the same number the Control panel's list says.
 */
export function placeSections(rows, { user = "", admin = false, superseded = [], q = "", kind = "" } = {}) {
  const out = { attention: [], added: [], discover: [], builtin: [], folder: [], thetis: [], installed: rows.filter((r) => r.installed).length };
  const gone = new Set(superseded);
  for (const family of familiesOf(rows)) {
    const row = family.headline;
    if (!row || !familyMatches(family, q, kind)) continue;
    const origin = officialOf(row, family);
    const label = labelOf(row, origin);
    const entry = { family, row, label, publisher: publisherLine(row, { user, family: family.members }), state: stateOf(row, { admin, origin, label, user, superseded: gone.has(row.name) }) };
    if (family.members.some((m) => m.installed)) {
      if (entry.state.attention) out.attention.push(entry);
      out[isPart(row) ? "thetis" : givenByDefault(row) ? "builtin" : "added"].push(entry);
    } else if (!row.folder && offeredTo(row, admin)) out[isPart(row) ? "thetis" : "discover"].push(entry);
    // Every copy in the folder that is not installed is listed there, the family's card or not: they are the person's files.
    for (const m of family.members) {
      if (!m.folder || m.installed) continue;
      const o = officialOf(m, family);
      const l = labelOf(m, o);
      out.folder.push({ family, row: m, label: l, publisher: publisherLine(m, { user, family: family.members }), state: stateOf(m, { admin, origin: o, label: l, user }) });
    }
  }
  return out;
}

// ---- search --------------------------------------------------------------------------------------------

/** What a row is searched by: name, label, description, tool names, keywords and skill names. */
function haystack(row) {
  const tools = (row.tools ?? []).map((t) => (typeof t === "string" ? t : `${t.name} ${t.description ?? ""}`));
  const skills = (row.skillList ?? []).map((s) => `${s.name} ${s.description ?? ""}`);
  return [row.name, row.label, row.description, ...tools, ...(row.keywords ?? []), ...skills].filter(Boolean).join(" ").toLowerCase();
}

/** A term and the words the synonym list puts with it. */
export function variantsOf(term) {
  const t = term.toLowerCase();
  const group = SYNONYMS.find((g) => g.includes(t));
  return group ? [...group] : [t];
}

/** Whether a row matches every term of `q` (a term matches when it or a synonym of it is found), and the kind filter. */
export function matches(row, q = "", kind = "") {
  if (kind && !kindsOf(row).includes(kind)) return false;
  const terms = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(row);
  return terms.every((t) => variantsOf(t).some((v) => hay.includes(v)));
}

/** Whether any member of a family matches: a search finds the card when it finds any of its versions. */
export const familyMatches = (family, q = "", kind = "") => family.members.some((m) => matches(m, q, kind));
