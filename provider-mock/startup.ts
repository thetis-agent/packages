/** Validate scripted deployment settings before accepting callers; PR-014, ADR 0016 §1. */
import { readFile } from 'node:fs/promises';
import { configured } from '../../lib/schema/settings.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import type { Authority, Budgets, Provider } from '../../lib/provider/index.ts';
import type { Contract as Configuration } from './types.ts';
import { MockProvider } from './index.ts';

export async function configure(input: Record<string, unknown>, authority: Authority, budgets: Budgets, schemas: Schemas, scope: 'person' | 'deployment' = 'deployment'): Promise<Result<Provider>> {
  const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(schema)) throw new Error('The committed mock settings schema is invalid.');
  const values = configured(schema, input);
  if (!schemas.compile<Configuration>(schema)(values)) return failure('invalid-args', 'The mock settings violate their schema.');
  if (values.scripts.reduce((count, script) => count + script.length, 0) > values.scriptEvents || Buffer.byteLength(JSON.stringify(values.scripts)) > values.scriptBytes) return failure('invalid-args', 'The mock scripts exceed their configured event or byte limit.');
  return { ok: true, value: new MockProvider(values.scripts, authority, budgets, values, scope) };
}
