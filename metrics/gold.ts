/** Split private retrieval gold reproducibly without exposing held-out queries to candidates; SK-012, ADR 0004. */
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { resolvePath } from '../../lib/files/index.ts';
import { fileFrames } from '../../lib/ndjson/file.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import schema from '../../contracts/metrics/schema.json' with { type: 'json' };
import type { GoldPair } from '../../contracts/metrics/types.ts';

export const goldLimits = { rows: 512, frameBytes: 131072, bytes: 4194304 };
export async function gold(root: string, seed: string, schemas: Schemas): Promise<Result<{ visible: GoldPair[]; heldOut: GoldPair[] }>> {
  if (!seed.length) return failure('invalid-args', 'The held-out gold split requires its private seed.');
  const path = await resolvePath(join(root, 'gold/skills.jsonl'), [{ path: root, mode: 'ro', space: 'private-suite' }]); if (!path.ok) return path;
  const check = schemas.compile<GoldPair>({ ...schema, $id: 'thetis://internal/metrics/gold', $ref: '#/$defs/goldPair' });
  const pairs = new Map<string, GoldPair>();
  for await (const row of fileFrames(path.value, goldLimits)) {
    if (!row.ok) return row;
    if (!check(row.value) || pairs.has(row.value.query)) return failure('invalid-args', 'The private retrieval gold contains an invalid or repeated query.');
    pairs.set(row.value.query, row.value);
  }
  if (!pairs.size) return failure('invalid-args', 'The private retrieval gold is empty.');
  const rank = (query: string) => createHmac('sha256', seed).update(query).digest('hex');
  const values = [...pairs.values()].sort((a, b) => rank(a.query).localeCompare(rank(b.query)) || a.query.localeCompare(b.query));
  const split = Math.floor(values.length / 2);
  return { ok: true, value: { visible: values.slice(0, split), heldOut: values.slice(split) } };
}
