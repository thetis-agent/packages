// One state per extension: the same answer on every screen. This file is the reference. It is pure -- no DOM,
// no imports, no I/O -- so the browser module `ui/state.js` is a byte-identical copy of it (a page may import
// only its own files, and a test holds the two together), and `@thetis/ui-admin` mirrors its rules, pinned by a
// test of its own that gives both the same fixture rows.
//
// What it answers, for a row of `lib/rows.js` (with `config`, the kernel's `config.show` report, folded on when
// the page has one):
//
// - `stateOf(row)`: at most two chips, whether the extension needs the person's attention, the one sentence
//   the page's banner says, and the to-do row the place's "Needs your attention" strip draws for it.
// - `publisherOf(row)` and `typeOf(row)`: the line under every name, "by Thetis · Tools".
// - `labelOf(row)`, `titleOf(row)` and `summaryOf(row)`: the one name, the page's title (which says "your
//   original" on the original of a shared copy), and the one line a person reads first, on a card and a page.
// - `bringsOf(row)`: what it brings, in the kinds the publisher line names ("7 tools · 12 skills").
// - `setupOf(row)` and `needsLine(row)`: what must be set before it works, in the key's own words.
// - `everyoneActions(row)`: what an admin may do about everybody, the same table on both surfaces.
// - `familiesOf(rows)` and `otherVersions(...)`: one card per extension family, and the rest of it.
// - `placeSections(rows)`: which section of the Extensions place each family's card goes in, and the counts
//   the Control panel says too.
// - `isRequired(row)`, `isAdminOnly(row)` and `runsInsideThetis(row)`: what nobody removes, what a person is
//   never offered, and what is nobody's to install.
// - `matches(row, q)` and `matchRank(row, q)`: the search, with a small list of synonyms, and a name match first.
//
// The rules are data (`CHIPS`, `CHIP_ORDER`, `REQUIRED`, `ADMIN_ONLY`, `INSIDE`, `FOR_EVERYONE_BY`, `KINDS`,
// `FILTERS`, `PILLS`, `SYNONYMS`, `WORDS`, `PART_SUMMARIES`), so a second surface can read the same rules
// rather than restate them.

/**
 * The chips, in the order they are shown. `tone` is the shell's badge tone: ok is green, err red, warn amber,
 * dim neutral, accent blue. Enabled and Disabled are only on Thetis's own parts, which a person cannot tell
 * apart otherwise; an extension of their own is in Installed or Discover, and that says it.
 */
export const CHIPS = Object.freeze({
  enabled: Object.freeze({ id: "enabled", label: "Enabled", tone: "ok", tooltip: "It runs, for you or for the whole installation." }),
  disabled: Object.freeze({ id: "disabled", label: "Disabled", tone: "dim", tooltip: "It does not run, for you or for the whole installation." }),
  needsSetup: Object.freeze({ id: "needsSetup", label: "Needs setup", tone: "err", tooltip: "Something must be set before it works. Open it to set it up." }),
  updateAvailable: Object.freeze({ id: "updateAvailable", label: "Update available", tone: "warn", tooltip: "A newer version is ready. Updating keeps your settings." }),
  customized: Object.freeze({ id: "customized", label: "Customized", tone: "dim", tooltip: "You are using your own changed copy instead of the official one." }),
  forEveryone: Object.freeze({ id: "forEveryone", label: "For everyone", tone: "accent", tooltip: "An admin gives this to every person." }),
});
export const CHIP_ORDER = Object.freeze(["enabled", "disabled", "needsSetup", "updateAvailable", "customized", "forEveryone"]);
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

/** What only an admin may have: never in a person's Discover, never an Install for them, never turned on for everyone. */
export const ADMIN_ONLY = Object.freeze({
  audience: "admin",
  types: Object.freeze(["host", "storage"]),
  names: Object.freeze(["@thetis/gateway-login"]),
  line: "Only admins can have this.",
});

/**
 * What runs inside Thetis itself rather than in a person's space: the host packages and the storage driver
 * always, and a gateway, a service or a model provider this person does not have (the sign-in page, the
 * registries service, the command line). Nobody installs, turns on or removes these from a page.
 */
export const INSIDE = Object.freeze({
  types: Object.freeze(["host", "storage"]),
  whenNotInstalled: Object.freeze(["gateway", "service", "provider"]),
  line: "Runs inside Thetis itself",
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
  Object.freeze({ id: "Background", label: "Background" }),
]);

/**
 * The pills over the Installed section: which of what the person has are shown. "Installed by you" is what the
 * person installed themselves; "Given to you" is what an admin gave them -- everyone's defaults, what an admin
 * turned on or shared for everyone, and what an admin installed for them. The "For everyone" chip is another
 * thing: an admin's act, said on the card.
 */
export const PILLS = Object.freeze([
  Object.freeze({ id: "", label: "All", tooltip: "Everything you have" }),
  Object.freeze({ id: "mine", label: "Installed by you", tooltip: "What you installed yourself" }),
  Object.freeze({ id: "given", label: "Given to you", tooltip: "What an admin gave you: everyone's extensions, and what they installed for you" }),
  Object.freeze({ id: "customized", label: "Customized", tooltip: "Your own changed copies" }),
]);

/**
 * Words a person types for the same thing. A term matches when it, or any word in its group, is found. Kept
 * narrow on purpose: "search" is in half the descriptions here, so it is nobody's synonym.
 */
export const SYNONYMS = Object.freeze([Object.freeze(["web", "internet", "google"])]);

