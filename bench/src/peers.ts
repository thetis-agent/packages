// Who a package is compared against. A peer is a package that opted into the same suite and imports the same
// corpus; anything else is not a comparison, it is two numbers printed near each other.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchDecl, Manifest, ThetisField } from "@thetis/contracts";

export interface Participant {
  name: string;
  version: string;
  dir: string;
  bench: BenchDecl;
  /** The whole declaration, so validation sees the steps that make the bench exports callable. */
  thetis: ThetisField;
  peerGroup: string;
}

export const peerGroupOf = (bench: BenchDecl): string => bench.peerGroup ?? bench.suites[0] ?? "";

export function readParticipant(dir: string): Participant | null {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const bench = manifest.thetis?.bench;
    if (!bench?.suites?.length) return null;
    return { name: manifest.name, version: manifest.version, dir: resolve(dir), bench, thetis: manifest.thetis, peerGroup: peerGroupOf(bench) };
  } catch {
    return null;
  }
}

/** Every package under these roots that opted into the suite. Roots are directories of package directories. */
export function participants(roots: readonly string[], suite: string): Participant[] {
  const out: Participant[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const found = readParticipant(join(root, entry));
      if (!found || seen.has(found.name)) continue;
      if (!found.bench.suites.includes(suite)) continue;
      seen.add(found.name);
      out.push(found);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PeerCheck {
  peers: string[];
  /** Packages in the same group that could not be compared, and why. */
  omitted: { name: string; reason: string }[];
}

/**
 * A peer's numbers belong in this table only if they came from the same corpus and the same suite. Printing
 * two incomparable numbers side by side is the worst thing this system could do, so anything that does not
 * match is omitted with its reason stated rather than quietly included.
 */
export function comparable(self: Participant, others: readonly Participant[], suite: string, corpus: string | undefined): PeerCheck {
  const peers: string[] = [];
  const omitted: { name: string; reason: string }[] = [];
  for (const other of others) {
    if (other.name === self.name) continue;
    if (other.peerGroup !== self.peerGroup) continue;
    if (!other.bench.suites.includes(suite)) {
      omitted.push({ name: other.name, reason: `does not run ${suite}` });
      continue;
    }
    if ((other.bench.corpus ?? undefined) !== corpus) {
      omitted.push({ name: other.name, reason: `imports ${other.bench.corpus ?? "no corpus"}, not ${corpus ?? "no corpus"}` });
      continue;
    }
    peers.push(other.name);
  }
  return { peers: peers.sort(), omitted: omitted.sort((a, b) => a.name.localeCompare(b.name)) };
}
