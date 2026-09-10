/** Read cost policy supplied to the registered process, never from tool arguments; EXA-006. */
import { readFile } from 'node:fs/promises';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Startup } from '@/lib/provider/types.ts';
export async function startup(value: unknown, schemas: Schemas): Promise<Result<Startup>> {
  const raw: unknown = JSON.parse(await readFile(new URL(import.meta.resolve('@/lib/provider/schema.json')), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed tool budget policy schema is invalid.');
  return schemas.definition<Startup>(raw, 'startup')(value) ? { ok: true, value } : failure('invalid-args', 'The tool service budget policy is invalid.');
}