/** The fixed sentences, kept together so every surface says the same ones. */
export const WORDS = Object.freeze({
  legend: "Tools let your assistant do things. Skills teach it how. Pages add a screen. Models add a model provider. Background parts work without a screen or tools.",
  waiting: "Waiting for your admin to finish setting this up",
  required: REQUIRED.label,
  adminOnly: ADMIN_ONLY.line,
  inside: INSIDE.line,
  onlyYou: "Only you have this. Use Remove for me.",
  removeForNote: "Their settings are kept. It stops for them from their next message. Everyone else keeps it.",
  cantStopSharing: "Sharing can't be stopped yet; Remove for everyone takes it from the people who have it now.",
  takesAway: (names) => `Takes it away from ${names} now.`,
  staysShared: "It stays shared, so people added later still get it.",
  shareLater: (whose, version) => `You can share your copy once it is based on ${whose} ${version}.`,
  privateCopy: (person, whose) => `This is your own copy. To give ${person} this extension, use ${whose} version:`,
  hiddenByPill: (labels, pill) => `${listOf(labels)} ${labels.length === 1 ? "is" : "are"} hidden by the '${pill}' filter`,
  fromConfig: "Everyone gets it (set in Server settings).",
  updateAllNote: "Your own copies are not touched.",
  turnOffHint: "New people stop getting it; people who have it keep it.",
  sections: Object.freeze({ attention: "Needs your attention", installed: "Installed", discover: "Discover", drafts: "Drafts in your folder", thetis: "Part of Thetis" }),
  settingsPath: (label) => `Control panel → Extensions → ${label} → Settings`,
});

/**
 * One plain line for each of Thetis's own parts, said instead of the manifest's description, which is written
 * for whoever maintains it. A part not listed here is said by the first sentence of its description.
 */
