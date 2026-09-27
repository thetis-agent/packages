/* What a row carries beside its name. The person's chips -- at most two, from `stateOf` in state.js, each
 * with its tooltip -- are the same on a card and on a page, because `stateOf` is the one answer. The
 * maintainer's badges (published or not, the benchmarks) live on the page's Details tab only. `badge` is the
 * shell's, handed in so this module needs nothing of the seam. */

/** The chips of a state as the shell's badges, each with its tooltip as the title. */
export function chipNodes(badge, chips) {
  return (chips ?? []).map((c) => {
    const node = badge(c.label, c.tone);
    if (node && typeof node === "object") {
      if (typeof node.setAttribute === "function") {
        node.setAttribute("title", c.tooltip);
        node.setAttribute("data-chip", c.id);
      } else Object.assign(node, { title: c.tooltip, chip: c.id });
    }
    return node;
  });
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
 * The other direction from an update: not something newer than what is here, but something here that is
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
  // for a mistake that is not there. So it is no badge at all: the Details tab's "published" row says "not in
  // any registry", which is the whole of what is known.
  if (a.state === "unpublished") return null;
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

/** The maintainer's badges, for the Details tab: published or not, and the benchmarks. */
export const technicalBadges = (badge, r) => [aheadBadge(badge, r), benchBadge(badge, r)].filter(Boolean);
