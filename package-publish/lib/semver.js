// Semantic versions, only as far as this package needs them: whether a string is one, which of two is
// newer, and what the next patch, minor or major is. It is written out rather than depended on because the
// package ships no node_modules into the fence, and because the comparison here is the gate the whole
// package exists for: a publish that does not move past what the registry holds is invisible to every
// update check, so the rule that decides it should be readable in one file.
const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

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

/** -1, 0 or 1, the way a comparator answers. Null when either side is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  // A release outranks any prerelease of the same numbers: 1.0.0 is newer than 1.0.0-rc.1, which is the
  // one rule here that is not simply "bigger wins" and the one a hand-rolled compare usually gets wrong.
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const a1 = x.pre[i];
    const b1 = y.pre[i];
    if (a1 === undefined) return -1;
    if (b1 === undefined) return 1;
    const na = /^\d+$/.test(a1);
    const nb = /^\d+$/.test(b1);
    if (na && nb) {
      if (Number(a1) !== Number(b1)) return Number(a1) < Number(b1) ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (a1 !== b1) {
      return a1 < b1 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The next version one step along. A prerelease is dropped rather than carried: bumping 1.2.0-rc.1 by a
 * patch gives 1.2.0, because the release the prerelease was leading up to is what comes next.
 */
export function bumpVersion(value, how) {
  const v = parseVersion(value);
  if (!v) return null;
  if (how === "major") return `${v.major + 1}.0.0`;
  if (how === "minor") return `${v.major}.${v.minor + 1}.0`;
  if (how === "patch") return v.pre.length ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
  return null;
}
