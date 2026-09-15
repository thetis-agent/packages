/* The badges a row carries, the same on a card and on a page: its state (Only me, Everyone, Available),
 * a fork's origin, an update on offer, and what the benchmarks say. `badge` is the shell's, handed in so
 * this module needs nothing of the seam. */

export function stateBadge(badge, r) {
  if (r.scope === "everyone") return badge("Everyone", "accent");
  if (r.installed) return badge("Only me", "dim");
  return badge(r.registry ? `Available · ${r.registry}` : "Available", "ok");
}

export const forkBadge = (badge, r) => (r.forkedFrom ? badge(`fork of ${r.forkedFrom.name} ${r.forkedFrom.version}`, "warn") : null);

/** A newer commit exists in the registry this came from. Nothing has been changed; this is an offer. */
export const updateBadge = (badge, r) => (r.update ? badge(`update to ${r.update.version}`, "warn") : null);

/**
 * What the benchmarks say. A package that opts in but has never been run says so, because "not measured"
 * and "measured and fine" are different things and a blank badge would hide which one this is.
 */
export function benchBadge(badge, r) {
  const bench = r.bench;
  if (!bench?.suites?.length) return null;
  const reports = bench.reports || [];
  if (!reports.length) return badge("bench: not run", "dim");
  const failed = reports.filter((x) => !x.passed).length;
  if (failed) return badge(`bench: ${failed} of ${reports.length} failed conformance`, "warn");
  return badge(`bench: ${reports.length} suite${reports.length === 1 ? "" : "s"}`, "ok");
}

export const stateBadges = (badge, r) => [stateBadge(badge, r), forkBadge(badge, r), updateBadge(badge, r), benchBadge(badge, r)].filter(Boolean);
