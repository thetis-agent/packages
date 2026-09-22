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
 * What this workspace's own record says about **one package** at whichever target it last touched, or null.
 *
 * Two lists are in play and nothing reconciles them: `ahead` reads the marketplace *index*, which covers the
 * registries `@thetis/marketplace` mirrors, while a publish goes to one of `@thetis/package-publish`'s
 * *targets*. They need not overlap, and where they do not a publish leaves no mark on the index at all. The
 * index's silence is therefore a fact about what is mirrored here and never evidence that nothing was
 * published; the record is the only thing that knows otherwise, because the person did it from here.
 *
 * It reads `record`, which `publish_targets` answers only when it is asked **about a package** and which is
 * about that package: `{ published, publishedAt, removed, removedAt, latest, commit }`, with `latest` saying
 * which of the two acts is the later one, or null for a package this person has done neither to here. The
 * per-target `lastPublish` and `lastRemoval` answer a different question -- what last happened at this
 * target, whatever package it was of -- and reading one for the other is the bug this replaced: the next
 * publish of anything else overwrote the key, and a row that had been telling the truth quietly stopped.
 */
export function publishRecord(publish, name) {
  // The cheap call carries no `record` at all and the expensive one carries somebody else's unless it was
  // asked about this package, so the answer has to say whose it is before any of it is read.
  if (!publish || !name || publish.package?.name !== name) return null;
  let best = null;
  for (const t of publish.targets ?? []) {
    const r = t.record;
    if (!r?.latest) continue;
    const removed = r.latest === "removed";
    const at = removed ? r.removedAt : r.publishedAt;
    if (!at) continue;
    const found = { target: t.name, version: (removed ? r.removed : r.published) ?? "", at, removed, commit: r.commit ?? null };
    if (!best || String(found.at) > String(best.at)) best = found;
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
export function aheadBadge(badge, r) {
  const a = r.ahead;
  if (!a) return null;
  // Two tones, because the two cases are not the same size. A package the index does not carry is a quiet
  // fact and very often the right state -- on the machine of whoever maintains these packages it is true of
  // nearly all of them at once, and a gallery of amber says nothing at all. A version here that is past
  // what a registry holds is a gap between what this installation runs and what anybody else can get, and
  // that is the one worth standing out.
  //
  // Not "never published", which is a claim the index cannot support: it is built only from the registries
  // this installation mirrors, so its silence is a fact about what is mirrored here and not about the
  // world. A package can sit in a registry nobody here trusts, and saying otherwise sends somebody looking
  // for a mistake that is not there. This is the sentence `thetis packages outdated` prints, word for word,
  // and the one the page and the control panel say, so one package does not read two ways in three places.
  if (a.state === "unpublished") return badge("no registry here lists it", "dim");
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
 * The badges a package page carries, and the same ones a gallery card carries: a badge is a summary of
 * state, so it has to mean the same thing wherever it is read. What a surface knows and the others do not
 * -- this workspace's own record of a publish, which only a page asking about one package can afford to
 * fetch -- belongs in that page's facts, under it, and not in a badge that would then disagree with the
 * card the person clicked to get there.
 *
 * A fork that is behind its origin would otherwise say so twice, once as
 * the fork badge and once as the update badge, which are the same sentence at two lengths; the fork badge
 * is the longer and the truer of the two, so the update badge stands down for it here. The gallery, which
 * draws no fork badge, keeps the terse one.
 */
export const stateBadges = (badge, r) => [stateBadge(badge, r), forkBadge(badge, r), r.update?.apply === "unfork" ? null : updateBadge(badge, r), aheadBadge(badge, r), benchBadge(badge, r)].filter(Boolean);
