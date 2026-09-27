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
    version: info.version,
    type: info.type,
    description: info.description ?? "",
    audience: typeof info.thetis?.audience === "string" ? info.thetis.audience : null,
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
    pages: pageCount(info.thetis?.ui),
    bench: benchOf(info),
  };
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
// here, and an admin still needs them, but behind "Show system components". A manifest can say which it is
// with `thetis.audience` ("system" or "everyone"); without one, the type and the name decide.

const COMPONENT_TYPES = new Set(["host", "storage", "gateway", "provider", "skill-type", "service"]);
const COMPONENT_NAMES = new Set(["harness-core", "prompt-cache", "bench", "bench-probe", "ui-admin", "ui-marketplace", "ui-context", "ui-tools", "ui-skills"]);
/** The skill loaders are alternatives to one another. The one a person has is theirs; the others are components. */
const SKILL_LOADERS = new Set(["skills-all", "skills-l1", "skills-hybrid"]);

/** Whether a row is a system component, hidden until a person asks to see them. */
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
    version: entry.version,
    type: entry.type,
    description: entry.description ?? "",
    audience: typeof entry.audience === "string" ? entry.audience : null,
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
    forkedFrom: null,
    fork: null,
    replaced: null,
    steps: entry.steps ?? [],
    tools: (entry.tools ?? []).map((name) => ({ name, description: "" })),
    service: !!entry.service,
    skills: 0,
    pages: 0,
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
    byName.set(entry.name, withAhead(withUpdate(merged, newer.get(entry.name)), unshared.get(entry.name)));
  }
  const mine = user ? `@${user}/` : null;
  return [...byName.values()].map((r) => {
    const row = mine && r.installed && r.name.startsWith(mine) ? { ...r, own: true } : r;
    return { ...row, component: isComponent(row) };
  });
}

/** The page's own filter for the rows the index does not carry, the same rule the index search uses for a name match. */
export function matchesQuery(info, terms, type) {
  if (type && info.type !== type) return false;
  const hay = `${info.name} ${info.type} ${info.description ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
