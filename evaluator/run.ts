/** Keep private task data at the evaluator while ordinary inputs cross the candidate boundary; EV-001–004. */
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import { seed, seedIdentity } from '@/lib/evaluation/index.ts';
import type { Plan, Row, Submission, Task } from '@/lib/evaluation/index.ts';
import { mutate } from './mutate.ts';

import type { TurnJob, Outcome, CheckJob } from '@/lib/evaluation/types.ts';
export type { TurnJob, Outcome, CheckJob } from '@/lib/evaluation/types.ts';
export interface Execution {
  turn(job: TurnJob): Promise<Result<Outcome>>;
  score(job: CheckJob): Promise<Result<{ pass: boolean }>>;
  release(snapshot: string): Promise<Result<void>>;
}
export interface Case { task: Task; kind: Row['kind'] }
export interface Configuration { plan: Plan; secret: string; cases: readonly Case[]; stoplist: ReadonlySet<string>; coreChanged: boolean; providerChanged?: boolean; previousDefaultScorer?: string; ablations?: boolean }
export const evaluationLimits = { rows: 8192, cases: 256, active: 1 };

interface Selection { withheld: TurnJob['withheld']; ablation?: Row['ablation']; required_by?: string[] }
function variants(task: Task, enabled: boolean): Selection[] {
  const baseline = { withheld: { tools: [], skills: [] } };
  if (!enabled) return [baseline];
  return [baseline, ...task.gold.tools.map((item): Selection => task.required.includes(item)
    ? { withheld: { tools: [], skills: [] }, ablation: { kind: 'tool', item }, required_by: [task.id] }
    : { withheld: { tools: [item], skills: [] }, ablation: { kind: 'tool', item } }),
  ...task.gold.skills.map((item): Selection => ({ withheld: { tools: [], skills: [item] }, ablation: { kind: 'skill', item } }))];
}

function prepare(configuration: Configuration): Result<void, 'invalid-args' | 'budget'> {
  const { plan, cases, secret, coreChanged } = configuration;
  if (plan.identities.seed !== seedIdentity(secret)) return failure('invalid-args', 'The evaluation seed identity does not match its configured secret.');
  if ((coreChanged || configuration.providerChanged) && plan.runs !== 5) return failure('invalid-args', 'A changed loop or provider requires five paired runs.');
  if (coreChanged && (plan.runs !== 5 || plan.scorers.length !== 2 || !configuration.previousDefaultScorer || !plan.scorers.includes(configuration.previousDefaultScorer))) return failure('invalid-args', 'A changed loop requires five runs and both reviewed scorers.');
  if (!plan.scorers.includes(plan.identities.scorer)) return failure('invalid-args', 'The evaluation does not include its identified scorer.');
  if (cases.length > evaluationLimits.cases) return failure('budget', 'The evaluation exceeds its case limit.');
  const expected = new Set([...plan.tasks.map(id => `task:${id}`), ...plan.regressions.map(id => `regression:${id}`)]);
  let rows = 0;
  for (const entry of cases) {
    if (!expected.delete(`${entry.kind}:${entry.task.id}`)) return failure('invalid-args', 'The evaluation contains a duplicate or unplanned task.');
    rows += variants(entry.task, configuration.ablations ?? false).length * 2 * plan.runs * plan.scorers.length;
  }
  if (expected.size) return failure('invalid-args', 'The evaluation is missing a planned task.');
  return rows <= evaluationLimits.rows ? { ok: true, value: undefined } : failure('budget', 'The evaluation exceeds its row limit.');
}

async function score(execution: Execution, job: TurnJob, checks: CheckJob, row: Pick<Row, 'task' | 'run' | 'arm' | 'scorer' | 'kind' | 'ablation' | 'required_by'>): Promise<Result<Row>> {
  const outcome = await execution.turn(job); if (!outcome.ok) return outcome;
  const scored = await execution.score({ ...checks, snapshot: outcome.value.snapshot });
  const released = await execution.release(outcome.value.snapshot); if (!released.ok) return released;
  if (!scored.ok) return scored;
  return { ok: true, value: { ...row, pass: scored.value.pass, iterations: outcome.value.iterations, cost: outcome.value.cost, counters: outcome.value.counters, dropped: outcome.value.dropped, end: outcome.value.end } };
}

export class Evaluator {
  #active = false;
  async run(configuration: Configuration, execution: Execution): Promise<Result<Submission>> {
    if (this.#active) return failure('budget', 'The evaluation active-run limit is exhausted.');
    const ready = prepare(configuration); if (!ready.ok) return ready;
    this.#active = true;
    try { return await this.#run(configuration, execution); } finally { this.#active = false; }
  }

  async #run(configuration: Configuration, execution: Execution): Promise<Result<Submission>> {
    const { plan } = configuration; const rows: Row[] = [];
    for (const entry of [...configuration.cases].sort((a, b) => a.task.id.localeCompare(b.task.id))) for (let run = 0; run < plan.runs; run++) {
      const variant = mutate(entry.task, configuration.secret, run, configuration.stoplist); if (!variant.ok) return variant;
      for (const selection of variants(entry.task, configuration.ablations ?? false)) for (const scorer of plan.scorers) for (const arm of ['default', 'candidate']) {
        if (arm !== 'default' && arm !== 'candidate') throw new Error('The evaluation arm is invalid.');
        const job: TurnJob = { task: entry.task.id, pins: arm === 'default' ? plan.identities.baseline : plan.identities.candidate, input: { text: variant.value.request, attachments: [] }, fixture: entry.task.fixture, mutation: variant.value.replacements, modelSeed: Number.parseInt(seed(configuration.secret, entry.task.id, run).slice(0, 8), 16), provider: plan.identities.provider, model: plan.identities.model, budget: entry.task.budget, withheld: selection.withheld };
        const row = await score(execution, job, { scorer, checks: entry.task.checks, snapshot: '', replacements: variant.value.replacements }, { task: entry.task.id, run, arm, scorer, kind: entry.kind, ...(selection.ablation ? { ablation: selection.ablation } : {}), ...(selection.required_by ? { required_by: selection.required_by } : {}) });
        if (!row.ok) return row; rows.push(row.value);
      }
    }
    return { ok: true, value: { identities: structuredClone(plan.identities), rows } };
  }
}
