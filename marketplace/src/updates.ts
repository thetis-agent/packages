// What is behind, and what catches it up. Nothing here updates anything: an installation follows its pins
// until a person says otherwise, so this only ever answers a question. There are three kinds of behind. A
// package installed from a registry is behind when its pin is older than the index, and an install catches
// it up. A package shipped with the service is a link into the checkout, so a version bump on disk is
// installed the moment it lands; what the workspace is still running is the version its fence read when it
// opened, and a reload of that workspace is what catches it up. And a fork is behind the package it was
// copied from, which goes on being fixed while the fork does not; going back to it is what catches that up.
//
// `ahead` is the same question asked the other way round, for the person who maintains the packages rather
// than the person who installs them: what is newer here than the version the registry holds, and what has
// never been published at all. See `ahead` at the foot of this file.
import { splitSource } from "@thetis/lib/pkg-fs";
import type { ForkStatus } from "@thetis/contracts";
import type { IndexedPackage, MarketplaceIndex } from "./index-file.js";
import { compareVersions, isNewer } from "./versions.js";

/** The part of an installed package this needs: its name, its version, where it came from, and what is running. */
export interface InstalledRef {
  name: string;
  version?: string;
  source?: { kind: string; ref: string };
  /** The version this workspace's fence read when it opened. Absent when no fence is open. */
  loadedVersion?: string;
  /** Set on a fork: the package it was copied from, and how that package stands now. */
  fork?: ForkStatus;
}

export interface Behind {
  name: string;
  /** The commit this installation is pinned to, or the version the fence loaded. */
  installed: string;
  /** The commit the index now holds for it, or the version on disk. */
  available: string;
  /** The version string a person recognises: the index's for an install, the one on disk for a reload. */
  version: string;
  registry: string;
  /** Pass this to install to move to it. Empty for a reload or an un-fork, neither of which installs anything. */
  source: string;
  /** What catches this one up: an install of the newer pin, a reload of the workspace, or going back to the fork's origin. */
  apply: "install" | "reload" | "unfork";
  /** Un-fork rows only: the package this one was forked from, and whether it is a copy of that package with nothing changed. */
  origin?: string;
  identical?: boolean;
}

const pinOf = (ref: string | undefined): string | undefined => (ref ? splitSource(ref).ref : undefined);

/** Does this index entry describe the same package, from the same repository, as this installed record? */
function matches(record: InstalledRef, entry: IndexedPackage): boolean {
  if (record.name !== entry.name || record.source?.kind !== "git") return false;
  return splitSource(record.source.ref).url === splitSource(entry.source).url;
}

/** The install case: a pin the index has moved past. Undefined when this record tracks no registry, or is on the indexed commit. */
function behindIndex(record: InstalledRef, index: MarketplaceIndex | undefined): Behind | undefined {
  const pin = pinOf(record.source?.ref);
  if (!pin || !index) return undefined;
  const entry = index.packages.find((e) => matches(record, e));
  if (!entry || !entry.commit || entry.commit === pin) return undefined;
  return { name: record.name, installed: pin, available: entry.commit, version: entry.version, registry: entry.registry, source: entry.source, apply: "install" };
}

/** The reload case: the fence is running a different version than the one on disk. The index is optional, because a package shipped with the service is behind its own disk whether or not a registry lists it. */
function behindDisk(record: InstalledRef, index: MarketplaceIndex | undefined): Behind | undefined {
  const { loadedVersion, version } = record;
  if (!loadedVersion || !version || loadedVersion === version) return undefined;
  const entry = index?.packages.find((e) => e.name === record.name);
  return { name: record.name, installed: loadedVersion, available: version, version, registry: entry?.registry ?? "on disk", source: entry?.source ?? "", apply: "reload" };
}

/**
 * The fork case: a copy that is missing what its origin has gained since. There are two ways to be behind
 * here and a person should be told about both. The origin has a version the copy was not made from -- the
 * copy is one release behind and counting. Or the copy is byte for byte the origin, which is worse in the
 * way that matters: it is carrying no change at all, so every fix past and future is being paid for and
 * none of it is being had, and no version number anywhere shows it.
 *
 * A fork whose origin is not on disk any more is left alone. So is a fork that differs from an origin it
 * was made from the current version of: that one is a fork doing its job, which is not a thing to nag about.
 */
