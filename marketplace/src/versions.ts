// Comparing two version strings, because a string comparison is wrong in the one place it matters: `0.10.0`
// sorts before `0.9.0` as text, and the tenth release of a line is exactly when a person stops reading the
// numbers and starts trusting the badge. There is no semver dependency in this repository and there is not
// going to be one for a function this size, so the rule is written here and tested here.
//
// The rule is semver's, kept to what versions in this repository actually look like:
//   - the core is dot-separated, compared part by part as numbers, a missing part counting as 0, so
//     `1.2` and `1.2.0` are the same version;
//   - a part that is not a number is compared as text against the other side's, which is how a hand-written
//     `1.2.x` or a date-like version still orders itself instead of collapsing to 0;
//   - build metadata after `+` is not part of the version at all and is dropped before anything else;
//   - a prerelease (`1.2.0-rc.1`) is OLDER than the release it leads to (`1.2.0`), which is the one rule
//     people get backwards, and the one that decides whether `0.1.1-fork.1` counts as newer than `0.1.1`.
//     It does not. A fork's rewritten version is not unpublished work.
//   - prerelease identifiers are compared one by one: numeric ones numerically, and a numeric one is lower
//     than a text one; a prerelease that runs out of identifiers first is lower.

/** The numeric value of an identifier, or undefined when it is not a plain run of digits. */
const numeric = (part: string): number | undefined => (/^\d+$/.test(part) ? Number(part) : undefined);

const cmp = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Splits `1.2.0-rc.1+build` into its core parts and its prerelease parts, dropping the build metadata. */
function parts(version: string): { core: string[]; pre: string[] } {
  const clean = String(version ?? "").trim().split("+")[0];
  const dash = clean.indexOf("-");
  const core = (dash === -1 ? clean : clean.slice(0, dash)).split(".");
  const pre = dash === -1 ? [] : clean.slice(dash + 1).split(".").filter(Boolean);
  return { core, pre };
}

/** Compares one prerelease against another. Empty means "no prerelease", which is the higher of the two. */
function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    // The one that ran out of identifiers is the lower: `1.0.0-rc` precedes `1.0.0-rc.1`.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = numeric(x);
    const ny = numeric(y);
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return cmp(nx, ny);
      continue;
    }
    // A numeric identifier is always lower than a text one, whatever the text is.
    if (nx !== undefined) return -1;
    if (ny !== undefined) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 when `a` is older than `b`, 1 when it is newer, 0 when the two name the same version. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const x = left.core[i] ?? "0";
    const y = right.core[i] ?? "0";
    const nx = numeric(x);
    const ny = numeric(y);
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return cmp(nx, ny);
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

/** True when `version` is strictly newer than `other`. The question every caller here is actually asking. */
export const isNewer = (version: string, other: string): boolean => compareVersions(version, other) > 0;
