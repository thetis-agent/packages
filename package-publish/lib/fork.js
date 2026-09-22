// A fork knows where it came from, so a publish can ask what that means instead of guessing.
//
// `fork_package` copies a package and writes `thetis.forkedFrom` into the copy: the name and the version it
// was taken from. So "publish my change" said over a fork is two entirely different acts wearing the same
// words. It can mean the change becomes the next version of the package it came from, which is upstreaming
// and the reason most people fork at all; or it can mean this is a package of its own now, deliberately
// apart from the one it came from. Both are legitimate, so the answer is not to pick one.
//
// Guessing is what this package did before, and it looked like it worked. A fork published under its own
// name made the registry quietly grow a second package, the person's change went out under a name nobody
// installs, and un-forking put them back on the old code. Nothing warned, and the loop did not close.
//
// The question is asked once, and the registry is what remembers the answer: the gate fires when the target
// holds the origin and does not yet hold this fork. Once the fork is in the registry under its own name
// there is no second reading left -- a publish is the next version of the package the registry already
// carries -- and asking again every time would be a setting that records an intention rather than a state.
import { refuse } from "./refuse.js";
import { bumpVersion } from "./semver.js";

/** A fork's own version, which is never a version the origin can be published at. */
const FORK_VERSION = /-fork\.\d+$/;

/** The origin a manifest names, or null for a package that is nobody's copy. */
export function forkedFrom(manifest) {
  const f = manifest?.thetis?.forkedFrom;
  if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name.trim()) return null;
  return { name: f.name.trim(), version: typeof f.version === "string" && f.version.trim() ? f.version.trim() : null };
}

/** The unscoped half of a package name, which is the directory a registry gives it when it has none yet. */
export const unscoped = (name) => String(name ?? "").split("/").filter(Boolean).at(-1) ?? "";

/**
 * Which publish this is. `itself` is every ordinary publish and the deliberate divergence; `origin` is the
 * upstreaming one. The blocker is returned rather than thrown so that the caller can refuse it or report it
 * on a dry run, the way the gates about the state of the tree already do: a dry run changes nothing, so
 * there is nothing to protect by refusing, and the useful answer is both choices and what each would do.
 *
 * The two arguments that are plainly mistakes in the call are refused here and on a dry run alike: `as`
 * with a word that is not one of the two, and `as origin` on a package that is not a fork. Reporting those
 * back as findings would be reporting the caller their own typing.
 */
export function chooseAs({ args, spec, pkg, origin, where, target }) {
  const asked = typeof args.as === "string" && args.as.trim() ? args.as.trim().toLowerCase() : null;
  if (asked && asked !== "origin" && asked !== "itself") {
    refuse("bad-as", `A publish goes as origin or as itself, not as ${asked}. As its origin, the change becomes the next version of the package this one was forked from; as itself, it is a package of its own.`);
  }
  if (asked === "origin") {
    if (!origin) refuse("not-a-fork", `${pkg.name} is not a fork: its manifest has no thetis.forkedFrom, so there is no origin to publish it as. Publish it as itself, which is what leaving as out does.`);
    // The checkout case has no second reading to offer. A package inside the registry repository is kept in
    // the directory it already sits in, and the publish commits that directory rather than copying anything
    // anywhere, so there is no way to put this tree in the origin's directory without rearranging somebody's
    // work tree for them.
    if (where.mode === "checkout") {
      refuse("fork-in-checkout", `${pkg.name} is inside the registry checkout at ${where.repo}, where a publish commits the directory a package already sits in and copies nothing, so it cannot go into ${origin.name}'s directory from there. Publish it as itself, or move the fork out of the checkout and publish it as its origin.`);
    }
    return { as: "origin" };
  }
  if (asked === "itself") return { as: "itself" };
  // Nothing to ask: not a fork, in a checkout where the directory decides, the target does not hold the
  // origin, or the target already holds this fork under its own name and so already carries the answer.
  if (!origin || where.mode !== "copy" || !where.origin || where.holdsName === pkg.name) return { as: "itself" };
  return { as: "itself", blocker: { code: "ambiguous-fork", message: ambiguous({ spec, pkg, origin, where, target }) } };
}

/** The refusal, which names both ways out and prints the command for each, because either could be right. */
function ambiguous({ spec, pkg, origin, where, target }) {
  const next = bumpVersion(where.origin.version, "patch") ?? "the version it becomes";
  const command = `thetis publish ${spec} --to ${target.name}`;
  return `${pkg.name} is a fork of ${origin.name}, and ${target.name} already holds ${origin.name} in ${where.origin.dir}/, so this publish could be two different things and only you know which. To make the change the next version of ${origin.name}, publish it as its origin: ${command} --as origin --version ${next}. To make it a package of its own, apart from ${origin.name} from here on, publish it as itself: ${command} --as itself. Your own copy stays ${pkg.name} either way.`;
}

/**
 * The version an as-origin publish goes out at, which is a version of the *origin* and never of the fork.
 * A fork carries `0.1.0-fork.1`, which is a version nobody's update check ranks above the origin's own
 * releases, so it is never a candidate and is never the default. A step is taken from what the target holds
 * for the origin, or, when the target holds none, from the version the fork was taken at.
 */
export function originVersion({ args, pkg, origin, holds, target }) {
  const named = typeof args.version === "string" && args.version.trim() ? args.version.trim() : null;
  const how = typeof args.bump === "string" && args.bump.trim() ? args.bump.trim() : null;
  const base = holds ?? origin.version;
  const next = base ? bumpVersion(base, "patch") : null;
  if (named) {
    if (FORK_VERSION.test(named)) refuse("bad-version", `${named} is a fork's version, and ${origin.name} is not a fork. Give the version ${origin.name} becomes${next ? `, such as ${next}` : ""}.`);
    return named;
  }
  if (how) {
    const stepped = base ? bumpVersion(base, how) : null;
    if (!stepped) refuse("bad-version", `There is no ${how} step to take: ${target.name} holds no version for ${origin.name}, and ${pkg.name} does not record a sound version it was forked from. Give the version to publish instead.`);
    return stepped;
  }
  const from = base ? ` Say the version, or ask for a patch, minor or major step from ${base}, which ${holds ? `${target.name} holds` : `${pkg.name} was forked at`}.` : " Say the version to publish.";
  refuse("bad-version", `Publishing ${pkg.name} as ${origin.name} needs the version ${origin.name} becomes, and ${pkg.version} is a fork's version, never one of the origin's.${from}`);
}
