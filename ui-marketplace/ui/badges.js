/* The badges a row carries, the same on a card and on a page: its state (Only me, Everyone, Available),
 * a fork's origin, an update or a reload on offer, whether the work here has been published anywhere, and
 * what the benchmarks say. `badge` is the shell's, handed in so this module needs nothing of the seam. */

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
  // The origin is what everyone here gets by default. It is a clause on whichever sentence wins rather
  // than a sentence of its own, because it is never the reason to act -- it is the context for acting. An
  // admin cannot make that default this person's, since the kernel will not install a package over
  // somebody's fork of it, so this row is the only place the decision reaches them.
  const everyone = fork.everyone ? " · everyone else gets that one" : "";
  if (fork.identical && fork.shipped) return badge(`identical to ${fork.name} ${fork.shipped}, which is shipped${everyone}`, "warn");
  if (fork.shipped && fork.shipped !== fork.version) return badge(`fork of ${fork.name} ${fork.version} · ${fork.shipped} is shipped now${everyone}`, "warn");
  return badge(`fork of ${fork.name} ${fork.version}${everyone}`, "warn");
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
 * This package's own record of the last act against one of the publish targets, or null. Two lists are in
 * play and nothing reconciles them: `ahead` reads the marketplace *index*, which covers the registries
 * `@thetis/marketplace` mirrors, while a publish goes to one of `@thetis/package-publish`'s *targets*. They
 * need not overlap, and where they do not a publish leaves no mark on the index at all -- which is how a
 * package read `never published` for ever, immediately after a successful publish of it.
 *
 * So when the two disagree, the record wins: it is first-hand knowledge that a publish happened, while the
 * index's silence only ever means that no mirrored registry lists the package. The record is thin on
 * purpose -- `publish_targets` carries the last publish and the last removal per target, so a package
 * published before something else went to the same target leaves no trace here and reads as it did before.
 * That is a floor under the truth, not a claim to the whole of it.
 */
export function publishRecord(publish, name) {
  let best = null;
  for (const t of publish?.targets ?? []) {
    for (const doc of [t.lastPublish, t.lastRemoval]) {
      if (!doc || doc.name !== name || !doc.at) continue;
      // The two keys are kept apart by the publishing package precisely so that this comparison can be
      // made: a package taken out of a target after it was published to it is not published there.
      if (!best || String(doc.at) > String(best.at)) best = { target: t.name, version: doc.version ?? "", at: doc.at, removed: !!doc.removed };
    }
  }
  return best;
}

/**
 * The other direction from `updateBadge`: not something newer than what is here, but something here that is
 * newer than anywhere else. Whoever maintains a package runs it from the same checkout every fence loads, so
 * a version bump is live for them the moment it lands while the registry every other installation reads is
 * still on the old one. No badge has ever said so, and the person holding the gap is the only person who can
 * close it.
 *
 * Kept short on purpose. This badge rides on a gallery card beside the package's name, where `.mk-card-head`
 * wraps and a long badge takes the name's line away from it.
 */
export function aheadBadge(badge, r, record = null) {
  const a = r.ahead;
  // The record is not about the index, so it never contradicts `ahead` where `ahead` has something to say:
  // a registry holding an older version is a true sentence about that registry, and the badge goes on
  // saying it. It answers the one case where the index's silence was read as a fact about the package.
  if (a?.state === "unpublished" && record) {
    return record.removed ? badge(`taken out of ${record.target}`, "dim") : badge(`published to ${record.target} · not in the index`, "dim");
  }
  if (!a) return null;
  // Two tones, because the two cases are not the same size. A package no registry has ever listed is a
  // quiet fact and very often the right state -- on the machine of whoever maintains these packages it is
  // true of nearly all of them at once, and a gallery of amber says nothing at all. A version here that is
  // past what a registry holds is a gap between what this installation runs and what anybody else can get,
  // and that is the one worth standing out. "never published" rather than "unpublished": the first is a
  // fact about the registries, the second reads like a judgement on the package.
  if (a.state === "unpublished") return badge("never published", "dim");
  return badge(`${a.version} here, ${a.published} published`, "warn");
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
export const stateBadges = (badge, r, record = null) => [stateBadge(badge, r), forkBadge(badge, r), r.update?.apply === "unfork" ? null : updateBadge(badge, r), aheadBadge(badge, r, record), benchBadge(badge, r)].filter(Boolean);
