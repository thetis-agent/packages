// Versions, only as far as this package needs them: whether a string is one this package may publish, what
// the next patch, minor or major is, and which of two is newer.
//
// The last of those is **not written here**, and used to be. `@thetis/marketplace` decides whether a badge
// says a package is ahead of the registry and this package decides whether the publish is allowed at all,
// which is the same question asked twice; two implementations of it meant a badge could say a package was
// ahead while the publish refused it. So the ordering has one home, `@thetis/runtime/lib/versions`, and both sides
// import it. That is the one dependency this package has, and it is the same arrangement `@thetis/tool-exec`
// already has with `@thetis/runtime/lib`: a shipped package is linked into a userspace rather than installed with
// npm, so nothing is fetched into a fence to satisfy it.
//
// The split that remains is deliberate and is the whole rule: **lenient about what it reads, strict about
// what it writes.** A version this package is about to publish has to be a real semantic version, because
// it is going into a registry every other installation compares against, and that is `isVersion`. A version
// it is measured *against* comes out of somebody else's manifest in a registry, is not this package's to
// reject, and is ordered rather than refused.
export { compareVersions, isNewer } from "@thetis/runtime/lib/versions";

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** Whether this is a version this package may publish. Strict on purpose: see the head of this file. */
export function isVersion(value) {
  return RE.test(String(value ?? ""));
}

export function parseVersion(value) {
  const m = RE.exec(String(value ?? ""));
  if (!m) return null;
  // Build metadata (`+sha`) is deliberately dropped: semver says it takes no part in ordering, so two
  // versions that differ only there would compare equal and neither could be published over the other.
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/**
 * The next version one step along, or null when there is no step to take from this one. A prerelease is
 * dropped rather than carried: bumping 1.2.0-rc.1 by a patch gives 1.2.0, because the release the
 * prerelease was leading up to is what comes next.
 *
 * Null is a real answer and not a failure. A registry may hold a package at `1.2`, which orders perfectly
 * well and is still not a version this package can name the successor of without inventing one; the
 * refusal that would have suggested it says what is in the way instead.
 */
export function bumpVersion(value, how) {
  const v = parseVersion(value);
  if (!v) return null;
  if (how === "major") return `${v.major + 1}.0.0`;
  if (how === "minor") return `${v.major}.${v.minor + 1}.0`;
  if (how === "patch") return v.pre.length ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
  return null;
}
