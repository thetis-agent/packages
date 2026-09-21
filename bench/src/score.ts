// From observations to a table. Every number is per task, so every comparison is paired: the same task on two
// arms, differenced. Pairing is what cancels the constant floor — the guide, the package list, the fence
// round trip — and it is why two mechanisms of entirely different shape can be put in one column.
import { bytesOf } from "./capture.js";
import type { Observation } from "./runner.js";
import { bootstrap, paired, seedOf, type Interval, type Paired } from "./metrics/stats.js";
import { bitsOverRandom, score as recallScore, type Gold } from "./metrics/recall.js";
import { hitAt1, mrr, ndcg } from "./metrics/ranking.js";
import { routeScore, surfaceTools, type Routing } from "./metrics/routing.js";
import type { Task } from "./suite.js";

/** A metric that every arm can produce, whatever its mechanism. These are the only ones that may be compared. */
export const SHARED = [
  "bytes_system",
  "bytes_tools",
  "bytes_messages",
  "bytes_turn1",
  "bytes_last",
  "prefix_stable",
  "prefix_divergences",
  "tools_n",
  "steps_n",
  "assemble_ms",
  "non_ascii_ratio",
  "recall_reach",
  "recall_direct",
  "precision_direct",
  "f1_direct",
  "completeness",
  "undershoot",
  "overshoot_count",
  "forbidden_hit",
  "fetch_rounds",
  "direct_n",
  "bits_over_random",
  "tool_recall",
  "tool_precision",
  "tool_overshoot_bytes",
  "tool_wasted_bytes",
  "tool_needed_bytes",
  "tool_forbidden_hit",
  "route_recall",
  "route_precision",
  "route_f1",
  "routed_nothing",
  "surface_tools",
  "cost_usd",
  "prompt_tokens",
  "completion_tokens",
  "cache_read_ratio",
  "bytes_per_token",
] as const;

/** Meaningful only for a mechanism that orders things. Reported under its own arm, never in a shared column. */
export const PER_ARM = ["ndcg", "hit_at_1", "mrr", "select_at_1"] as const;

export type MetricName = (typeof SHARED)[number] | (typeof PER_ARM)[number];

/**
 * The capability the model asked for first. A tool that takes an id names it directly; a tool that takes a
 * query does not, so a search call is not a pick and is left out rather than guessed at.
 */