export const PART_SUMMARIES = Object.freeze({
  "@thetis/gateway-web": "The web page you are using now.",
  "@thetis/gateway-cli": "The thetis command and the address browsers reach.",
  "@thetis/gateway-login": "The sign-in page.",
  "@thetis/harness-core": "Runs each conversation: sends it to the model and runs the tools it asks for.",
  "@thetis/prompt-cache": "Makes repeated model calls cheaper by reusing what the model has already read.",
  "@thetis/bench": "Measures how well extensions work. Only used when testing.",
  "@thetis/bench-probe": "Measures how well extensions work. Only used when testing.",
  "@thetis/ui-admin": "The Control panel.",
  "@thetis/ui-marketplace": "This Extensions screen.",
  "@thetis/ui-context": "Shows what the model received on the last call.",
  "@thetis/ui-tools": "The Tools panel beside the chat.",
  "@thetis/ui-skills": "The Skills panel beside the chat.",
  "@thetis/host-grants": "The folders and SSH keys people may use.",
  "@thetis/host-update": "Updates Thetis itself from the Control panel.",
  "@thetis/marketplace": "Keeps the list of extensions from the registries up to date.",
  "@thetis/provider-openrouter": "Models through OpenRouter.",
  "@thetis/provider-echo": "A test model that repeats what you say.",
  "@thetis/skills": "Reads skills, so every skill loader reads them the same way.",
  "@thetis/skills-all": "Another way to give your assistant its skills: all of them, always.",
  "@thetis/skills-l1": "Another way to give your assistant its skills: a list, loaded on request.",
  "@thetis/skills-hybrid": "Gives your assistant the skills a conversation needs.",
  "@thetis/store-toml": "Saves Thetis's data as files on the server.",
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
    .map((w, i) => (/[A-Z]/.test(w) || (i > 0 && SMALL.has(w)) ? w : w.replace(/[a-z]/, (c) => c.toUpperCase())))
    .join(" ");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-27T10:28:31Z" → "27 September 2026", or "" when it is not a date. */
export function dateWords(iso) {
  const d = new Date(String(iso ?? ""));
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
}

/** The first sentence of a text: "Web search. Returns links." → "Web search." */
export function firstSentence(text) {
  const s = String(text ?? "").trim();
  const m = /^(.+?[.!?])(\s|$)/s.exec(s);
  return m ? m[1] : s;
}

/** The origin a copy was made from, by name: the kernel's `fork` when the copy is installed, else the manifest's `forkedFrom`. */
export const originNameOf = (row) => row?.fork?.name ?? row?.forkedFrom?.name ?? null;
/** The version of the origin the copy was made from. */
const baseVersionOf = (row) => row?.fork?.version ?? row?.forkedFrom?.version ?? null;
/** A person's copy of another extension. */
export const isCopy = (row) => !!originNameOf(row);
/** A copy promoted into Thetis for everyone: `@thetis/<n>` made from `@<person>/<n>`. */
export const isPromoted = (row) => row?.everyoneBy === "promoted";
/**
 * What a person's own package went out as when a registry's scope renamed its publish (`@bitmuse/gh` out as
 * `@thetis/gh`): the manifest's `thetis.publishedAs`, which package-publish writes into the person's copy.
 */
export const publishedAsOf = (row) => (typeof row?.publishedAs === "string" && row.publishedAs && row.publishedAs !== row.name ? row.publishedAs : null);

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

/** Runs inside Thetis itself, so no page installs, turns on or removes it. */
export function runsInsideThetis(row) {
  if (!row) return false;
  if (INSIDE.types.includes(row.type)) return true;
  return !row.installed && INSIDE.whenNotInstalled.includes(row.type);
}

/**
 * Whether one of Thetis's parts runs: the host loads its own packages and the storage driver itself, and any
 * other part runs where it is installed -- for this person (`installed`), or for the whole installation
 * (`hostInstalled`, which only an admin's rows carry).
 */
export function isEnabled(row) {
  if (!row) return false;
  return INSIDE.types.includes(row.type) || !!row.installed || !!row.hostInstalled;
}

/** The kinds an extension brings, in `KINDS` order: ["Tools", "Page"]. */
export function kindsOf(row) {
  return KINDS.filter((k) => k.test(row ?? {})).map((k) => k.id);
}

/** The type half of the publisher line: the first two kinds, "Tools · Page", or "". */
export const typeOf = (row) => kindsOf(row).slice(0, 2).join(" · ");

const sameText = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * Which label the person reads, Title Case. A row's label is already the newest one known (`lib/rows.js` takes
 * it from the newest version a registry or the disk holds, so two people see one name). A copy that never
 * gave itself a label of its own -- no `thetis.label`, or the one it copied -- reads as its official member; a
 * variant with its own label ("Notion (read only)") keeps it.
 */
export function labelOf(row, origin = null) {
  const own = row?.label || baseOf(row?.name) || String(row?.name ?? "");
  if (isCopy(row) && origin?.label && !isVariant(row, origin)) return titleCase(origin.label);
  return titleCase(own);
}

/**
 * A copy that is an extension of its own rather than a changed official one: it gave itself a label that is
 * not its origin's ("Notion (read only)"). It keeps its name, and is never "Customized" -- it replaces nothing.
 */
export const isVariant = (row, origin = null) => isCopy(row) && !!origin?.label && row?.labelGiven !== false && !!row?.label && !sameText(row.label, origin.label);

/**
 * The one plain sentence every card and page opens with: the manifest's own `thetis.summary` when it has one --
 * for a copy that is not a variant and has none, its official member's (`origin`) -- else a plain summary for one
 * of Thetis's parts, else the description's first sentence. The description itself is technical and goes under
 * Details.
 */
export function summaryOf(row, origin = null) {
  const said = (r) => (typeof r?.summary === "string" && r.summary.trim() ? r.summary.trim() : null);
  const own = said(row) ?? (isCopy(row) && origin && !isVariant(row, origin) ? said(origin) : null);
  if (own) return own;
  const part = row?.component ? (PART_SUMMARIES[row.name] ?? PART_SUMMARIES[originNameOf(row)]) : null;
  return part ?? firstSentence(row?.description ?? "");
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each kind brings, counted where it can be: "7 tools", "12 skills", "1 page". */
const BRINGS = Object.freeze({
  Tools: (r) => plural(r.tools?.length ?? 0, "tool"),
  Skills: (r) => (r.skills ? plural(r.skills, "skill") : "Skills"),
  Page: (r) => (r.pages ? plural(r.pages, "page") : "A page"),
  Models: () => "Models",
  Background: () => "Runs in the background",
});

/**
 * What an extension brings, from the same kinds as the publisher line's type, so the two always agree:
 * "Tools · Skills" above reads "7 tools · 12 skills" below. Never empty.
 */
export function bringsOf(row) {
  const kinds = kindsOf(row).slice(0, 2);
  if (!kinds.length) return "Runs in the background";
  const out = kinds.map((k) => BRINGS[k](row ?? {}));
  return out.map((w, i) => (i ? w.charAt(0).toLowerCase() + w.slice(1) : w)).join(" · ");
}

/**
 * Who an extension is by, as the line under its name says it, without the type: "by Thetis", "by you",
 * "by bitmuse", "from thirteen-games". `family` is the other rows of its family, which is how a promoted copy
 * knows whose original it was made from; `user` is who is reading. "by you" is authorship and nothing else.
 */
export function publisherOf(row, { user = "", family = [] } = {}) {
  const scope = scopeOf(row?.name);
  if (isPromoted(row)) {
    const who = sharerOf(row, family);
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

/** The publisher line without its "by"/"from", for a confirm's "from" row: "Thetis · Tools". */
export const publisherShort = (row, ctx = {}) => publisherLine(row, ctx).replace(/^(by|from)\s+/, "").replace(/^you\b/, "You");

/**
 * The person a promoted copy was shared from: `row.sharedBy` when the journal said so, else the scope of the
 * original among `family` (the `@<person>/<n>` with the same unscoped name), else "".
 */
export function sharerOf(row, family = []) {
  if (row?.sharedBy?.owner) return row.sharedBy.owner;
  const original = family.find((m) => m !== row && scopeOf(m.name) && scopeOf(m.name) !== "thetis" && baseOf(m.name) === baseOf(row?.name) && !isCopy(m));
  return original ? scopeOf(original.name) : "";
}

/** "Given to you by bitmuse" for what an admin installed for this person, or null. */
export const givenLine = (row, user = "") => (row?.installed && row.givenBy && row.givenBy !== user ? `Given to you by ${row.givenBy}` : null);

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

const ACRONYMS = new Set(["api", "url", "id", "uri", "ssh", "http", "https", "ip"]);

/** A key's name as words: `apiKey` → "API key", `base_url` → "base URL", `timeoutMs` → "timeout (ms)". */
export function humanKey(key) {
  const words = String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1 && words[words.length - 1] === "ms") return `${words.slice(0, -1).map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ")} (ms)`;
  return words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
}

/** "a"/"an" before a word, by its first sound as far as a letter can tell. */
const article = (word) => (/^(?:[aeio]|u(?!s|n[iu])|API\b|SSH\b)/i.test(word) && !/^(?:one|uni|use)/i.test(word) ? "an" : "a");

const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:ai|com|io|net|org|so|dev|app|co)\b(?:\/[^\s)]*)?/i;

/** A link a key's help points at: the first address in it that is not an example. `{ text, href }` or null. */
export function linkOf(help) {
  const s = String(help ?? "").replace(/\b(?:e\.g\.|for example)[\s\S]*?(?=\.\s|;|$)/gi, "");
  const url = URL_RE.exec(s)?.[0]?.replace(/[.,;:]+$/, "");
  if (url) return { text: url, href: url };
  const bare = DOMAIN_RE.exec(s)?.[0]?.replace(/[.,;:]+$/, "");
  return bare ? { text: bare, href: `https://${bare}` } : null;
}

/**
 * A key as a thing a person can be asked for: a short noun from its help ("an Exa API key", "a service account
 * token"), and the link the help gives, if any. No key name in parentheses, no examples, nothing about the
 * server's `.env` -- that is an admin's business -- and when the help gives nothing usable, the key's name as
 * words ("an API key").
 */
export function nounOf(k) {
  const link = linkOf(k?.help);
  let s = firstSentence(k?.help ?? "");
  if (/\.env\b|\benvironment\b/i.test(s)) s = s.split(/;|\s[—–]\s/)[0];
  s = s.replace(/\([^)]*\)/g, " ").replace(/,?\s*(?:e\.g\.|for example).*$/i, "");
  s = s.split(/;|\s[—–]\s|,?\s+from\s+|,\s*(?:sent|used|read|put|which|so|since)\b/i)[0];
  s = s.replace(/\s+/g, " ").replace(/[.,:!?\s]+$/, "").trim();
  if (/\.env\b|\benvironment\b/i.test(s) || !s || s.length > 70) s = "";
  if (s) {
    // "Your Exa API key" → "an Exa API key"; "The Exa API key" → "the Exa API key"; "Base URL of…" → "base URL of…".
    const your = /^your\s+(.*)$/i.exec(s);
    if (your) s = `${article(your[1])} ${your[1]}`;
    else if (/^(?:A|An|The|That|This|Base|One)\s/.test(s) || /^[A-Z][a-z]+\s+[a-z]/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
    if (!/^(?:a|an|the|that|this|your|one|some)\s/i.test(s)) s = `the ${s}`;
  } else {
    const words = humanKey(k?.key) || (k?.secret ? "secret value" : "value");
    s = `${article(words)} ${words}`;
  }
  return { noun: s, link };
}

/** One key as the Needs line names it: "an Exa API key". Never the key's name in parentheses. */
export const needText = (k) => nounOf(k).noun;

/**
 * What an extension needs before it works, from its manifest: the keys a person must give, which is every
 * required key without a default that is not an admin's to set. `row.needs` is `[{ key, secret, help }]`, filled
 * by `lib/rows.js` from the declaration.
 */
export const needsOf = (row) => (Array.isArray(row?.needs) ? row.needs : []);

/** The nouns of some keys and the first link among them: `{ nouns: "an Exa API key", link }`. */
function nounsOf(keys) {
  const found = keys.map(nounOf);
  return { nouns: listOf(found.map((f) => f.noun)), link: found.find((f) => f.link)?.link ?? null };
}

/** " Get one at dashboard.exa.ai." when there is a link, else "". */
const getOne = (link, many = false) => (link ? ` Get ${many ? "them" : "one"} at ${link.text}.` : "");

/** "Needs an Exa API key. Get one at dashboard.exa.ai.", or null. The link is `needsOf`'s own to draw. */
export function needsLine(row) {
  const needs = needsOf(row);
  if (!needs.length) return null;
  const { nouns, link } = nounsOf(needs);
  return `Needs ${nouns}.${getOne(link, needs.length > 1)}`;
}

/** The link the Needs line or the setup banner names, for the page to draw as a link: `{ text, href }` or null. */
export const needsLink = (row, keys = null) => nounsOf(keys ?? needsOf(row)).link;

/** "<Label> needs an Exa API key before it works. Get one at dashboard.exa.ai." */
export function setupSentence(label, keys) {
  const { nouns, link } = nounsOf(keys);
  return `${label} needs ${nouns} before it works.${getOne(link, keys.length > 1)}`;
}

/**
 * The setup problems of an installed extension, from its configuration report: `row.config`, the kernel's
 * `config.show` answer (or `config-list`'s short form, which carries the same `keys` for the missing ones).
 *
 * A problem is the admin's when a person cannot fix it: a `${VAR}` a default or the admin's layer refers to that
 * is not in the server's environment, or a key declared `scope: "system"`. Everything else -- a required key
 * nobody set, or a `${VAR}` the person wrote themselves -- is the person's.
 *
 * Answers `{ mine, admins, chip, waiting, reason, link }`. For an admin both kinds are `Needs setup`, with where
 * the admin's kind is fixed; for anyone else the admin's kind is the grey waiting line and never the chip.
 */
export function setupOf(row, { admin = false, label = null } = {}) {
  const report = row?.config;
  const none = { mine: [], admins: [], chip: false, waiting: false, reason: "", link: null };
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
    const reason = named.length ? setupSentence(name, named) : `${report.summary || "Something is missing"}. Open Settings to fix it.`;
    return { mine, admins, chip: true, waiting: false, reason, link: named.length ? nounsOf(named).link : null };
  }
  if (!admins.length) return none;
  if (!admin) return { mine, admins, chip: false, waiting: true, reason: `${WORDS.waiting}.`, link: null };
  const k = admins[0];
  const where = `Set it for everyone in ${WORDS.settingsPath(name)}.`;
  const reason = Array.isArray(k.missing) && k.missing.length
    ? `${listOf(k.missing)} ${k.missing.length === 1 ? "is" : "are"} not in the server's environment, so ${humanKey(k.key)} has no value. ${where}`
    : `${titleCase(humanKey(k.key))} is not set. ${where}`;
  return { mine, admins, chip: true, waiting: false, reason, link: null };
}

