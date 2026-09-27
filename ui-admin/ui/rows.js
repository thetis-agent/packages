/* The control panel's answers as rows of the Extensions place's shape (`@thetis/ui-marketplace` `lib/rows.js`),
 * so `state.js` reads them with the place's own rules and a table row, a tree entry and a page header say the
 * same thing about the same extension as the place does. `fleet` gives one row per extension across every
 * workspace; `package-info` with `config-show` and `package-where` gives one extension's page. Nothing here asks
 * anything: it only reshapes what was read, and `described` works out what a surface draws from a row. */

import { baseOf, giverOf, labelOf, listOf, originNameOf, publisherLine, scopeOf, stateOf } from "./state.js";
import { waitingSentence } from "./words.js";

/** The name a person reads when the manifest gives no label: the bare name, a `ui-` prefix dropped, dashes as spaces. */
const bare = (name) => baseOf(name).replace(/^ui-/, "").replace(/[-_.]+/g, " ").trim() || String(name ?? "");

/** The keys a report says are missing, as the place's `setupOf` reads them. */
const missingKeys = (keys) => (Array.isArray(keys) ? keys.filter((k) => k && k.state === "missing") : []);

/** The facts every row carries the same way, from a fleet row or a package-info answer. `user` is the admin reading. */
function common(p, user) {
  const own = Boolean(user) && scopeOf(p.name) === user;
  return {
    name: p.name,
    label: p.label || bare(p.name),
    // Whether the manifest names it: a customised copy with a label of its own keeps it (a variant).
    labelGiven: Boolean(p.label),
    version: p.version ?? null,
    type: p.type ?? null,
    description: p.description ?? "",
    audience: p.audience ?? null,
    installed: true,
    system: p.source?.kind === "system",
    everyone: Boolean(p.everyone),
    everyoneBy: p.everyoneBy ?? null,
    own,
    // "Local" is the place's word for a copy under the reader's own home; another person's copy is theirs.
    local: own && p.source?.kind === "local",
    source: p.source ?? null,
    forkedFrom: p.forkedFrom ?? null,
    fork: p.fork ?? null,
    tools: Array.isArray(p.tools) ? p.tools : [],
    skills: 0,
    hasSkills: Boolean(p.hasSkills),
    pages: p.pages ?? 0,
    service: Boolean(p.service),
    steps: p.steps ?? 0,
    promotedFrom: p.promotedFrom ?? null,
    // A shared copy's origin as the place's rows carry it: the original, whose it was, when.
    sharedBy: p.promotedFrom?.name ? { from: p.promotedFrom.name, owner: p.promotedFrom.by ?? null, at: p.promotedFrom.at ?? null } : null,
  };
}

/**
 * A `fleet` row. Update available is a registry holding a newer commit, or people whose workspace has not
 * applied the copy on disk (`update.waiting` counts them). Needs setup is the system layer's report, whose
 * missing keys the server passes on, or a person's own layer (their cell says `broken`).
 */
export function rowFromFleet(p, { user = "" } = {}) {
  const install = p.registry?.update?.apply === "install";
  const waiting = Array.isArray(p.waiting) ? p.waiting : [];
  // The people whose own layer is missing something: a fork standing in for the original is that fork's
  // business, and the system workspace is the system layer's.
  const people = Object.entries(p.byUser ?? {}).filter(([who, c]) => c?.broken && !c.fork && who !== "_system").map(([who]) => who);
  const loaded = waiting.map((w) => p.byUser?.[w]?.loaded).find(Boolean) ?? null;
  const config = p.config?.broken
    ? { broken: true, summary: p.config.summary || "A setting is missing", keys: missingKeys(p.config.missing) }
    : people.length
      ? { broken: true, summary: `A setting is missing for ${listOf(people)}`, keys: [] }
      : p.config
        ? { broken: false, summary: p.config.summary ?? "", keys: [] }
        : null;
  return {
    ...common(p, user),
    registry: p.registry?.registry ?? null,
    // A copy whose official version moved on is not an update of what anyone runs (it is Customized, and its page
    // says what using Thetis's version would do), so the kind `unfork` is never one here; nor is a reload whose
    // loaded version is not known to differ, which would read "Version X is ready; you have X".
    update: install ? { apply: "install", version: p.registry.update.version } : waiting.length && (!loaded || loaded !== p.version) ? { apply: "reload", available: p.version, installed: loaded && loaded !== p.version ? loaded : null, waiting: waiting.length } : null,
    config,
  };
}

/**
 * One extension's page: `info` from `package-info`, `config` the system layer's `config-show` report, `where`
 * from `package-where`. Update available is the registry's newer commit, this workspace not having applied the
 * copy on disk, or people who have not.
 */
export function rowFromInfo(info, { config = null, where = null, user = "" } = {}) {
  if (!info) return null;
  const reg = info.registry;
  const waiting = where?.counts?.waiting ?? 0;
  const install = reg?.update?.apply === "install";
  const people = (where?.people ?? []).filter((p) => p.installed && p.config?.broken).map((p) => p.user);
  const report = config?.broken ? config : people.length ? { broken: true, summary: `A setting is missing for ${listOf(people)}`, keys: [] } : config;
  return {
    ...common(info, user),
    registry: reg?.registry ?? null,
    // `unfork` (a copy's official version moved on) is never an update; see `rowFromFleet`.
    update: install
      ? { apply: "install", version: reg.update.version }
      : info.loaded?.behindDisk || waiting || reg?.update?.apply === "reload"
        ? { apply: "reload", available: info.version, installed: info.loaded?.behindDisk ? info.loaded.version : null, waiting }
        : null,
    config: report ?? null,
  };
}

/**
 * The context the place's rules want for a row, from the other rows here: the official member a copy takes its
 * label and version from, and the family a promoted copy finds its person in. A promoted copy's origin is also
 * known from the journal (`promotedFrom`), which the place has no way to read; it joins the family as the
 * original it was made from, so the rule that names the person is the place's own.
 */
export function contextOf(row, rows = []) {
  const originName = originNameOf(row);
  const origin = originName ? rows.find((r) => r.name === originName) ?? null : null;
  const family = row.promotedFrom?.name ? [{ name: row.promotedFrom.name }, ...rows] : rows;
  return { origin, family };
}

/**
 * What a surface draws for one row: its label, its publisher line and its state, read by an admin. The one
 * sentence is the place's, except where the control panel knows more: an update that only waits on people
 * applying it says who is waiting rather than "you have".
 */
export function described(row, { rows = [], user = "" } = {}) {
  const { origin, family } = contextOf(row, rows);
  const label = labelOf(row, origin);
  const state = stateOf(row, { admin: true, origin, label, user, giver: giverOf(row, { user, family }) });
  // Applying, when the version the reader's own workspace runs is not known to differ: who is waiting, never
  // "Version X is ready; you have X".
  const reload = row.update?.apply === "reload" && !state.setup.chip && state.update?.kind === "update";
  const waitingFor = reload && row.update.waiting ? `${waitingSentence(row.update.waiting)}.` : reload && !row.update.installed ? `Version ${row.update.available} is on disk and goes live when updates are applied.` : null;
  return { label, publisher: publisherLine(row, { user, family }), state: waitingFor ? { ...state, reason: waitingFor } : state, origin };
}
