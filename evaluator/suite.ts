/** Canonicalize private suite assets before admitting their deterministic checks; EV-002, ADR 0004. */
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Root } from '../../lib/files/index.ts';
import { resolvePath } from '../../lib/files/index.ts';
import { readBounded } from '../../lib/files/read-bounded.ts';
import { snapshot } from '../../lib/snapshots/index.ts';
import { failure, isObject } from '../../lib/result/index.ts';
import type { Result } from '../../lib/result/index.ts';
import { validators } from '../../lib/evaluation/index.ts';
import type { Schemas } from '../../lib/schema/index.ts';
import type { Task } from '../../lib/evaluation/index.ts';
export const suiteLimits = { tasks: 256, taskBytes: 131072, bytes: 4194304 };

async function task(root: string, id: string, schemas: Schemas): Promise<Result<{ task: Task; bytes: number }>> {
  const roots: Root[] = [{ path: root, mode: 'ro', space: 'private-suite' }];
  const card = await resolvePath(join(root, 'tasks', id, 'task.json'), roots); if (!card.ok) return card;
  const bytes = await readBounded(card.value, suiteLimits.taskBytes); if (!bytes.ok) return bytes;
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value)); }
  catch { return failure('invalid-args', 'The private task is not valid UTF-8 JSON.'); }
  if (!isObject(raw)) return failure('invalid-args', 'The private task is not an object.');
  const value: unknown = { ...raw, fixture: raw['fixture'] ?? 'fixture' }; const check = validators(schemas).task;
  if (!check(value) || value.id !== id) return failure('invalid-args', 'The private task does not match its id or schema.');
  const directory = join(root, 'tasks', id);
  const checks = await resolvePath(join(directory, value.checks), roots); if (!checks.ok) return checks;
  const fixture = await resolvePath(join(directory, value.fixture), roots); if (!fixture.ok) return fixture;
  return { ok: true, value: { task: { ...value, checks: checks.value, fixture: fixture.value }, bytes: bytes.value.length } };
}

export async function suite(root: string, schemas: Schemas): Promise<Result<{ identity: string; tasks: Task[] }>> {
  const entries: string[] = []; const tasks: Task[] = []; let bytes = 0;
  try {
    for await (const entry of await opendir(join(root, 'tasks'))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return failure('outside-roots', 'A private task must be a plain directory.');
      entries.push(entry.name); if (entries.length > suiteLimits.tasks) return failure('budget', 'The private suite exceeds its task limit.');
    }
    for (const id of entries.sort()) {
      const loaded = await task(root, id, schemas); if (!loaded.ok) return loaded;
      bytes += loaded.value.bytes; if (bytes > suiteLimits.bytes) return failure('budget', 'The private suite exceeds its input byte limit.');
      tasks.push(loaded.value.task);
    }
    const identity = await snapshot(root); if (!identity.ok) return identity;
    return { ok: true, value: { identity: identity.value, tasks } };
  } catch { return failure('io', 'The private suite could not be read.'); }
}