// ---- something newer ---------------------------------------------------------------------------------

/**
 * Whether a newer version of what the person runs is ready: a registry's newer commit, or files on disk newer
 * than what the space loaded. Nothing else is an update -- a copy the official version moved past is
 * `behindOf`, and a pair of versions that are the same is nothing. `wasLabel` on the row is the label the
 * version the person runs gave itself, when the newer one renamed it.
 */
export function updateOf(row) {
  if (!row?.installed) return null;
  const u = row.update;
  if (!u || u.apply === "unfork") return null;
  const reload = u.apply === "reload";
  const to = reload ? u.available : u.version;
  const from = reload ? u.installed : row.version;
  // A reload whose two versions are the same is no update at all; an install is one when the commit moved.
  if (reload ? !to || String(to) === String(from) : String(to) === String(from) && (!u.to || u.to === u.from)) return null;
  const renamed = row.wasLabel && !sameText(row.wasLabel, row.label) ? ` Now called ${titleCase(row.label)}.` : "";
  const reason = String(to) === String(from) ? `A newer build of ${to} is ready.${renamed}` : `Version ${to} is ready; you have ${from}.${renamed}`;
  return { kind: "update", to, from, reason };
}

/**
 * A copy the version it was made from has moved past, or that has nothing the official version lacks
 * (`superseded`, the `updates` answer's word). Not an update: using the official version replaces the
 * person's changes, and that is theirs to review. `origin` is the official member's row, for a copy without
 * the kernel's `fork` facts.
 */
