// One row per package name, from three lists: what is installed here (`env.kernel.packages.list()`), the
// system packages on disk whether or not this person has them (`env.kernel.packages.catalog()`), and what
// the index in the shared directory offers. An installed package comes first and keeps its own facts; a
// system package the person does not have comes next, installable by name; the index adds where a package
// came from and whether the registry has moved on. Nothing here changes anything: a row is what a person
// reads before deciding.
//
// A row says three separate things, and the old `scope` said them as one word, which is how "Only me" came
// to sit on a package shipped with the installation and "Available" on one a person could not install.
// `system` is whose the package is: the installation's, shipped in the checkout or promoted into it, linked
// already built, and open to anyone by name. `installed` is whether it is in this person's workspace.
// `everyone` is whether every person gets it by default, with `everyoneBy` saying who decided that -- the
// configuration, a promotion, or an admin's mark -- because only the mark can be taken back from a page.
// `own` is the person's namespace, a label; `local` is a copy under their home, which is what Delete and
// the kernel go by. The registry keeps one entry per workspace, so a name says nothing about whose it is.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ahead, behind, compareVersions, shortCommit } from "@thetis/marketplace";
import { labelOf } from "./updates.js";

const PIN = /@([0-9a-f]{40})$/;

/** The short commit an installed git source is pinned to, or null for a local or shipped copy. */
export function pinOf(info) {
  const ref = info.source?.kind === "git" ? info.source.ref : "";
  const m = PIN.exec(ref);
  return m ? shortCommit(m[1]) : null;
}

/**
 * Folds "there is a newer one" onto a row in the short form a person reads. `apply` says what catches it
 * up: an `install` of the newer commit the registry holds, or a `reload` of the workspace, which is what a
 * package shipped with the service needs, its files being installed the moment they land. A reload row
 * carries versions rather than commits, because that is what differs.
 */
export function withUpdate(row, found) {
  if (!found) return row;
  if (found.apply === "reload") return { ...row, update: { apply: "reload", version: found.version, installed: found.installed, available: found.available } };
  // An un-fork installs nothing and fetches nothing: the package to go back to is already on disk here, and
  // what changes is which of the two this userspace is pointed at. It rides on `update` all the same,
  // because a person reads it in the same place and for the same reason: something newer than what I have.
  if (found.apply === "unfork") return { ...row, update: { apply: "unfork", version: found.version, installed: found.installed, available: found.available, origin: found.origin, identical: !!found.identical } };
  return { ...row, update: { apply: "install", version: found.version, from: shortCommit(found.installed), to: shortCommit(found.available), source: found.source, registry: found.registry } };
}

/**
 * Folds "nobody else can have this yet" onto a row. The sibling of `withUpdate`, and the other direction:
 * `update` is something newer than what is in service here, `ahead` is something newer here than what the
 * registries hold. `state` is `ahead` when a registry has an older version of this package, `unpublished`
 * when no registry lists it at all.
 */
export function withAhead(row, found) {
  return found ? { ...row, ahead: { state: found.state, version: found.version, published: found.published, registry: found.registry } } : row;
}

/**
 * What a package's own bench directory says about it. Read from disk rather than recomputed: the report
 * is the artifact, and the page shows what was actually written next to the code.
 */
export function benchReports(root, reportDir = "bench") {
  const at = resolve(root, reportDir);
  if (!existsSync(at)) return [];
  const out = [];
  for (const entry of readdirSync(at)) {
    const file = resolve(at, entry, "report.json");
    if (!existsSync(file)) continue;
    try {
      const view = JSON.parse(readFileSync(file, "utf8"));
      if (!view.suite || !view.suiteDigest) continue;
      const conformance = Object.values(view.report?.conformance ?? {});
      out.push({ suite: view.suite, digest: view.suiteDigest, generatedAt: view.generatedAt ?? "", arms: view.arms?.length ?? 0, passed: conformance.every((c) => c.passed !== false) });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.suite.localeCompare(b.suite));
}

/** The `license` field of the installed copy's package.json, or null. */
function licenseOf(root) {
  try {
    const license = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).license;
    return typeof license === "string" ? license : null;
  } catch {
    return null;
  }
}

function benchOf(info) {
  const bench = info.thetis?.bench;
  if (!bench) return null;
  return { suites: bench.suites ?? [], ...(bench.peerGroup ? { peerGroup: bench.peerGroup } : {}), reports: benchReports(info.root, bench.report) };
}

