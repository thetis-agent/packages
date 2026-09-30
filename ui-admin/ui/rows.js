/* The control panel's answers as rows of the Extensions place's shape (`@thetis/ui-marketplace` `lib/rows.js`),
 * so `state.js` reads them with the place's own rules and a table row, a tree entry and a page header say the
 * same thing about the same extension as the place does -- for the admin reading, the way the place says it to
 * them. A row is installed when the reader has it themselves (a copy of theirs standing in for it is the copy's
 * row, not this one); Needs setup is the reader's own layer, which is what reaches the extension for them;
 * Update available is a registry's newer commit or the reader's own workspace running an older version than the
 * disk. Another person's workspace that has not reloaded is theirs, and Who has what says it in their cell as
 * "Waiting for a reload". `fleet` gives one row per extension across every workspace (and the ones on disk
 * nobody has); `package-info` with the reader's `config-show` and `package-where` gives one extension's page.
 * Nothing here asks anything: it only reshapes what was read, and `described` works out what a surface draws
 * from a row. */

import { baseOf, giverOf, labelOf, originNameOf, placeSections, publisherLine, scopeOf, stateOf, summaryOf } from "./state.js";

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
    // Whether the manifest names it: a customized copy with a label of its own keeps it (a variant).
    labelGiven: Boolean(p.label),
    version: p.version ?? null,
    type: p.type ?? null,
    description: p.description ?? "",
    // The manifest's plain sentence, when it gives one: the first line a card and a page say.
    summary: p.summary ?? null,
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
    publishedAs: p.publishedAs ?? null,
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

/** A configuration report as the one state reads it: broken with its missing keys, or whole. */
const reportOf = (broken, summary, keys) => (broken ? { broken: true, summary: summary || "A setting is missing", keys: missingKeys(keys) } : { broken: false, summary: summary ?? "", keys: [] });

/**
 * A `fleet` row, as the reader has it. Installed is the reader's own copy (`mine`); Needs setup is their own
 * layer's report (their cell carries the missing keys); Update available is a registry holding a newer commit,
 * or their own workspace running an older version than the disk. Whether it is one of Thetis's own parts
 * (`component`) is the server's word, the place's rule.
 */
export function rowFromFleet(p, { user = "" } = {}) {
  const install = p.registry?.update?.apply === "install";
  const cell = user ? p.byUser?.[user] : null;
  const has = Boolean(cell && !cell.fork);
  const loaded = has && cell.loaded && cell.loaded !== p.version ? cell.loaded : null;
  return {
    ...common(p, user),
    installed: user ? has : true,
    component: Boolean(p.component),
    nobody: Boolean(p.nobody),
    registry: p.registry?.registry ?? null,
    update: install ? { apply: "install", version: p.registry.update.version, from: p.registry.update.from ?? null, to: p.registry.update.to ?? null } : loaded ? { apply: "reload", available: p.version, installed: loaded } : null,
    config: has ? reportOf(cell.broken, cell.summary, cell.missing) : !user && p.config ? reportOf(p.config.broken, p.config.summary, p.config.missing) : null,
  };
}

/** Every fleet row as the reader has it, for the place's own sections and counts. */
export const rowsFromFleet = (packages, user = "") => packages.map((p) => rowFromFleet(p, { user }));

/**
 * The Extensions place's own numbers and to-dos, from the fleet, for the reader: `counts.installed` (what they
 * have, Thetis's parts apart), `counts.thetis` (the parts), `counts.attention` and the `attention` rows. The
 * same function the place draws from, so the two never disagree.
 */
export const placeOf = (packages, user = "") => placeSections(rowsFromFleet(packages, user), { user, admin: true });

/**
 * One extension's page, for the reader: `info` from `package-info`, `config` the reader's own `config-show`
 * report, `where` from `package-where`. Installed is whether the reader has this one themselves; Update
 * available a registry's newer commit, or the reader's own workspace running an older version than the disk.
 */
export function rowFromInfo(info, { config = null, where = null, user = "" } = {}) {
  if (!info) return null;
  const reg = info.registry;
  const me = (where?.people ?? []).find((p) => p.user === user) ?? null;
  // A copy of theirs standing in for this one is the copy's page, not this one's.
  const has = where ? Boolean(me?.installed && me.forkedFrom?.name !== info.name) : true;
  const install = reg?.update?.apply === "install";
  const reload = has && info.loaded?.behindDisk && info.loaded.user === user;
  return {
    ...common(info, user),
    installed: has,
    component: Boolean(info.component),
    registry: reg?.registry ?? null,
    update: install ? { apply: "install", version: reg.update.version, from: String(reg.update.installed ?? "").slice(0, 7) || null, to: String(reg.update.available ?? "").slice(0, 7) || null } : reload ? { apply: "reload", available: info.version, installed: info.loaded.version } : null,
    config: has && config ? config : null,
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
 * What a surface draws for one row: its label, its publisher line, its one plain line and its state, read by an
 * admin -- the place's words for the same row. `origin` is a copy's official version when the caller knows it
 * and `rows` do not hold it (one extension's page): its label and summary are the copy's, as in the place.
 */
export function described(row, { rows = [], user = "", origin: known = null } = {}) {
  const context = contextOf(row, rows);
  const origin = context.origin ?? known;
  const { family } = context;
  const label = labelOf(row, origin);
  const state = stateOf(row, { admin: true, origin, label, user, giver: giverOf(row, { user, family }) });
  return { label, publisher: publisherLine(row, { user, family }), summary: summaryOf(row, origin), state, origin };
}
