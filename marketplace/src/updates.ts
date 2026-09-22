// What is behind, and what catches it up. Nothing here updates anything: an installation follows its pins
// until a person says otherwise, so this only ever answers a question. There are three kinds of behind. A
// package installed from a registry is behind when its pin is older than the index, and an install catches
// it up. A package shipped with the service is a link into the checkout, so a version bump on disk is
// installed the moment it lands; what the workspace is still running is the version its fence read when it
// opened, and a reload of that workspace is what catches it up. And a fork is behind the package it was
// copied from, which goes on being fixed while the fork does not; going back to it is what catches that up.
import { splitSource } from "@thetis/lib/pkg-fs";
import type { ForkStatus } from "@thetis/contracts";
import type { IndexedPackage, MarketplaceIndex } from "./index-file.js";

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
