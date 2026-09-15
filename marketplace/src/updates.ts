// What is behind the index, and what to install to catch it up. Nothing here updates anything: an
// installation follows its pins until a person says otherwise, so this only ever answers a question.
import { splitSource } from "@thetis/lib/pkg-fs";
import type { IndexedPackage, MarketplaceIndex } from "./index-file.js";

/** The part of an installed package this needs: its name and where it came from. */
export interface InstalledRef {
  name: string;
  version?: string;
  source?: { kind: string; ref: string };
}

export interface Behind {
  name: string;
  /** The commit this installation is pinned to. */
  installed: string;
  /** The commit the index now holds for it. */
  available: string;
  /** The version string the index reports, which is what a person recognises. */
  version: string;
  registry: string;
  /** Pass this to install to move to it. */
  source: string;
}

const pinOf = (ref: string | undefined): string | undefined => (ref ? splitSource(ref).ref : undefined);

/** Does this index entry describe the same package, from the same repository, as this installed record? */
function matches(record: InstalledRef, entry: IndexedPackage): boolean {
  if (record.name !== entry.name || record.source?.kind !== "git") return false;
  return splitSource(record.source.ref).url === splitSource(entry.source).url;
}

/**
 * Installed packages whose pin is not what the index holds. A package installed from a local path or shipped
 * with the service has no pin to compare and is never listed; neither is one the index no longer carries,
 * because a registry that dropped a package is not the same thing as a package being out of date.
 */
export function behind(installed: readonly InstalledRef[], index: MarketplaceIndex | undefined): Behind[] {
  if (!index) return [];
  const out: Behind[] = [];
  for (const record of installed) {
    const pin = pinOf(record.source?.ref);
    if (!pin) continue;
    const entry = index.packages.find((e) => matches(record, e));
    if (!entry || !entry.commit || entry.commit === pin) continue;
    out.push({ name: record.name, installed: pin, available: entry.commit, version: entry.version, registry: entry.registry, source: entry.source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A short, stable way to show a commit to a person. */
export const shortCommit = (commit: string): string => commit.slice(0, 7);
