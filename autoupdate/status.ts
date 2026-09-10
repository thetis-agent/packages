/** Read the host updater's status file without writing, applying or undoing anything; ADR 0048, ADR 0029. */
import { readFile, stat } from 'node:fs/promises';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result, Validator } from '@/lib/schema/index.ts';
import type { StatusFile, Update } from './types.ts';
import validate from './schema-validators.cjs';

/** Build the file validator once; the package's own committed schema, never host input. */
export async function validator(schemas: Schemas): Promise<Result<Validator<StatusFile>, 'io'>> {
  try {
    const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
    if (!isObject(schema)) throw new Error('invalid');
    return { ok: true, value: schemas.precompiled<StatusFile>(schema, validate.digest, validate) };
  } catch { return failure('io', 'The committed update status schema is invalid.'); }
}

function shaped(file: StatusFile): Update {
  return {
    known: true, current: file.current, verified: file.verified, checkedAt: file.checkedAt, policy: file.policy,
    ...(file.available === undefined ? {} : { available: file.available }),
    ...(file.stagedAt === undefined ? {} : { stagedAt: file.stagedAt }),
  };
}

/** A missing status file means the host timer has not written one yet; that is a value, not an error. */
export async function read(path: string, statusBytes: number, check: Validator<StatusFile>): Promise<Result<Update, 'budget' | 'invalid-args' | 'io'>> {
  try { await stat(path); } catch { return { ok: true, value: { known: false } }; }
  const bounded = await readBounded(path, statusBytes); if (!bounded.ok) return bounded;
  let parsed: unknown;
  try { parsed = JSON.parse(bounded.value.toString('utf8')); } catch { return failure('invalid-args', 'The update status file is not valid JSON.'); }
  if (!check(parsed)) return failure('invalid-args', 'The update status file does not match its contract.');
  return { ok: true, value: shaped(parsed) };
}