export function behindOf(row, { origin = null, superseded = false, user = "" } = {}) {
  if (!row?.installed || !isCopy(row)) return null;
  const base = baseVersionOf(row);
  const official = row.fork?.shipped ?? origin?.version ?? null;
  const owner = ownerWord(originNameOf(row), user);
  const whose = owner === "your" ? "Your original" : `${owner.charAt(0).toUpperCase()}${owner.slice(1)}`;
  if (superseded) return { kind: "origin", to: official, from: base, reason: `${whose}${official ? ` ${official}` : ""} has every change your copy made.` };
  if (official && base && compareVersions(official, base) > 0) return { kind: "origin", to: official, from: base, reason: `${whose} ${official} is newer than your copy (made from ${base}).` };
  return null;
}

/** A copy that differs from its origin. A copy with no changes at all is not customized, whatever it is called. */
export const isCustomized = (row) => isCopy(row) && !row.fork?.identical;

/** Whether the "For everyone" chip applies: everyone's by an admin's act, not by the installation's own list. */
export const isForEveryone = (row) => !!row?.everyone && FOR_EVERYONE_BY.includes(row.everyoneBy ?? null);

/** Given to the person rather than added by them: everyone gets it, or an admin installed it for them. */
export const isGiven = (row, user = "") => !!row && ((!!row.everyone && !row.own && !row.local && !isCopy(row)) || (!!row.givenBy && row.givenBy !== user));

// ---- the one state -------------------------------------------------------------------------------------

/**
 * The state of one extension for one person, the same on every screen.
 *
 * `ctx`: `admin` (whether the reader is an admin), `origin` (the official member's row, for a copy), `label`
 * (what the reader calls it), `superseded` (the `updates` answer's word that a copy's changes are all in the
 * official version), `user` (who is reading), `giver` (who gave it, for the neutral setup row: "bitmuse",
 * "You", "Your admin").
 *
 * Answers `{ chips, attention, reason, tone, waiting, update, behind, setup, todo }`: `chips` at most two in
 * `CHIP_ORDER`, and on one of Thetis's parts the first is always Enabled or Disabled; `attention` Needs setup or Update available on something installed; `reason` one sentence for
 * the banner, or "", in `tone` (err, warn or dim); `waiting` the grey line a non-admin reads instead of an
 * admin's problem; `todo` the "Needs your attention" row -- `{ kind, tone, action, reason }` with kind
 * `update` [Update], `setup` [Set up], `optional` (something given to them that needs their own setting, in
 * a neutral tone) [Set up] or `review` (a copy behind its official version) [Review] -- or null.
 */
export function stateOf(row, ctx = {}) {
  const label = ctx.label ?? labelOf(row, ctx.origin);
  const user = ctx.user ?? "";
  const setup = setupOf(row, { admin: !!ctx.admin, label });
  const update = updateOf(row);
  const behind = behindOf(row, ctx);
  const on = {
    enabled: !!row?.component && isEnabled(row),
    disabled: !!row?.component && !isEnabled(row),
    needsSetup: setup.chip,
    updateAvailable: !!update,
    customized: !!row?.installed && isCustomized(row) && !isVariant(row, ctx.origin),
    // On something the person does not have, "an admin gives this to every person" only confuses; an admin still reads it.
    forEveryone: isForEveryone(row) && (!!row?.installed || !!ctx.admin),
  };
  const chips = CHIP_ORDER.filter((id) => on[id]).slice(0, MAX_CHIPS).map((id) => CHIPS[id]);
  const optional = setup.chip && setup.mine.length > 0 && isGiven(row, user);
  const optionalReason = optional ? `${ctx.giver || "Your admin"} gave ${row.givenBy && row.givenBy !== user && !row.everyone ? "you" : "everyone"} ${label}. Set it up if you use it, or remove it for yourself.` : "";
  let todo = null;
  if (row?.installed) {
    if (update) todo = { kind: "update", tone: "warn", action: "Update", reason: setup.chip ? `${update.reason.replace(/\.$/, "")}, and it still needs setting up.` : update.reason };
    else if (optional) todo = { kind: "optional", tone: "dim", action: "Set up", reason: optionalReason };
    else if (setup.chip) todo = { kind: "setup", tone: "err", action: "Set up", reason: setup.reason, link: setup.link };
    else if (behind) todo = { kind: "review", tone: "dim", action: "Review", reason: behind.reason };
  }
  const reason = optional ? optionalReason : setup.chip ? setup.reason : update ? update.reason : behind ? behind.reason : setup.waiting ? setup.reason : "";
  const tone = optional ? "dim" : setup.chip ? "err" : update ? "warn" : "dim";
  return { chips, attention: !!row?.installed && (setup.chip || !!update), reason, tone, waiting: setup.waiting, update, behind, setup, todo };
}

// ---- for everyone: the admin's table, the same on both surfaces -----------------------------------------

/**
 * What an admin may do about everybody for one extension, and the lines said beside it. The decision table:
 *
 * | the extension                      | lines, and actions                                                       |
 * |------------------------------------|--------------------------------------------------------------------------|
 * | runs inside Thetis                 | "Runs inside Thetis itself"; nothing                                     |
 * | Required by Thetis                 | the configuration's line, when it is that; nothing                       |
 * | a promoted (shared) copy           | "Shared with everyone from <original> by <person> on <date>. Your people get this one."; removeEveryone |
 * | the original of a promoted copy    | "Already shared with everyone as <label>." and `open` the shared copy; nothing else |
 * | admin-only                         | "Only admins can have this."; removeEveryone                             |
 * | a copy (a variant)                 | share (the admin's own, installed, not behind Thetis's), or a line why not |
 * | the admin's own                    | share                                                                   |
 * | marked for everyone                | turnOff, removeEveryone                                                  |
 * | everyone's by the configuration    | "Everyone gets it (set in Server settings)."; removeEveryone             |
 * | by Thetis or a registry            | turnOn, removeEveryone                                                   |
 *
 * `removeEveryone` only when somebody other than the reader has it (`holders`, the people who have it, when
 * known); when only the reader does, the line "Only you have this. Use Remove for me." `hints` holds the
 * sentence under Turn off and Remove for everyone. Answers `{ lines, acts, hints, open, shared }`.
 */