/**
 * A package the kernel knows -- installed here, or a system package on disk -- as a row. `tools` keeps the
 * descriptions; the page shows them as pills with a title. `own` is filled by `mergeRows`, which knows who is asking.
 */
export function installedRow(info, installed = true) {
  return {
    name: info.name,
    label: labelOf(info),
    // Whether the manifest named it, or the label was made from the package name: a copy that named itself is
    // an extension of its own ("Notion (read only)"), and one that did not reads as its origin.
    labelGiven: typeof info.thetis?.label === "string" && !!info.thetis.label.trim(),
    version: info.version,
    type: info.type,
    description: info.description ?? "",
    audience: typeof info.thetis?.audience === "string" ? info.thetis.audience : null,
    // What a person must give before it works, from the declaration: the Needs line on the page.
    needs: needsOfDecls(info.thetis?.config),
    keywords: [],
    registry: null,
    source: null,
    installed,
    system: info.source?.kind === "system",
    everyone: !!info.everyone,
    everyoneBy: info.everyoneBy ?? null,
    own: false,
    // A copy that lives under this person's home. Delete goes by this and not by the name: the files are
    // theirs by where they are, and a scope is only what the author called the package.
    local: info.source?.kind === "local",
    pin: pinOf(info),
    license: licenseOf(info.root),
    available: false,
    tip: null,
    update: null,
    // Unpublished work: the version here against the version the registries hold. Filled by `mergeRows`,
    // which is the only place that has the index to compare against.
    ahead: null,
    readme: false,
    forkedFrom: info.forkedFrom ? { name: info.forkedFrom.name, version: info.forkedFrom.version } : null,
    // A fork against its origin as the origin stands now: what it was copied from, what that is at today,
    // and whether this copy has changed anything at all. `forkedFrom` alone only ever said the first of the
    // three, which is the half of the sentence that lets a fork sit there missing every fix.
    // `everyone` is the origin being the house default. It travels with the fork rather than with the row
    // itself, because the row is not everyone's -- that is the whole point of it, and the person holding it
    // has no other way to learn that the package they stepped away from is what everybody else runs.
    fork: info.fork ? { name: info.fork.name, version: info.fork.version, shipped: info.fork.shipped ?? null, identical: !!info.fork.identical, everyone: !!info.fork.everyone } : null,
    replaced: info.replaced ?? null,
    steps: (info.thetis?.steps ?? []).map((s) => ({ id: s.id, phase: s.phase })),
    tools: (info.thetis?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })),
    service: !!info.thetis?.service,
    skills: skillCount(info.root, info.thetis?.skills),
    hasSkills: typeof info.thetis?.skills === "string" && !!info.thetis.skills,
    pages: pageCount(info.thetis?.ui),
    screens: screensOf(info.thetis?.ui),
    bench: benchOf(info),
  };
}

/**
 * The screens a package adds that a person can open, for the Overview's "Adds the Workflows screen: ☰ →
 * Workflows": its places, then its docks, each `{ slot, id, label }`.
 */
export function screensOf(ui) {
  if (!ui || typeof ui !== "object") return [];
  const out = [];
  for (const slot of ["places", "dock"]) for (const e of Array.isArray(ui[slot]) ? ui[slot] : []) if (e && typeof e.id === "string") out.push({ slot: slot === "places" ? "place" : "dock", id: e.id, label: typeof e.label === "string" ? e.label : e.id });
  return out;
}

/**
 * How many skills a package brings: the `SKILL.md` files under the directory its manifest names. Read from
 * disk, because the manifest names only the directory. Zero when there is none.
 */
export function skillCount(root, dir) {
  if (!root || typeof dir !== "string" || !dir) return 0;
  let n = 0;
  const walk = (at, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(resolve(at, e.name), depth + 1);
      else if (e.name === "SKILL.md") n += 1;
    }
  };
  walk(resolve(root, dir), 0);
  return n;
}

/** The `name:` and `description:` lines of a SKILL.md's front matter, or null when it has none. */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const field = (key) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]);
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return { name: field("name"), description: field("description") };
}

/**
 * The skills a package brings, each with the first sentence of its description: what the page's Overview
 * lists for a skill extension, the way it lists a tool extension's tools. Read from the SKILL.md files under
 * the directory the manifest names; a file without front matter is named by its directory.
 */
