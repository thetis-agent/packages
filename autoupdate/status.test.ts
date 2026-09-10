/** Cover every boundary of the host updater's status file without ever writing one back; ADR 0048. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { validator, read } from './status.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoupdate-'));
  const schemas = new Schemas(); await schemas.load();
  const check = await validator(schemas); assert.ok(check.ok);
  return { root, check: check.value, path: join(root, 'status.json'), async close() { await rm(root, { recursive: true, force: true }); } };
}

await test('a well-formed status file reports the available version, staged time and policy', async () => {
  const f = await fixture();
  try {
    const file = { version: 1, current: 'v1.2.0', available: 'v1.3.0', verified: true, checkedAt: 1000, stagedAt: 1001, policy: 'fixes' };
    await writeFile(f.path, JSON.stringify(file));
    const result = await read(f.path, 65536, f.check);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value, { known: true, current: 'v1.2.0', available: 'v1.3.0', verified: true, checkedAt: 1000, stagedAt: 1001, policy: 'fixes' });
  } finally { await f.close(); }
});

await test('a missing status file is a value, not an error: the host timer may not have run yet', async () => {
  const f = await fixture();
  try {
    const result = await read(f.path, 65536, f.check);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value, { known: false });
  } finally { await f.close(); }
});

await test('a status file over its byte budget is refused, bounded, without being parsed', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify({ version: 1, current: 'v1', verified: true, checkedAt: 0, policy: 'none', pad: 'x'.repeat(100) }));
    const result = await read(f.path, 16, f.check);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'budget');
  } finally { await f.close(); }
});

await test('malformed JSON in the status file is refused with one sentence', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, '{not json');
    const result = await read(f.path, 65536, f.check);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
    assert.equal(result.error.message.split('.').filter(part => part.trim()).length, 1);
  } finally { await f.close(); }
});

await test('a status file that fails its contract is refused rather than trusted', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify({ version: 1, current: 'v1', verified: 'yes', checkedAt: 0, policy: 'none' }));
    const result = await read(f.path, 65536, f.check);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
  } finally { await f.close(); }
});

await test('an available version reported by the file grants no path to fetch, stage or apply it here', async () => {
  const module: Record<string, unknown> = await import('./status.ts');
  const server: Record<string, unknown> = await import('./server.ts');
  const forbidden = /apply|undo|install|stage|fetch|download/iu;
  for (const [name, value] of [...Object.entries(module), ...Object.entries(server)]) {
    assert.ok(!forbidden.test(name), `${name} suggests an apply/undo path this package must not have`);
    assert.ok(typeof value !== 'function' || !forbidden.test(value.name), `${name} suggests an apply/undo path this package must not have`);
  }
});