export function everyoneActions(row, { family = [], user = "", holders = null, origin = null, label = null } = {}) {
  const out = { lines: [], acts: [], hints: {}, open: null, shared: null };
  if (!row) return out;
  const name = label ?? labelOf(row, origin);
  const others = Array.isArray(holders) ? holders.filter((h) => h !== user) : null;
  const removable = () => {
    if (isRequired(row) || runsInsideThetis(row)) return;
    if (others && !others.length) {
      if (holders.includes(user)) out.lines.push(WORDS.onlyYou);
      return;
    }
    if (!row.installed && !row.system && !others) return;
    out.acts.push("removeEveryone");
    if (others?.length) out.hints.removeEveryone = WORDS.takesAway(listOf(holders.map((h) => (h === user ? "you" : h))));
  };
  if (runsInsideThetis(row)) {
    out.lines.push(`${WORDS.inside}.`);
    return out;
  }
  if (isRequired(row)) {
    if (row.everyone && row.everyoneBy === "config") out.lines.push(WORDS.fromConfig);
    return out;
  }
  if (isPromoted(row)) {
    const original = family.find((m) => m !== row && !isPromoted(m) && !isCopy(m) && scopeOf(m.name) !== "thetis" && baseOf(m.name) === baseOf(row.name)) ?? null;
    const who = sharerOf(row, family);
    const from = original ? labelOf(original) : row.sharedBy?.from ? titleCase(baseOf(row.sharedBy.from)) : "a person's copy";
    const date = dateWords(row.sharedBy?.at) ? ` on ${dateWords(row.sharedBy.at)}` : "";
    out.lines.push(`Shared with everyone from ${from}${who ? ` by ${who === user ? "you" : who}` : ""}${date}. Your people get this one.`);
    removable();
    // Unsharing needs the kernel to take the mark off a promoted copy, which it cannot yet: said beside the one act there is.
    if (out.acts.includes("removeEveryone")) out.hints.removeEveryone = [out.hints.removeEveryone, WORDS.staysShared].filter(Boolean).join(" ");
    return out;
  }
  const promoted = sharedCopyOf(row, family);
  if (promoted) {
    out.lines.push(`Already shared with everyone as ${labelOf(promoted)}.`);
    out.open = promoted.name;
    out.shared = promoted;
    return out;
  }
  if (isAdminOnly(row)) {
    out.lines.push(WORDS.adminOnly);
    removable();
    return out;
  }
  const mine = row.own || row.local || (user && scopeOf(row.name) === user);
  if (isCopy(row)) {
    if (mine && row.installed) {
      const behind = behindOf(row, { origin, user });
      const fromThetis = scopeOf(originNameOf(row)) === "thetis";
      if (fromThetis && behind) out.lines.push(WORDS.shareLater("Thetis's", behind.to));
      else if (fromThetis) out.lines.push(`Thetis already has ${name}, so this copy is not shared under that name.`);
      else out.acts.push("share");
    }
    removable();
    return out;
  }
  if (mine && !row.system) {
    if (row.installed) out.acts.push("share");
    removable();
    return out;
  }
  if (row.everyone && row.everyoneBy === "marked") {
    out.acts.push("turnOff");
    out.hints.turnOff = WORDS.turnOffHint;
  } else if (row.everyone && row.everyoneBy === "config") out.lines.push(WORDS.fromConfig);
  else if (!row.everyone && (row.system || row.source)) out.acts.push("turnOn");
  removable();
  return out;
}

// ---- families ------------------------------------------------------------------------------------------

/**
 * The name of the original a row's family grows from. A copy follows `forkedFrom` (through a copy of a copy);
 * a promoted `@thetis/<n>` joins the `@<person>/<n>` it was made from when that row is here; a person's own
 * package joins what it was published as (`publishedAs`), when that row is here. A row nothing joins is its own
 * origin.
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
    // A promoted copy already joins the original it was made from, so it is never joined back to.
    const published = publishedAsOf(cur) ? (byName.get(publishedAsOf(cur)) ?? null) : null;
    if (published && !isPromoted(published)) {
      name = published.name;
      cur = published;
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
 * The shared copy made from `row`, when `row` is the original a promoted `@thetis/<n>` was made from (the same
 * unscoped name, not itself a copy), or null.
 */
export function sharedCopyOf(row, family = []) {
  if (!row || isPromoted(row) || isCopy(row) || scopeOf(row.name) === "thetis") return null;
  return family.find((m) => m !== row && m.name !== row.name && isPromoted(m) && baseOf(m.name) === baseOf(row.name)) ?? null;
}

/** Whose an original is, as its title and its relation say it: "your original", "bitmuse's original". */
const originalWord = (row, user) => (scopeOf(row.name) === user || (!scopeOf(row.name) && row.local) ? "your original" : `${scopeOf(row.name)}'s original`);

/**
 * The title of an extension's page: its label, and for the original of a shared copy "Notion — your original"
 * (or "Notion — bitmuse's original"), so the original and the shared copy never share one title.
 */
export function titleOf(row, { family = [], user = "", origin = null } = {}) {
  const label = labelOf(row, origin);
  return sharedCopyOf(row, family) || publishedCopyOf(row, family) ? `${label} — ${originalWord(row, user)}` : label;
}

/** The package `row` was published as, when it is among `family` (see `publishedAsOf`), or null. */
export function publishedCopyOf(row, family = []) {
  const name = publishedAsOf(row);
  return name && !isCopy(row) ? (family.find((m) => m !== row && m.name === name) ?? null) : null;
}

/** Whether two members bring the same tools, by name: what lets a person's original say "(same tools)". */
const sameTools = (a, b) => {
  const names = (r) => (r?.tools ?? []).map((t) => (typeof t === "string" ? t : t.name)).sort().join(" ");
  return !!names(a) && names(a) === names(b);
};

