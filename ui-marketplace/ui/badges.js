/* The badges a row carries, the same on a card and on a page: whose the extension is (Included, Yours),
 * whether the person has it, a copy against its official version, an update ready, whether the work here has
 * been published anywhere, and what the benchmarks say. `badge` is the shell's, handed in so this module
 * needs nothing of the seam. The words follow the rule for people: no workspace, reload, fork or commit. */

/**
 * Whose the extension is, in the words a person uses. `Included` is everyone's default: the installation gives
 * it to every person. `Yours` is the person's own (their namespace, or a copy under their home). Anything else
 * says nothing here: the section it is in (Installed or Discover) already says whether they have it, and
 * where a registry offer comes from is a technical detail on its page.
 */
export function stateBadge(badge, r) {
  if (r.everyone) return badge("Included", "accent");
  if (r.own || (r.installed && r.local && !r.fork && !r.forkedFrom)) return badge("Yours", "dim");
  return null;
}

/** In this person's space, or nothing: the Install button is what says the other half. */
export const installedBadge = (badge, r) => (r.installed ? badge("Installed", "ok") : null);

/**
 * A person's copy of an extension, against the official version as it stands now. The strongest true
 * sentence wins: a copy with no changes says so rather than saying "your copy". `superseded` comes from the
 * `updates` answer, which is the only place that compares the copy with what it was copied from; the page
 * passes it in when it has it.
 */
export function forkBadge(badge, r, { superseded = false } = {}) {
  const fork = r.fork;
  const origin = fork?.name ?? r.forkedFrom?.name;
  if (!origin) return null;
  if (superseded) return badge("Your changes are in the official version", "warn");
  if (!fork) return badge(`Your copy of ${origin}`, "warn");
  // The origin is what everyone here gets by default. A clause, never the reason to act: the kernel will not
  // install a package over somebody's copy of it, so this badge is the only place that reaches the person.
  const everyone = fork.everyone ? " · everyone else uses the official one" : "";
  if (fork.identical && fork.shipped) return badge(`Your copy has no changes${everyone}`, "warn");
  if (fork.shipped && fork.shipped !== fork.version) return badge(`Your copy of ${origin} · the official version is newer${everyone}`, "warn");
  return badge(`Your copy of ${origin}${everyone}`, "warn");
}

/**
 * Something newer than what is in service, said the same way whatever catches it up: fetching a newer commit
 * and applying it, or only applying files that are here already. The difference is the updater's business,
 * not the person's. A copy whose official version moved on is the third kind, and says so in its own words.
 */
export function updateBadge(badge, r) {
  const update = r.update;
  if (!update) return null;
  if (update.apply === "unfork") return badge(update.identical ? "No changes · switch back" : "Official version is newer", "warn");
  return badge("Update ready", "warn");
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
  // for a mistake that is not there. "Local only" is the short form on a card; the page's technical details
  // say the long one, "no registry here lists it", which is what `thetis packages outdated` prints.
  if (a.state === "unpublished") return badge("Local only", "dim");
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
export const stateBadges = (badge, r, { superseded = false } = {}) => [stateBadge(badge, r), installedBadge(badge, r), forkBadge(badge, r, { superseded }), r.update?.apply === "unfork" ? null : updateBadge(badge, r)].filter(Boolean);

/** The maintainer's badges, for the Technical details tab: published or not, and the benchmarks. */
export const technicalBadges = (badge, r) => [aheadBadge(badge, r), benchBadge(badge, r)].filter(Boolean);
