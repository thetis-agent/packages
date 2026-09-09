/** Pin monthly drafting and two-month retirement without wall clocks or model judgments; ADR 0004 §2. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Rotation, rotation, rotationStage } from './rotation.ts';
import { Schemas } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/result/index.ts';
await test('ADR-0004 monthly stage init produces identical private drafts and never invents checks or promotes them', async () => {
  const root = await mkdtemp('/tmp/rotation-'); const schemas = new Schemas(); await schemas.load();
  try {
    const store = new Rotation(root, schemas); const rows: Result<string[]>[] = [];
    const stage = rotationStage(store, '2026-09', () => Promise.resolve({ ok: true, value: [{ conversation: 'ordinary', text: 'Help Alice.' }] }), result => { rows.push(result); return Promise.resolve(); });
    await stage.init?.(() => undefined); await stage.init?.(() => undefined);
    assert.deepEqual(rows[0], rows[1]); const names = await readdir(join(root, 'drafts')); assert.equal(names.length, 1);
    const name = names[0]; assert.ok(name);
    const bytes = await readFile(join(root, 'drafts', name), 'utf8'); assert.match(bytes, /Help Alice\./u); assert.equal(bytes.includes('checks'), false);
    assert.deepEqual(await readdir(root), ['drafts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('ADR-0004 retirement requires consecutive months at ninety-five percent and reports the hold-band adjustment', async () => {
  const rows = [{ task: 'easy', month: '2026-08', passed: 19, total: 20 }, { task: 'easy', month: '2026-09', passed: 20, total: 20 }];
  assert.deepEqual(rotation('2026-09', rows), { ok: true, value: { retire: ['easy'], adjustment: 'harder' } });
  assert.deepEqual(rotation('2026-09', [{ ...rows[0], task: 'easy', month: '2026-07', passed: 19, total: 20 }, rows[1] ?? rows[0]].filter(row => row !== undefined)), { ok: true, value: { retire: [], adjustment: 'harder' } });
  assert.equal(rotation('2026-09', [...rows, ...rows]).ok, false);
  const root = await mkdtemp('/tmp/retirement-'); const schemas = new Schemas(); await schemas.load();
  try {
    await mkdir(join(root, 'tasks/easy'), { recursive: true }); await writeFile(join(root, 'tasks/easy/task.json'), '{}');
    assert.deepEqual(await new Rotation(root, schemas).retire('2026-09', rows), { ok: true, value: ['easy'] });
    assert.deepEqual(await readdir(join(root, 'tasks')), []); assert.deepEqual(await readdir(join(root, 'retired')), ['easy']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
