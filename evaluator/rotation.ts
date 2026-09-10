/** Draft privately from authorized inputs and retire only measured easy tasks; ADR 0004 §2, evaluator Rotation. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePath } from '@/lib/files/index.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import type { Schemas } from '@/lib/schema/index.ts';
import type { Stage } from '@/lib/events/stages.ts';
import schema from '@/contracts/evaluator/schema.json' with { type: 'json' };
import type { Draft, RotationInput, TaskHistory } from '@/contracts/evaluator/types.ts';

export const rotationLimits = { inputs: 256, bytes: 4194304, history: 6144, retirementPassRate: 0.95, hold: [60, 80] };
function monthIndex(month: string): number {
  const [year, ordinal] = month.split('-').map(Number);
  return (year ?? 0) * 12 + (ordinal ?? 0) - 1;
}

export function rotation(month: string, history: readonly TaskHistory[]): Result<{ retire: string[]; adjustment: 'harder' | 'easier' | 'hold' }> {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month) || history.length > rotationLimits.history) return failure('invalid-args', 'The rotation month or history exceeds its contract.');
  const latest = monthIndex(month); const pairs = new Map<string, Map<number, TaskHistory>>(); let passed = 0; let total = 0;
  for (const row of history) {
    const index = monthIndex(row.month); const rows = pairs.get(row.task) ?? new Map<number, TaskHistory>();
    if (row.passed > row.total || rows.has(index)) return failure('invalid-args', 'The rotation history repeats a month or exceeds its task total.');
    rows.set(index, row); pairs.set(row.task, rows);
    if (index === latest) { passed += row.passed; total += row.total; }
  }
  const retire = [...pairs].filter(([, rows]) => [latest - 1, latest].every(index => {
    const row = rows.get(index); return row !== undefined && row.passed / row.total >= rotationLimits.retirementPassRate;
  })).map(([id]) => id).sort();
  const rate = total ? passed / total * 100 : undefined;
  return { ok: true, value: { retire, adjustment: rate === undefined ? 'hold' : rate < 60 ? 'easier' : rate > 80 ? 'harder' : 'hold' } };
}

async function draft(root: string, value: Draft): Promise<Result<void>> {
  const path = join(root, 'drafts', `${value.id}.json`); const bytes = `${JSON.stringify(value)}\n`;
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return { ok: true, value: undefined }; }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') return failure('io', 'The private task draft could not be stored.');
    const verified = await resolvePath(path, [{ path: root, mode: 'rw', space: 'private-suite' }]); if (!verified.ok) return verified;
    const existing = await readBounded(verified.value, 131072); if (!existing.ok) return existing;
    return existing.value.toString('utf8') === bytes ? { ok: true, value: undefined } : failure('hash-mismatch', 'The existing private draft has different content.');
  }
}

export class Rotation {
  readonly #root: string; readonly #schemas: Schemas;
  constructor(root: string, schemas: Schemas) { this.#root = root; this.#schemas = schemas; }
  async drafts(month: string, inputs: readonly RotationInput[]): Promise<Result<string[]>> {
    this.#schemas.compile(schema); const check = this.#schemas.compile<Draft>({ $ref: `${schema.$id}#/$defs/draft` });
    if (inputs.length > rotationLimits.inputs || inputs.reduce((n, item) => n + Buffer.byteLength(item.text), 0) > rotationLimits.bytes) return failure('budget', 'The rotation input queue is full.');
    const values = inputs.map(input => ({ id: `draft-${createHash('sha256').update(JSON.stringify([month, input.conversation, input.text])).digest('hex')}`, month, source: input.conversation, request: input.text })).sort((a, b) => a.id.localeCompare(b.id));
    if (!values.every(value => check(value))) return failure('invalid-args', 'A private task draft violates its schema.');
    try {
      await mkdir(join(this.#root, 'drafts'), { recursive: true, mode: 0o700 });
      const path = await resolvePath(join(this.#root, 'drafts'), [{ path: this.#root, mode: 'rw', space: 'private-suite' }]); if (!path.ok) return path;
      for (const value of values) { const saved = await draft(this.#root, value); if (!saved.ok) return saved; }
      return { ok: true, value: [...new Set(values.map(value => value.id))] };
    } catch { return failure('io', 'The private rotation store could not be opened.'); }
  }

  async retire(month: string, history: readonly TaskHistory[]): Promise<Result<string[]>> {
    this.#schemas.compile(schema); const check = this.#schemas.compile<TaskHistory>({ $ref: `${schema.$id}#/$defs/taskHistory` });
    if (!history.every(row => check(row))) return failure('invalid-args', 'The task retirement history violates its schema.');
    const plan = rotation(month, history); if (!plan.ok) return plan;
    try {
      await mkdir(join(this.#root, 'retired'), { recursive: true, mode: 0o700 });
      const retired = await resolvePath(join(this.#root, 'retired'), [{ path: this.#root, mode: 'rw', space: 'private-suite' }]); if (!retired.ok) return retired;
      for (const id of plan.value.retire) {
        if (!/^[a-zA-Z0-9_-]+$/u.test(id)) return failure('outside-roots', 'The retired task identity is not a directory name.');
        const source = await resolvePath(join(this.#root, 'tasks', id), [{ path: this.#root, mode: 'rw', space: 'private-suite' }]); if (!source.ok) return source;
        const target = join(retired.value, id);
        try { await lstat(target); return failure('collision', 'The retired task already exists.'); }
        catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return failure('io', 'The retired task path could not be inspected.'); }
        await rename(source.value, target);
      }
      return { ok: true, value: plan.value.retire };
    } catch { return failure('io', 'The reviewed task could not be retired.'); }
  }
}

export function rotationStage(store: Rotation, month: string, inputs: () => Promise<Result<RotationInput[]>>, observed: (result: Result<string[]>) => Promise<void>): Stage {
  return { source: 'evaluator@1.0.0', async init() {
    const rows = await inputs(); await observed(rows.ok ? await store.drafts(month, rows.value) : rows);
  } };
}