/**
 * How one member stands to the reader, in a few words: "your original, in your folder", "a variant in your
 * folder", "your copy", "shared with everyone", "Thetis's version". `promoted` is the family's shared copy, and
 * `origin` the member's own official one (which tells a variant from a changed copy).
 */
export function relationOf(m, { user = "", promoted = null, origin = null } = {}) {
  const scope = scopeOf(m.name);
  const inFolder = !!m.folder && !m.installed;
  const mine = scope === user || !!m.local;
  if (isPromoted(m)) return "shared with everyone";
  if (isCopy(m)) {
    if (inFolder) return isVariant(m, origin) ? "a variant in your folder" : "your copy in your folder";
    return mine ? (isVariant(m, origin) ? "your variant" : "your copy") : `${scope}'s copy`;
  }
  if ((promoted || publishedAsOf(m)) && !isCopy(m) && scope !== "thetis") return mine ? (m.folder ? "your original, in your folder" : "your original") : `${scope}'s original`;
  if (mine) return "yours";
  if (scope === "thetis") return "Thetis's version";
  if (m.registry && !m.system) return `from ${m.registry}`;
  return `by ${scope}`;
}

/**
 * The versions of a family, one line each, as the page's side panel lists them. The one the person uses comes
 * first, even on its own page, and reads `✓ <label> — you use this (<relation>)`; the others `○ <label> —
 * <relation>`, with the action beside it: `use` (Use instead, when the person uses another member) or `install`
 * (when they use none), or null when it is not theirs to take. A person who is not an admin is never offered
 * somebody's original of a shared copy: that row reads "<label> — bitmuse's original (same tools)" with no
 * button. Each is `{ row, label, name, relation, note, used, text, action, install }`; `note` is what follows
 * the dash, and `install` is kept for an older caller and is whether any action is offered.
 */
export function otherVersions(family, shown, { user = "", admin = false } = {}) {
  const promoted = family.members.find(isPromoted) ?? null;
  const inUse = family.members.find((m) => m.installed) ?? null;
  // The official version of the copy in use goes back through "Use Thetis's version", never a second install.
  const behindUse = inUse && isCopy(inUse) ? originNameOf(inUse) : null;
  const listed = family.members.filter((m) => m === inUse || (m !== shown && m.name !== shown?.name));
  listed.sort((a, b) => Number(b === inUse) - Number(a === inUse));
  return listed.map((m) => {
    const origin = officialOf(m, family);
    const label = labelOf(m, origin);
    const name = !!m.folder && !m.installed && isCopy(m) ? baseOf(m.name) : m.name;
    let relation = relationOf(m, { user, promoted, origin });
    const used = !!m.installed;
    const theirsOriginal = !admin && !!promoted && m !== promoted && !isCopy(m) && scopeOf(m.name) !== user && scopeOf(m.name) !== "thetis" && baseOf(m.name) === baseOf(promoted.name);
    if (theirsOriginal && sameTools(m, promoted)) relation += " (same tools)";
    const offered = !used && !theirsOriginal && m.name !== behindUse && (admin || !isAdminOnly(m)) && !runsInsideThetis(m) && !!(m.system || m.folder || m.source);
    const action = offered ? (inUse ? "use" : "install") : null;
    const note = used ? `you use this (${relation})` : relation;
    const text = `${used ? "✓" : "○"} ${label} — ${note}`;
    return { row: m, label, name, relation, note, used, text, action, install: !!action };
  });
}

/**
 * The title of the confirm that puts `label` in place of the one in use: "Switch to your original Notion?",
 * "Switch to Notion (Read Only)?". `relation` is how it stands to the person (relationOf).
 */
export function switchTitle(label, relation = "") {
  const r = String(relation).split(" · ")[0].replace(/,.*$/, "");
  if (r === "your original") return `Switch to your original ${label}?`;
  if (r === "Thetis's version") return `Switch to Thetis's ${label}?`;
  return `Switch to ${label}?`;
}

// ---- the place's sections ------------------------------------------------------------------------------

/** Whether a person may be offered this row at all: an admin-only extension is shown to a non-admin only when they have it. */
export const offeredTo = (row, admin) => admin || !isAdminOnly(row) || !!row.installed;

/** Whether a row is one of Thetis's own parts: `row.component`, decided in lib/rows.js. */
const isPart = (r) => !!r.component;

/**
 * Who gave a person something that is theirs by default, for the neutral setup row: "You" for the admin's own
 * shared copy, the sharer or the admin who installed it, else "Your admin" (an admin's mark) or "Thetis" (the
 * configuration's list).
 */
export function giverOf(row, { user = "", family = [] } = {}) {
  if (row?.givenBy && row.givenBy !== user && !row.everyone) return row.givenBy;
  if (isPromoted(row)) {
    const who = sharerOf(row, family);
    return who ? (who === user ? "You" : who) : "Your admin";
  }
  if (row?.everyone && row.everyoneBy === "config") return "Thetis";
  if (row?.markedBy) return row.markedBy === user ? "You" : row.markedBy;
  return "Your admin";
}

/** Which of the Installed pills an installed entry is under: "mine", "given", "customized". */
function pillsOf(row, user, origin = null) {
  const out = [];
  if (isGiven(row, user)) out.push("given");
  else out.push("mine");
  if (isCustomized(row) && !isVariant(row, origin)) out.push("customized");
  return out;
}