function pickOf(calls: readonly { name: string; args: Record<string, unknown> }[]): string | undefined {
  for (const call of calls) {
    const id = call.args.id ?? call.args.capability ?? call.args.skill;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

const goldOf = (task: Task): Gold => ({
  required: new Set(task.required ?? []),
  helpful: new Set(task.helpful ?? []),
  forbidden: new Set(task.forbidden ?? []),
});

/** Every number this observation supports. A metric the arm cannot produce is absent, not zero. */
export function metricsOf(observation: Observation, task: Task, registrySize: number, routing?: Routing): Partial<Record<MetricName, number>> {
  const b = bytesOf(observation.rounds);
  const available = observation.reconciled.available;
  const gold = goldOf(task);
  const r = recallScore(available, gold);
  const hits = [...gold.required].filter((id) => available.direct.has(id) || available.catalogue.has(id) || available.search.has(id)).length;
  const attached = available.direct.size + available.catalogue.size + available.search.size;

  const out: Partial<Record<MetricName, number>> = {
    bytes_system: b.system,
    bytes_tools: b.tools,
    bytes_messages: b.messages,
    bytes_turn1: b.turn1,
    bytes_last: b.last,
    prefix_stable: b.prefixStable,
    prefix_divergences: b.divergences,
    tools_n: observation.rounds[0]?.toolNames.length ?? 0,
    steps_n: observation.steps.length,
    assemble_ms: observation.assembleMs,
    non_ascii_ratio: b.nonAsciiRatio,
    direct_n: available.direct.size,
  };

  // Recall only means something when the suite says what the task needed.
  if (gold.required.size) {
    out.recall_reach = r.recall_reach;
    out.recall_direct = r.recall_direct;
    // Null where the mechanism put nothing directly in the prompt: a rate over an empty set is not zero, and
    // recording it as zero would make an arm that injects nothing look like an arm that injects only wrongly.
    if (r.precision_direct !== null) out.precision_direct = r.precision_direct;
    if (r.f1_direct !== null) out.f1_direct = r.f1_direct;
    out.completeness = r.completeness;
    out.undershoot = r.undershoot;
    out.overshoot_count = r.overshoot_count;
    out.fetch_rounds = r.fetch_rounds;
    const bits = bitsOverRandom(hits, gold.required.size, attached, registrySize);
    if (bits !== null) out.bits_over_random = bits;
  }
  if (gold.forbidden.size) out.forbidden_hit = r.forbidden_hit;

  // Tools are a capability set too, and today's harness attaches all of them to every task. Recall is
  // therefore one by construction; what varies per task, and what a tool-attention package would improve,
  // is how much of that was needed.
  const wantedTools = new Set(task.tools ?? []);
  if (wantedTools.size) {
    const offered = new Set(observation.rounds[0]?.toolIds ?? []);
    const sizes = observation.rounds[0]?.toolBytes ?? {};
    const hit = [...wantedTools].filter((id) => offered.has(id));
    let needed = 0;
    let wasted = 0;
    for (const id of offered) (wantedTools.has(id) ? (needed += sizes[id] ?? 0) : (wasted += sizes[id] ?? 0));
    out.tool_recall = hit.length / wantedTools.size;
    out.tool_precision = offered.size ? hit.length / offered.size : 0;
    out.tool_needed_bytes = needed;
    out.tool_wasted_bytes = wasted;
    if (needed > 0) out.tool_overshoot_bytes = wasted / needed;
    if (task.forbidden?.length) out.tool_forbidden_hit = task.forbidden.some((id) => offered.has(id)) ? 1 : 0;
  }

  // Tool groups: which corpus groups had a tool schema in the first round, proved by the canary in the tool
  // segment. Scored against the groups the task names, with the always-on groups left out of precision, since
  // every arm carries those for every task and counting them would punish all arms alike.
  if (Array.isArray(task.groups) && routing) {
    const routed = new Set(observation.rounds[0]?.canaryTools ?? []);
    out.surface_tools = surfaceTools(routed, routing.toolCount);
    const r = routeScore(routed, new Set(task.groups), routing.alwaysOn);
    if (r) Object.assign(out, r);
  }

  // With a model in the loop: when the mechanism asks the model to choose, did it choose correctly? This is
  // a per-arm number, not a shared one. A mechanism that pins what it thinks is right never asks, so it has
  // no selection to score, and scoring its absence as a failure would compare two different acts.
  const firstPick = pickOf(observation.toolCalls);
  if (gold.required.size && firstPick !== undefined) out.select_at_1 = gold.required.has(firstPick) ? 1 : 0;

  const usage = observation.usage;
  if (usage.prompt_tokens) {
    out.prompt_tokens = usage.prompt_tokens;
    out.completion_tokens = usage.completion_tokens ?? 0;
    if (usage.cost !== undefined) out.cost_usd = usage.cost;
    if (usage.cache_read_tokens !== undefined) out.cache_read_ratio = usage.cache_read_tokens / usage.prompt_tokens;
    // Bytes are the unit everywhere else because there is no tokeniser here. This is the only place the two
    // meet, so it is recorded: an arm whose ratio drifts from the floor's spends its bytes differently.
    if (b.total > 0) out.bytes_per_token = b.total / usage.prompt_tokens;
  }

  if (available.ranked?.length && gold.required.size) {
    out.ndcg = ndcg(gold.required, available.ranked);
    out.hit_at_1 = hitAt1(gold.required, available.ranked);
    out.mrr = mrr(gold.required, available.ranked);
  }
  return out;
}

export interface ArmScore {
  arm: string;
  tasks: number;
  /** The arm's own level, with an interval over tasks. */
  absolute: Partial<Record<MetricName, Interval>>;
  /** Against the floor, paired by task. Absent for the floor itself. */
  delta: Partial<Record<MetricName, Paired>>;
  /** Numbers only this arm's mechanism can produce. Never placed beside another arm's. */
  perArm: Partial<Record<MetricName, Interval>>;
  conformance: { adapterLies: string[]; adapterModest: string[]; offeredUnverified: string[]; errors: string[] };
}

type ByTask = Map<string, Partial<Record<MetricName, number>>>;

function collect(observations: readonly Observation[], tasks: readonly Task[], registrySize: number, routing?: Routing): Map<string, ByTask> {
  const byTask = new Map<string, Task>(tasks.map((t) => [t.id, t]));
  const out = new Map<string, ByTask>();
  for (const o of observations) {
    const task = byTask.get(o.task);
    if (!task) continue;
    const arm = out.get(o.arm) ?? new Map();
    // Repeated attempts of a deterministic probe are the same row; the last one wins.
    arm.set(o.task, metricsOf(o, task, registrySize, routing));
    out.set(o.arm, arm);
  }
  return out;
}

/** Task ids both arms produced a value for. Comparing anything else would not be a pair. */
function common(a: ByTask, b: ByTask, metric: MetricName): string[] {
  return [...a.keys()].filter((id) => a.get(id)?.[metric] !== undefined && b.get(id)?.[metric] !== undefined).sort();
}

export function summarise(
  observations: readonly Observation[],
  tasks: readonly Task[],
  opts: { floor: string; suite: string; registrySize?: number; routing?: Routing },
): ArmScore[] {
  const byArm = collect(observations, tasks, opts.registrySize ?? 0, opts.routing);
  const floor = byArm.get(opts.floor);
  const out: ArmScore[] = [];

  for (const [arm, values] of byArm) {
    const absolute: Partial<Record<MetricName, Interval>> = {};
    const perArm: Partial<Record<MetricName, Interval>> = {};
    const delta: Partial<Record<MetricName, Paired>> = {};

    for (const metric of [...SHARED, ...PER_ARM] as MetricName[]) {
      const present = [...values.values()].map((m) => m[metric]).filter((v): v is number => v !== undefined);
      if (!present.length) continue;
      const interval = bootstrap(present, seedOf([opts.suite, arm, metric]));
      if ((PER_ARM as readonly string[]).includes(metric)) perArm[metric] = interval;
      else absolute[metric] = interval;
      if (!floor || arm === opts.floor) continue;
      const ids = common(values, floor, metric);
      if (!ids.length) continue;
      delta[metric] = paired(
        ids.map((id) => values.get(id)?.[metric] as number),
        ids.map((id) => floor.get(id)?.[metric] as number),
        seedOf([opts.suite, arm, metric, "delta"]),
      );
    }

    const armObs = observations.filter((o) => o.arm === arm);
    out.push({
      arm,
      tasks: values.size,
      absolute,
      delta,
      perArm,
      conformance: {
        adapterLies: [...new Set(armObs.flatMap((o) => o.reconciled.adapterLies))].sort(),
        adapterModest: [...new Set(armObs.flatMap((o) => o.reconciled.adapterModest))].sort(),
        offeredUnverified: [...new Set(armObs.flatMap((o) => o.reconciled.offeredUnverified))].sort(),
        errors: [...new Set(armObs.flatMap((o) => o.errors))],
      },
    });
  }
  return out.sort((a, b) => (a.arm === opts.floor ? -1 : b.arm === opts.floor ? 1 : a.arm.localeCompare(b.arm)));
}

/**
 * Latency is committed as a ratio against the floor measured in the same process, never as absolute
 * milliseconds: the fence opens lazily, the sandbox mode differs per machine, and step timing includes
 * serialising the context across the fence. The ratio survives all three; the absolute number does not.
 */
export function latencyRatio(scores: readonly ArmScore[], floor: string): Record<string, number | null> {
  const base = scores.find((s) => s.arm === floor)?.absolute.assemble_ms?.mean;
  const out: Record<string, number | null> = {};
  for (const s of scores) {
    const mine = s.absolute.assemble_ms?.mean;
    out[s.arm] = base && base > 0 && mine !== undefined ? Math.round((mine / base) * 100) / 100 : null;
  }
  return out;
}