function behindFork(record: InstalledRef): Behind | undefined {
  const fork = record.fork;
  if (!fork?.shipped) return undefined;
  if (fork.shipped === fork.version && !fork.identical) return undefined;
  return { name: record.name, installed: fork.version, available: fork.shipped, version: fork.shipped, registry: fork.name, source: "", apply: "unfork", origin: fork.name, ...(fork.identical ? { identical: true } : {}) };
}

/**
 * Installed packages that are behind, each with what applies the change. A package installed from a registry
 * whose pin is older than the index is `install`; one whose fence loaded a different version than the one on
 * disk is `reload`. A package can only be one of the two, and the install case wins when both hold, because
 * an install brings the new pin and reopens. A package the index no longer carries is left alone: a registry
 * that dropped a package is not the same thing as a package being out of date.
 *
 * The fork case comes last, because a fork that is also behind its own registry has a plain update to take
 * first, and being told two things at once about one package is being told neither.
 */
export function behind(installed: readonly InstalledRef[], index: MarketplaceIndex | undefined): Behind[] {
  const out: Behind[] = [];
  for (const record of installed) {
    const one = behindIndex(record, index) ?? behindDisk(record, index) ?? behindFork(record);
    if (one) out.push(one);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A short, stable way to show a commit to a person. */
export const shortCommit = (commit: string): string => commit.slice(0, 7);

/**
 * The other direction. `behind` asks what this installation is missing; `ahead` asks what it is holding that
 * nobody else can have yet. The person who maintains a package is also running it: their checkout is the
 * source their own fences load, so the moment they bump a version on disk their installation is on the new
 * one while the registry every other installation reads still holds the old. Nothing recorded anywhere says
 * so, and there is nothing new to record -- the index already carries each package's published version and
 * the installed record already carries the local one, so this is a comparison and nothing more.
 */
export interface Ahead {
  name: string;
  /** The version installed here. */
  version: string;
  /** The version the index holds for it. Empty on `unpublished`, where no registry holds it at all. */
  published: string;
  /** The registry holding the older version. Empty on `unpublished`. */
  registry: string;
  /** `ahead`: a registry has it, at an older version. `unpublished`: no registry lists this package. */
  state: "ahead" | "unpublished";
}

/**
 * The index entry for a name, across every registry, taking the newest version when more than one holds it.
 * Matched on the name alone, unlike `behind`, which matches on the repository too: `behind` is about a pin
 * moving along one registry, while the question here is whether *anyone* has this package yet, and a package
 * published to a second registry is published.
 */
function publishedEntry(name: string, index: MarketplaceIndex): IndexedPackage | undefined {
  let best: IndexedPackage | undefined;
  for (const entry of index.packages) {
    if (entry.name !== name) continue;
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry;
  }
  return best;
}

/**
 * Installed packages whose version is newer than the version the index holds, and packages no registry holds
 * at all. Unpublished work, in the two forms it takes.
 *
 * Three things are deliberately left out.
 *
 * A fork is one. A fork is by construction a package no registry holds, so every fork would be listed as
 * unpublished for ever, and a fork already has a row of its own saying it is a fork and what it was copied
 * from. Two rows about one package is two rows nobody reads, and the fork row is the truer of the two: a
 * fork is not work waiting to be shared, it is a private copy, which is the whole point of it.
 *
 * A package installed from a git registry that the index no longer carries is another, for the same reason
 * `behind` leaves it alone: a registry that dropped a package is not a statement about this copy.
 *
 * And having no index at all is the third. Without a mirror there is no published version to compare
 * against, so "nothing is published" would be a claim about the registries made without reading one.
 */
export function ahead(installed: readonly InstalledRef[], index: MarketplaceIndex | undefined): Ahead[] {
  if (!index) return [];
  const out: Ahead[] = [];
  for (const record of installed) {
    if (!record.version || record.fork) continue;
    const entry = publishedEntry(record.name, index);
    if (!entry) {
      if (record.source?.kind === "git") continue;
      out.push({ name: record.name, version: record.version, published: "", registry: "", state: "unpublished" });
      continue;
    }
    if (isNewer(record.version, entry.version)) out.push({ name: record.name, version: record.version, published: entry.version, registry: entry.registry, state: "ahead" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
