// What the provider saw, and what the packages said they did. The two are reconciled here, and where they
// disagree the provider wins: a package's claim about its own behaviour is evidence, never the measurement.
import { existsSync, readFileSync } from "node:fs";
import type { BenchClaim } from "@thetis/contracts";
import type { Available } from "./metrics/recall.js";

export interface CaptureLine {
  run: string;
  arm: string;
  task: string;
  attempt: number;
  round: number;
  model: string;
  at: number;
  bytes: { system: number; tools: number; messages: number; hints: number; total: number };
  sha: { system: string; tools: string; prefix: string };
  prefixBytes: number;
  toolNames: string[];
  toolIds: string[];
  toolBytes: Record<string, number>;
  canaryDirect: string[];
  idsMentioned: string[];
  idsReturned: string[];
  canaryReturned: string[];
  nonAsciiRatio: number;
  hintKeys: string[];
}

export const addressOf = (l: { run: string; arm: string; task: string; attempt: number }): string =>
  `${l.run}/${l.arm}/${l.task}/${l.attempt}`;

export function readCapture(path: string): CaptureLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CaptureLine)
    .filter((line) => Array.isArray(line.canaryDirect) && !!line.bytes);
}

export function byAddress(lines: readonly CaptureLine[]): Map<string, CaptureLine[]> {
  const out = new Map<string, CaptureLine[]>();
  for (const line of lines) {
    const key = addressOf(line);
    const at = out.get(key) ?? [];
    at.push(line);
    out.set(key, at);
  }
  for (const rounds of out.values()) rounds.sort((a, b) => a.round - b.round);
  return out;
}

export interface Reconciled {
  available: Available;
  /** Claimed as directly injected with no canary in the prompt to show for it. A conformance failure. */
  adapterLies: string[];
  /** Injected but not claimed. Not a failure — a package may simply not bother — but worth seeing. */
  adapterModest: string[];
  /** Claimed as reachable with nothing in the prompt naming it. Excluded from every score. */
  offeredUnverified: string[];
}

/**
 * Turn one turn's evidence into the set arithmetic the metrics take. `direct` is whatever left a canary in
 * the prompt, whoever claimed it. `catalogue` and `search` are ids the prompt or a tool schema names but
 * whose body is not there yet; which of the two it is depends on how the package says it can be reached.
 */
export function reconcile(rounds: readonly CaptureLine[], claims: Readonly<Record<string, BenchClaim>>): Reconciled {
  const canaried = new Set<string>();
  const mentioned = new Set<string>();
  const returned = new Set<string>();
  for (const round of rounds) {
    for (const id of round.canaryDirect) canaried.add(id);
    for (const id of round.idsMentioned) mentioned.add(id);
    for (const id of round.idsReturned ?? []) returned.add(id);
    for (const id of round.canaryReturned ?? []) canaried.add(id);
  }

  const claimedDirect = new Set<string>();
  const catalogue = new Set<string>();
  const search = new Set<string>();
  const offeredUnverified: string[] = [];
  let ranked: string[] | undefined;

  for (const claim of Object.values(claims)) {
    for (const id of claim.direct) claimedDirect.add(id);
    for (const id of claim.offered) {
      if (canaried.has(id)) continue; // already in hand; it costs no round trip
      // A catalogue proves reach by naming the capability in the prompt. A search tool proves it by
      // returning it when asked. Neither is taken on the package's word.
      if (mentioned.has(id)) {
        catalogue.add(id);
        continue;
      }
      if (returned.has(id)) {
        search.add(id);
        continue;
      }
      offeredUnverified.push(id);
    }
    if (claim.ranked?.length && !ranked) ranked = claim.ranked;
  }

  return {
    available: { direct: canaried, catalogue, search, ranked },
    adapterLies: [...claimedDirect].filter((id) => !canaried.has(id)).sort(),
    adapterModest: [...canaried].filter((id) => !claimedDirect.has(id)).sort(),
    offeredUnverified: offeredUnverified.sort(),
  };
}

/** Byte totals summed over the turns of one task, and the segments kept apart. */
export function bytesOf(rounds: readonly CaptureLine[]): {
  system: number;
  tools: number;
  messages: number;
  total: number;
  turn1: number;
  last: number;
  prefixStable: number;
  divergences: number;
  nonAsciiRatio: number;
} {
  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  if (!first || !last) {
    return { system: 0, tools: 0, messages: 0, total: 0, turn1: 0, last: 0, prefixStable: 0, divergences: 0, nonAsciiRatio: 0 };
  }
  // The first round has no predecessor, so its prefix is wholly new; stability is only meaningful after it.
  const later = rounds.slice(1);
  const stable = later.length ? later.reduce((n, r) => n + r.prefixBytes / Math.max(1, r.bytes.system + r.bytes.tools), 0) / later.length : 1;
  let divergences = 0;
  for (let i = 1; i < rounds.length; i++) if (rounds[i]?.sha.prefix !== rounds[i - 1]?.sha.prefix) divergences++;
  return {
    system: first.bytes.system,
    tools: first.bytes.tools,
    messages: last.bytes.messages,
    total: first.bytes.total,
    turn1: first.bytes.total,
    last: last.bytes.total,
    prefixStable: Math.round(stable * 1000) / 1000,
    divergences,
    nonAsciiRatio: first.nonAsciiRatio,
  };
}
