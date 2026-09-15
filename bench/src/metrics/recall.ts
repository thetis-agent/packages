// What a mechanism made available for one task, scored against the gold set. Every number here is defined on
// sets of stable capability ids, so a catalogue, a three-level cache and an inject-everything loader are all
// scored by the same arithmetic even though they share no data shape.

export interface Available {
  /** Body in the prompt now. Costs no round trip. */
  direct: Set<string>;
  /** Name and description in the prompt; the body is one tool call away. */
  catalogue: Set<string>;
  /** Reachable only by calling the mechanism's own search tool, which also ranks. */
  search: Set<string>;
  /** Ordered, best first. Only a ranking mechanism has one. */
  ranked?: string[];
}

export interface Gold {
  required: Set<string>;
  helpful: Set<string>;
  forbidden: Set<string>;
}

export interface RecallScore {
  /** Anything the model could get to, at any cost. */
  recall_reach: number;
  recall_direct: number;
  /** Null when the mechanism put nothing directly in the prompt: a rate over an empty set is not zero. */
  precision_direct: number | null;
  f1_direct: number | null;
  /** 1 when every required id was reachable. An agent needs all of them, not most. */
  completeness: number;
  undershoot: number;
  overshoot_count: number;
  forbidden_hit: number;
  /** Round trips the mechanism costs before every required id is in hand. */
  fetch_rounds: number;
}

export function reachOf(a: Available): Set<string> {
  return new Set([...a.direct, ...a.catalogue, ...a.search]);
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const id of a) if (b.has(id)) n++;
  return n;
}

export function score(available: Available, gold: Gold): RecallScore {
  const reach = reachOf(available);
  const need = gold.required;
  const hitReach = overlap(reach, need);
  const hitDirect = overlap(available.direct, need);
  const recall_reach = need.size ? hitReach / need.size : 1;
  const recall_direct = need.size ? hitDirect / need.size : 1;
  const precision_direct = available.direct.size ? hitDirect / available.direct.size : null;
  const f1_direct =
    precision_direct === null || precision_direct + recall_direct === 0
      ? null
      : (2 * precision_direct * recall_direct) / (precision_direct + recall_direct);
  // A round trip is paid once per tier that holds a required id, not once per id: one `load_skill` call can
  // fetch several, and the mechanism decides how many at a time.
  const needsCatalogue = overlap(available.catalogue, need) > 0;
  const needsSearch = overlap(available.search, need) > 0;
  return {
    recall_reach,
    recall_direct,
    precision_direct,
    f1_direct,
    completeness: hitReach === need.size ? 1 : 0,
    undershoot: 1 - recall_reach,
    overshoot_count: need.size ? (available.direct.size - hitDirect) / need.size : available.direct.size,
    forbidden_hit: overlap(reach, gold.forbidden) > 0 ? 1 : 0,
    fetch_rounds: (needsCatalogue ? 1 : 0) + (needsSearch ? 1 : 0),
  };
}

/** Bytes wasted on directly injected capabilities the task did not need, per byte that it did. */
export function overshootBytes(direct: ReadonlySet<string>, need: ReadonlySet<string>, bytesOf: (id: string) => number): number | null {
  let wanted = 0;
  let wasted = 0;
  for (const id of direct) (need.has(id) ? (wanted += bytesOf(id)) : (wasted += bytesOf(id)));
  return wanted === 0 ? (wasted === 0 ? 0 : null) : wasted / wanted;
}

/**
 * Bits over random: how many doublings better than a blind draw of the same depth this arm did. Chance
 * corrected against the registry size, so a bench author cannot make an arm look worse by growing the corpus,
 * and self-pruning, so no hand-tuned depth penalty is needed.
 */
export function bitsOverRandom(hits: number, need: number, attached: number, registry: number): number | null {
  if (!need || !attached || !registry) return null;
  const observed = hits / need;
  const chance = Math.min(1, attached / registry);
  if (observed <= 0 || chance <= 0) return null;
  return Math.log2(observed / chance);
}
