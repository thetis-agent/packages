// Tool-group routing, scored on sets of corpus ids. `routed` is what the first round proved attached (a canary
// in the tool segment); `expected` is what the task names; `alwaysOn` is what every arm carries for every task
// and is therefore left out of precision. The numbers are the predecessor's: recall and precision over the
// routable groups, their F1, and whether the routing produced nothing at all for a query that needed something.
import type { CapabilityRecord } from "@thetis/contracts";

export interface Routing {
  alwaysOn: Set<string>;
  /** How many tools each corpus group carries, so a surface can be counted in tools rather than groups. */
  toolCount: Map<string, number>;
}

export interface RouteScore {
  route_recall: number;
  route_precision: number;
  route_f1: number;
  /** 1 when the task needed a routable group and none was admitted. */
  routed_nothing: number;
}

/** What the scorer needs from a corpus of tool groups. The fields are the corpus's own, beside the capability shape. */
export function routingOf(records: readonly CapabilityRecord[]): Routing {
  const alwaysOn = new Set<string>();
  const toolCount = new Map<string, number>();
  for (const r of records) {
    const extra = r as CapabilityRecord & { alwaysOn?: boolean; tools?: unknown[] };
    if (extra.alwaysOn === true) alwaysOn.add(r.id);
    toolCount.set(r.id, Array.isArray(extra.tools) ? extra.tools.length : 0);
  }
  return { alwaysOn, toolCount };
}

const without = (ids: ReadonlySet<string>, drop: ReadonlySet<string>): Set<string> => new Set([...ids].filter((id) => !drop.has(id)));

/** Null when the task named no routable group: a control task has no recall to score. */
export function routeScore(routed: ReadonlySet<string>, expected: ReadonlySet<string>, alwaysOn: ReadonlySet<string>): RouteScore | null {
  const need = without(expected, alwaysOn);
  if (!need.size) return null;
  const got = without(routed, alwaysOn);
  let hits = 0;
  for (const id of need) if (got.has(id)) hits++;
  const route_recall = hits / need.size;
  const route_precision = got.size ? hits / got.size : 0;
  const route_f1 = route_precision + route_recall > 0 ? (2 * route_precision * route_recall) / (route_precision + route_recall) : 0;
  return { route_recall, route_precision, route_f1, routed_nothing: got.size ? 0 : 1 };
}

/** How many corpus tools the routed groups put in the call. */
export function surfaceTools(routed: ReadonlySet<string>, toolCount: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const id of routed) n += toolCount.get(id) ?? 0;
  return n;
}