/**
 * The Extensions place, from every row: one entry per family, in the section the headline member decides.
 *
 * - `attention`: one to-do row per installed family whose state has one (`stateOf(...).todo`): Set up, Update
 *   or Review. `updates` is the names of the Update rows, which is exactly what "Update N" updates.
 * - `installed`: what the person has that is not one of Thetis's parts, each entry carrying the pills it is
 *   under (`All`, `Installed by you`, `Given to you`, `Customized`); `pill` narrows it to one of them.
 * - `discover`: what they could add, never a member of a family they already have, never an admin's-only
 *   extension for a non-admin, never one of Thetis's parts.
 * - `drafts`: families that exist only as folders in their home (`packages/`), nothing installed and nothing
 *   offered; a folder copy of a family that has a card is in that card's Other versions instead.
 * - `thetis`: the parts that make Thetis run -- for an admin all of them, for anyone else only those they have.
 *
 * `q` and `kind` narrow every section to the families any member of which matches (`matches`), a match on the
 * name or label first (`matchRank`). Each entry is `{ family, row, label, publisher, summary, brings, given,
 * state, pills }`. `counts` is the same numbers unnarrowed: `installed` (the Installed section's cards -- the
 * number the Control panel says too), each pill's, `thetis` and `updates`. `found` is the pills' numbers as the
 * search and the type leave them, which is what the pills say; `hidden` is the labels the pill hides from them.
 * The to-do rows come in a fixed order: updates, then setting up, then reviews, each by label.
 */
export function placeSections(rows, { user = "", admin = false, superseded = [], q = "", kind = "", pill = "" } = {}) {
  const out = { attention: [], installed: [], discover: [], drafts: [], thetis: [], updates: [], hidden: [], counts: { installed: 0, mine: 0, given: 0, customized: 0, thetis: 0, updates: 0, attention: 0 }, found: { installed: 0, mine: 0, given: 0, customized: 0 } };
  const gone = new Set(superseded);
  for (const family of familiesOf(rows)) {
    const row = family.headline;
    if (!row) continue;
    const origin = officialOf(row, family);
    const label = labelOf(row, origin);
    const giver = giverOf(row, { user, family: family.members });
    const state = stateOf(row, { admin, origin, label, user, giver, superseded: gone.has(row.name) });
    const has = family.members.some((m) => m.installed);
    const entry = { family, row, label, publisher: publisherLine(row, { user, family: family.members }), summary: summaryOf(row, origin), brings: bringsOf(row), given: givenLine(row, user), state, pills: has && !isPart(row) ? pillsOf(row, user, origin) : [], rank: q ? Math.min(...family.members.map((m) => matchRank(m, q))) : 0 };
    // The counts are the place's whole, before any search: what the Control panel says as well.
    if (has && !isPart(row)) {
      out.counts.installed += 1;
      for (const p of entry.pills) out.counts[p] += 1;
    }
    if (has && isPart(row)) out.counts.thetis += 1;
    else if (!has && isPart(row) && admin) out.counts.thetis += 1;
    if (has && state.todo) {
      out.counts.attention += 1;
      if (state.todo.kind === "update") out.counts.updates += 1;
    }
    const hit = familyMatches(family, q, kind);
    if (has && state.todo && hit) {
      out.attention.push({ ...entry, todo: state.todo });
      if (state.todo.kind === "update") out.updates.push(row.name);
    }
    if (!hit) continue;
    if (has) {
      if (isPart(row)) out.thetis.push(entry);
      else {
        out.found.installed += 1;
        for (const p of entry.pills) out.found[p] += 1;
        if (!pill || entry.pills.includes(pill)) out.installed.push(entry);
        else if (q) out.hidden.push(label);
      }
    } else if (isPart(row)) {
      if (admin) out.thetis.push(entry);
    } else if (family.members.every((m) => m.folder && !m.available && !m.system)) out.drafts.push(entry);
    else if (!row.folder || row.available || row.system) {
      if (offeredTo(row, admin)) out.discover.push(entry);
    }
  }
  const TODO_ORDER = ["update", "setup", "optional", "review"];
  out.attention.sort((a, b) => TODO_ORDER.indexOf(a.todo.kind) - TODO_ORDER.indexOf(b.todo.kind) || a.label.localeCompare(b.label));
  // A name match first; otherwise the order the rows came in.
  if (q) for (const k of ["installed", "discover", "drafts", "thetis"]) out[k] = out[k].map((e, i) => [e, i]).sort((a, b) => a[0].rank - b[0].rank || a[1] - b[1]).map(([e]) => e);
  return out;
}

// ---- search --------------------------------------------------------------------------------------------

/** What a synonym is looked for in: the names alone -- name, label, keywords and tool names -- never a description. */
function nameHay(row) {
  const tools = (row.tools ?? []).map((t) => (typeof t === "string" ? t : t.name));
  return [row.name, row.label, ...tools, ...(row.keywords ?? [])].filter(Boolean).join(" ").toLowerCase().replace(/[_/@-]+/g, " ");
}

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

/** Whether `word` is in `hay` as a word of its own (a synonym never matches inside another word: "web" is not "webhook"). */
const hasWord = (hay, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay);

/**
 * Whether a row matches every term of `q`, and the kind filter. A term matches when it is found anywhere; a
 * synonym of it only when it is a word of the extension's names, so "google" finds "Exa web search" and not
 * every description that mentions the web page.
 */
export function matches(row, q = "", kind = "") {
  if (kind && !kindsOf(row).includes(kind)) return false;
  const terms = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(row);
  const names = nameHay(row);
  return terms.every((t) => hay.includes(t) || variantsOf(t).some((v) => v !== t && hasWord(names, v)));
}

/**
 * How well a row matches `q`, for the order of what a search finds: 0 when its label or name starts with the
 * query, 1 when every term is in its label or name, 2 for any other match (a description, a tool).
 */
export function matchRank(row, q = "") {
  const query = String(q ?? "").trim().toLowerCase();
  if (!query) return 0;
  const label = String(row?.label ?? "").toLowerCase();
  const base = baseOf(row?.name).toLowerCase();
  if (label.startsWith(query) || base.startsWith(query)) return 0;
  const names = `${label} ${base}`;
  return query.split(/\s+/).every((t) => names.includes(t)) ? 1 : 2;
}

/** Whether any member of a family matches: a search finds the card when it finds any of its versions. */
export const familyMatches = (family, q = "", kind = "") => family.members.some((m) => matches(m, q, kind));
