// One row per package name, from two lists: what is installed here (`env.kernel.packages.list()`) and
// what the index in the shared directory offers. An installed package comes first and keeps its own
// facts; the index adds where it came from and whether the registry has moved on. Nothing here changes
// anything: a row is what a person reads before deciding.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { behind, shortCommit } from "@thetis/marketplace";

const PIN = /@([0-9a-f]{40})$/;

/** The short commit an installed git source is pinned to, or null for a local or shipped copy. */
export function pinOf(info) {
  const ref = info.source?.kind === "git" ? info.source.ref : "";
  const m = PIN.exec(ref);
  return m ? shortCommit(m[1]) : null;
}

/** Folds "there is a newer one" onto a row in the short form a person reads. */
export function withUpdate(row, found) {
  if (!found) return row;
  return { ...row, update: { version: found.version, from: shortCommit(found.installed), to: shortCommit(found.available), source: found.source, registry: found.registry } };
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

/** An installed package as a row. `tools` keeps the descriptions; the page shows them as pills with a title. */
export function installedRow(info) {
  return {
    name: info.name,
    version: info.version,
    type: info.type,
    description: info.description ?? "",
    keywords: [],
    registry: null,
    source: null,
    installed: true,
    scope: info.everyone ? "everyone" : "me",
    pin: pinOf(info),
    license: licenseOf(info.root),
    available: false,
    tip: null,
    update: null,
    readme: false,
    forkedFrom: info.forkedFrom ? { name: info.forkedFrom.name, version: info.forkedFrom.version } : null,
    replaced: info.replaced ?? null,
    steps: (info.thetis?.steps ?? []).map((s) => ({ id: s.id, phase: s.phase })),
    tools: (info.thetis?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })),
    service: !!info.thetis?.service,
    bench: benchOf(info),
  };
}

/** An index entry as a row: not installed here, offered by its registry. */
export function indexRow(entry) {
  return {
    name: entry.name,
    version: entry.version,
    type: entry.type,
    description: entry.description ?? "",
    keywords: entry.keywords ?? [],
    registry: entry.registry,
    source: entry.source,
    installed: false,
    scope: null,
    pin: null,
    license: null,
    available: true,
    tip: entry.version,
    update: null,
    readme: !!entry.readme,
    forkedFrom: null,
    replaced: null,
    steps: entry.steps ?? [],
    tools: (entry.tools ?? []).map((name) => ({ name, description: "" })),
    service: !!entry.service,
    bench: entry.bench ? { suites: entry.bench.suites ?? [], ...(entry.bench.peerGroup ? { peerGroup: entry.bench.peerGroup } : {}), reports: [] } : null,
  };
}

/**
 * Installed rows first, then what the registries offer that is not installed; one row per name. An
 * installed row that the index also carries learns its registry, its source and the registry's tip, and
 * whether the commit it is pinned to is behind.
 */
export function mergeRows(installed, entries, index) {
  const byName = new Map();
  for (const info of installed) byName.set(info.name, installedRow(info));
  const newer = new Map(behind(installed, index).map((b) => [b.name, b]));
  for (const entry of entries) {
    const have = byName.get(entry.name);
    if (!have) {
      byName.set(entry.name, indexRow(entry));
      continue;
    }
    const merged = { ...have, registry: entry.registry, source: entry.source, available: true, tip: entry.version, readme: !!entry.readme, keywords: entry.keywords ?? [], description: have.description || entry.description || "" };
    byName.set(entry.name, withUpdate(merged, newer.get(entry.name)));
  }
  return [...byName.values()];
}

/** The page's own filter for installed packages, the same rule the index search uses for a name match. */
export function matchesQuery(info, terms, type) {
  if (type && info.type !== type) return false;
  const hay = `${info.name} ${info.type} ${info.description ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