export function skillList(root, dir, limit = 200) {
  if (!root || typeof dir !== "string" || !dir) return [];
  const out = [];
  const walk = (at, rel, depth) => {
    if (depth > 4 || out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    // The skill in this directory first, then its children: a parent skill reads before the ones under it.
    const sorted = entries.sort((a, b) => (a.name === "SKILL.md" ? -1 : b.name === "SKILL.md" ? 1 : a.name.localeCompare(b.name)));
    for (const e of sorted) {
      if (e.isDirectory()) walk(resolve(at, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      else if (e.name === "SKILL.md") {
        let fm = null;
        try {
          fm = frontMatter(readFileSync(resolve(at, e.name), "utf8"));
        } catch {
          fm = null;
        }
        const description = fm?.description ?? "";
        const first = /^(.+?[.!?])(\s|$)/.exec(description);
        out.push({ name: fm?.name || rel || dir, description: first ? first[1] : description });
      }
    }
  };
  walk(resolve(root, dir), "", 0);
  return out;
}

/**
 * The keys a person must give before a package works, from its `thetis.config` declaration: required, with
 * no default, and not an admin's to set. `[{ key, secret, help }]`, in declaration order.
 */
export function needsOfDecls(decls) {
  if (!decls || typeof decls !== "object") return [];
  return Object.entries(decls)
    .filter(([, d]) => d && d.required && d.default === undefined && d.scope !== "system")
    .map(([key, d]) => ({ key, secret: !!d.secret, help: typeof d.help === "string" ? d.help : "" }));
}

/** How many places, docks and panels a package adds to the page. */
export function pageCount(ui) {
  if (!ui || typeof ui !== "object") return 0;
  return ["places", "dock", "panel", "sidebar", "shelf"].reduce((n, slot) => n + (Array.isArray(ui[slot]) ? ui[slot].length : 0), 0);
}

// ---- which rows are system components ----
//
// A person looking for something to add should see what they could want: tools, skills, integrations, pages.
// The parts that make the installation run -- the host packages, the storage driver, the gateways, the model
// provider, the harness itself, the index service, the benchmarks, the page's own plumbing -- are still
// here, and an admin still needs them, in the folded "Part of Thetis" section. A manifest can say which it is
// with `thetis.audience` ("system" or "everyone"); without one, the type and the name decide. `"admin"` is a
// different question -- who may be offered it (`isAdminOnly` in lib/state.js) -- and leaves this one to the
// type and the name.

const COMPONENT_TYPES = new Set(["host", "storage", "gateway", "provider", "skill-type", "service"]);
const COMPONENT_NAMES = new Set(["harness-core", "prompt-cache", "bench", "bench-probe", "ui-admin", "ui-marketplace", "ui-context", "ui-tools", "ui-skills"]);
/** The skill loaders are alternatives to one another. The one a person has is theirs; the others are components. */
const SKILL_LOADERS = new Set(["skills-all", "skills-l1", "skills-hybrid"]);

/** Whether a row is one of Thetis's own parts, listed under "Part of Thetis". */
export function isComponent(row) {
  if (row.audience === "system") return true;
  if (row.audience === "everyone") return false;
  const base = String(row.name ?? "").replace(/^@[^/]+\//, "");
  if (SKILL_LOADERS.has(base)) return !row.installed;
  return COMPONENT_TYPES.has(row.type) || COMPONENT_NAMES.has(base);
}

/** A system package this person does not have, as a row: on disk, already built, installable by name. */
export const catalogRow = (info) => installedRow(info, false);

/** An index entry as a row: not installed here and not on disk, offered by its registry. */
export function indexRow(entry) {
  return {
    name: entry.name,
    label: labelOf({ name: entry.name, thetis: { label: entry.label } }),
    labelGiven: typeof entry.label === "string" && !!entry.label.trim(),
    version: entry.version,
    type: entry.type,
    description: entry.description ?? "",
    audience: typeof entry.audience === "string" ? entry.audience : null,
    needs: Array.isArray(entry.needs) ? entry.needs.filter((n) => n && typeof n.key === "string").map((n) => ({ key: n.key, secret: !!n.secret, help: typeof n.help === "string" ? n.help : "" })) : [],
    keywords: entry.keywords ?? [],
    registry: entry.registry,
    source: entry.source,
    installed: false,
    system: false,
    everyone: false,
    everyoneBy: null,
    own: false,
    local: false,
    pin: null,
    license: null,
    available: true,
    tip: entry.version,
    update: null,
    ahead: null,
    readme: !!entry.readme,
    forkedFrom: entry.forkedFrom && typeof entry.forkedFrom.name === "string" ? { name: entry.forkedFrom.name, version: String(entry.forkedFrom.version ?? "") } : null,
    fork: null,
    replaced: null,
    steps: entry.steps ?? [],
    tools: (entry.tools ?? []).map((name) => ({ name, description: "" })),
    service: !!entry.service,
    skills: 0,
    hasSkills: !!entry.skills,
    pages: Number.isFinite(entry.pages) ? entry.pages : 0,
    screens: [],
    bench: entry.bench ? { suites: entry.bench.suites ?? [], ...(entry.bench.peerGroup ? { peerGroup: entry.bench.peerGroup } : {}), reports: [] } : null,
  };
}

/**
 * Installed rows first, then the system packages this person does not have, then what the registries offer
 * that is neither; one row per name. A row that the index also carries learns its registry, its source and
 * the registry's tip, and an installed one whether the commit it is pinned to is behind; one whose
 * workspace is running an older version than the files on disk is behind its own disk, index or no index.
 *
 * `catalog` is the kernel's list of system packages on disk. On an installation whose registry is the same
 * repository the checkout ships, nearly every offer in the index is also on disk, and the row is then a
 * system row: an install of it is a link by name, not a clone. `user` is who is asking, so a row can say
 * the package is their own.
 */
export function mergeRows(installed, entries, index, { catalog = [], user = "" } = {}) {
  const byName = new Map();
  const newer = new Map(behind(installed, index).map((b) => [b.name, b]));
  // The two directions, read off the same two lists. `behind` is what this installation is missing;
  // `ahead` is what it is holding that nobody else can have yet, which until now nothing anywhere showed.
  const unshared = new Map(ahead(installed, index).map((a) => [a.name, a]));
  // An installed row learns what is behind before the index is consulted: a copy whose workspace loaded an
  // older version than the one on disk is behind whether or not any registry carries the package.
  for (const info of installed) byName.set(info.name, withAhead(withUpdate(installedRow(info), newer.get(info.name)), unshared.get(info.name)));
  for (const info of catalog) if (!byName.has(info.name)) byName.set(info.name, catalogRow(info));
  // One complete offer per name. Equal versions keep the configured registry order.
  const offers = new Map();
  for (const entry of entries) {
    const held = offers.get(entry.name);
    if (!held || compareVersions(entry.version, held.version) > 0) offers.set(entry.name, entry);
  }
  for (const entry of offers.values()) {
    const have = byName.get(entry.name);
    if (!have) {
      byName.set(entry.name, indexRow(entry));
      continue;
    }
    const merged = { ...have, registry: entry.registry, source: entry.source, available: true, tip: entry.version, readme: !!entry.readme, keywords: entry.keywords ?? [], description: have.description || entry.description || "" };
    byName.set(entry.name, withAhead(withUpdate(renamed(merged, entry), newer.get(entry.name)), unshared.get(entry.name)));
  }
  // A system package on disk newer than the one a person installed from a registry names it too.
  for (const info of catalog) {
    const have = byName.get(info.name);
    if (have && have.installed) byName.set(info.name, renamed(have, { version: info.version, label: typeof info.thetis?.label === "string" ? info.thetis.label : null }));
  }
  const mine = user ? `@${user}/` : null;
  return [...byName.values()].map((r) => {
    const row = mine && r.installed && r.name.startsWith(mine) ? { ...r, own: true } : r;
    return { ...row, component: isComponent(row) };
  });
}

/**
 * One name per extension: the label of the newest version anybody here can see, so a person who has not
 * updated and one who never installed it read the same name. When that changes the label of the version the
 * person runs, `wasLabel` keeps the old one, and the update's sentence says "Now called <new>." `newer` is an
 * index entry or a catalog entry: `{ version, label }`.
 */
export function renamed(row, newer) {
  if (!newer?.label || compareVersions(newer.version, row.version) <= 0) return row;
  const label = labelOf({ name: row.name, thetis: { label: newer.label } });
  if (label === row.label) return row;
  return { ...row, label, labelGiven: true, ...(row.installed ? { wasLabel: row.wasLabel ?? row.label } : {}) };
}

/**
 * What the journal says about the rows, laid onto them: `givenBy` (the admin who installed it for this
 * person, when the latest install of an installed row was somebody else's), `sharedBy` on a promoted copy
 * (`{ from, owner, at }`: the original, whose it was, when), and `markedBy` on something an admin turned on for
 * everyone. `entries` is `journal.tail` as the person may read it -- the rows they are in -- oldest first; the
 * machine's own actors ("operator", "_system") are nobody.
 */
export function withJournal(rows, entries, user = "") {
  if (!Array.isArray(entries) || !entries.length) return rows;
  const person = (a) => typeof a === "string" && a && a !== "operator" && a !== "_system" && a !== "system";
  const installs = new Map();
  const shared = new Map();
  const marked = new Map();
  for (const e of entries) {
    const d = e?.data ?? {};
    if (e?.kind === "package.install" && e.target === user && typeof d.name === "string") installs.set(d.name, e.actor);
    else if (e?.kind === "package.promote" && typeof d.promoted === "string") shared.set(d.promoted, { from: typeof d.name === "string" ? d.name : null, owner: e.target ?? null, at: e.at ?? null });
    else if (e?.kind === "package.everyone" && typeof e.target === "string") {
      if (d.on === false) marked.delete(e.target);
      else if (person(e.actor)) marked.set(e.target, e.actor);
    }
  }
  return rows.map((r) => {
    const by = r.installed ? installs.get(r.name) : undefined;
    const extra = {};
    if (person(by) && by !== user) extra.givenBy = by;
    if (r.everyoneBy === "promoted" && shared.has(r.name)) extra.sharedBy = shared.get(r.name);
    if (r.everyone && r.everyoneBy === "marked" && marked.has(r.name)) extra.markedBy = marked.get(r.name);
    return Object.keys(extra).length ? { ...r, ...extra } : r;
  });
}

/**
 * The person's own folder: every package under `<home>/packages/` whose manifest is a Thetis package, as a row
 * that is not installed, carrying `folder: { dir }` -- the path an install sends, relative to the home, which is
 * how the kernel reads a local source. `installed` is the names this person has; a folder whose package is
 * installed is not listed, because the installed row already is that package. Nothing is thrown: a folder that
 * cannot be read is left out, and a home without `packages/` has no folder rows.
 */
export function folderRows(home, installed = []) {
  if (!home) return [];
  const have = new Set(installed);
  const at = resolve(home, "packages");
  let entries;
  try {
    entries = readdirSync(at, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const root = resolve(at, e.name);
    let m;
    try {
      m = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!m || typeof m.name !== "string" || typeof m.thetis?.type !== "string" || have.has(m.name)) continue;
    const dir = `packages/${e.name}`;
    const info = { name: m.name, version: String(m.version ?? ""), type: m.thetis.type, description: m.description ?? "", root, thetis: m.thetis, forkedFrom: m.thetis.forkedFrom, source: { kind: "local", ref: dir } };
    out.push({ ...installedRow(info, false), folder: { dir }, component: false });
  }
  return out;
}

/**
 * The folder rows laid over the merged rows: a folder whose package is also a row -- a registry's offer of the
 * person's own published package, say -- marks that row as being in their folder rather than adding a second
 * row with the same name.
 */
export function withFolder(rows, folder) {
  const byName = new Map(folder.map((f) => [f.name, f]));
  // What the files say fills what the index could not: its needs, skills, pages, origin and audience.
  const lay = (r, f) => ({ ...r, folder: f.folder, local: true, needs: r.needs?.length ? r.needs : f.needs, skills: r.skills || f.skills, hasSkills: r.hasSkills || f.hasSkills, pages: r.pages || f.pages, forkedFrom: r.forkedFrom ?? f.forkedFrom, audience: r.audience ?? f.audience });
  const merged = rows.map((r) => (!r.installed && byName.has(r.name) ? lay(r, byName.get(r.name)) : r));
  const seen = new Set(rows.map((r) => r.name));
  return [...merged, ...folder.filter((f) => !seen.has(f.name))];
}

/** The page's own filter for the rows the index does not carry, the same rule the index search uses for a name match. */
export function matchesQuery(info, terms, type) {
  if (type && info.type !== type) return false;
  const hay = `${info.name} ${info.type} ${info.description ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
