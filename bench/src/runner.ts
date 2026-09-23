// Driving the arms. One session per (arm, task, attempt), addressed through `call.model` so the query text
// reaches the harness exactly as the suite wrote it. Everything observable is collected: the turn events for
// step timing, the provider's capture for byte and canary accounting, and the probe's harness record for
// what each package claimed.
import type { BenchClaim, TurnEvent } from "@thetis/runtime/contracts";
import type { Arena } from "./arena.js";
import { addressOf, byAddress, readCapture, reconcile, type CaptureLine, type Reconciled } from "./capture.js";
import type { SuiteDef, Task } from "./suite.js";
import { BenchHarnessSchema } from "@thetis/runtime/schemas";
import { parseSchema } from "@thetis/runtime/lib/validation";

const PROBE_KEY = "@thetis/bench-probe";
const BENCH_KEY = "@thetis/bench";

export interface StepTiming {
  id: string;
  package: string;
  phase?: string;
  ms: number;
}

export interface Observation {
  arm: string;
  task: string;
  attempt: number;
  address: string;
  rounds: CaptureLine[];
  steps: StepTiming[];
  claims: Record<string, BenchClaim>;
  reconciled: Reconciled;
  /** Wall clock for the whole turn sequence. Committed only as a ratio; see the report writer. */
  ms: number;
  /** Steps the harness ran that were not the built-in call: the assembly cost. */
  assembleMs: number;
  errors: string[];
  text: string;
  /** Summed over the turn. Empty unless a real provider answered. */
  usage: Record<string, number>;
  /** What the model reached for, in order. This is the record `select_at_1` is scored from. */
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

export interface RunOptions {
  runId: string;
  /**
   * Turns driven and discarded before measuring, so the cold fence and the first-turn seeding are not counted
   * as assembly time. Set to 0 when a real model is answering: the warm-up would be billed, and a probe that
   * pays a model to say nothing is measuring the wrong thing.
   */
  warmup?: number;
  onProgress?: (line: string) => void;
}

async function drive(arena: Arena, user: string, session: string, text: string, model: string): Promise<{ events: TurnEvent[]; text: string }> {
  const events: TurnEvent[] = [];
  let reply = "";
  for await (const event of arena.kernel.sessions.send(user, session, text, { model })) {
    events.push(event);
    if (event.type === "text") reply += event.delta;
  }
  return { events, text: reply };
}

/** The `execute` phase is where the harness sends the call and runs what the model asks for; everything else is assembly. */
const isExecute = (step: { phase?: string }): boolean => step.phase === "execute";

function timingsOf(events: readonly TurnEvent[]): StepTiming[] {
  return events
    .filter((e): e is Extract<TurnEvent, { type: "step.end" }> => e.type === "step.end")
    .map((e) => ({ id: e.step.id ?? `${e.step.package}#${e.step.export}`, package: e.step.package, phase: e.step.phase, ms: e.ms }));
}

/**
 * Run one task against one arm. A warm-up turn is driven and discarded first: the fence opens lazily inside
 * the first request and the userspace is seeded inside the first send, so turn one measures the sandbox
 * rather than the harness.
 */
export async function runTask(arena: Arena, armId: string, task: Task, attempt: number, opts: RunOptions): Promise<Observation> {
  const user = arena.userOf(armId);
  const address = { run: opts.runId, arm: armId, task: task.id, attempt };
  const model = `bench/${opts.runId}/${armId}/${task.id}/${attempt}`;

  if ((opts.warmup ?? 1) > 0) {
    const warm = arena.kernel.sessions.create(user);
    await drive(arena, user, warm.id, "warm up", `bench/${opts.runId}/${armId}/warmup/0`);
  }

  const session = arena.kernel.sessions.create(user);
  const events: TurnEvent[] = [];
  let text = "";
  const started = Date.now();
  for (let turn = 0; turn < (task.turns ?? 1); turn++) {
    const out = await drive(arena, user, session.id, task.query, model);
    events.push(...out.events);
    text = out.text;
  }
  const ms = Date.now() - started;

  const steps = timingsOf(events);
  const record = arena.kernel.sessions.inspect(user, session.id);
  const raw = record.harness[BENCH_KEY];
  const harness = parseSchema(BenchHarnessSchema, raw === undefined ? {} : raw, `bench harness ${session.id}`);
  const claims = harness.claims ?? {};
  const rounds = byAddress(readCapture(arena.capture)).get(addressOf(address)) ?? [];

  const usage: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "usage") continue;
    for (const [key, value] of Object.entries(event.usage)) usage[key] = (usage[key] ?? 0) + value;
  }

  return {
    ...address,
    address: addressOf(address),
    usage,
    toolCalls: events.filter((e) => e.type === "tool.call").map((e) => ({ name: e.call.name, args: e.call.args })),
    rounds,
    steps,
    claims,
    reconciled: reconcile(rounds, claims),
    ms,
    assembleMs: steps.filter((s) => !isExecute(s)).reduce((n, s) => n + s.ms, 0),
    errors: events.filter((e) => e.type === "error").map((e) => e.message),
    text,
  };
}

/** Every arm over every task. Sequential: the point is comparable numbers, not a fast wall clock. */
export async function runSuite(arena: Arena, suite: SuiteDef, tasks: readonly Task[], opts: RunOptions): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const arm of arena.arms) {
    for (const task of tasks) {
      for (let attempt = 0; attempt < (suite.runs ?? 1); attempt++) {
        opts.onProgress?.(`${arm.id} ${task.id} #${attempt}`);
        out.push(await runTask(arena, arm.id, task, attempt, opts));
      }
    }
  }
  return out;
}

/** Did the probe's step actually run? If it did not, the bench phase was not configured and nothing is valid. */
export function probeRan(observation: Observation): boolean {
  return observation.steps.some((s) => s.package === PROBE_KEY);
}
