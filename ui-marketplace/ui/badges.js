/* The badges a row carries, the same on a card and on a page: its state (Only me, Everyone, Available),
 * a fork's origin, an update or a reload on offer, and what the benchmarks say. `badge` is the shell's, handed in so
 * this module needs nothing of the seam. */

export function stateBadge(badge, r) {
  if (r.scope === "everyone") return badge("Everyone", "accent");
  if (r.installed) return badge("Only me", "dim");
  return badge(r.registry ? `Available · ${r.registry}` : "Available", "ok");
}

/**
 * What a fork is, against the package it was copied from as that package stands now. "fork of X 0.1.1" is
 * true and useless: it says nothing about whether X has moved on, and nothing about whether this copy
 * changed anything, which are the two facts that decide whether the fork is worth its cost. The strongest
 * true sentence wins, so a copy that is byte for byte the shipped package says so rather than saying "fork".
 */
export function forkBadge(badge, r) {
  const fork = r.fork;
  if (!fork) return r.forkedFrom ? badge(`fork of ${r.forkedFrom.name} ${r.forkedFrom.version}`, "warn") : null;
  if (fork.identical && fork.shipped) return badge(`identical to ${fork.name} ${fork.shipped}, which is shipped`, "warn");
  if (fork.shipped && fork.shipped !== fork.version) return badge(`fork of ${fork.name} ${fork.version} · ${fork.shipped} is shipped now`, "warn");
  return badge(`fork of ${fork.name} ${fork.version}`, "warn");
}

/**
 * Something newer than what is in service. Three kinds: the registry this came from holds a newer commit,
 * and an install takes it; or the files on disk have moved past the version this workspace loaded, and a
 * reload of the workspace is what puts them into service; or this is a fork and the package it was copied
 * from has gone on without it, and going back to that package is what takes the difference. Nothing has
 * been changed in any of the three; this is an offer.
 */
export function updateBadge(badge, r) {
  const update = r.update;
  if (!update) return null;
  // Terse, because this badge also rides on a gallery card beside the package's name. The card says there
  // is something here to act on; the package page says which package, and at what version.
  if (update.apply === "unfork") return badge(update.identical ? "identical to what is shipped" : `${update.available} is shipped now`, "warn");
  return badge(`${update.apply === "reload" ? "reload" : "update"} to ${update.version}`, "warn");
}

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

/**
 * The badges a package page carries. A fork that is behind its origin would otherwise say so twice, once as
 * the fork badge and once as the update badge, which are the same sentence at two lengths; the fork badge
 * is the longer and the truer of the two, so the update badge stands down for it here. The gallery, which
 * draws no fork badge, keeps the terse one.
 */
export const stateBadges = (badge, r) => [stateBadge(badge, r), forkBadge(badge, r), r.update?.apply === "unfork" ? null : updateBadge(badge, r), benchBadge(badge, r)].filter(Boolean);
