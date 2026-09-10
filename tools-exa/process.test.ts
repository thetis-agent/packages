/** Load the actual registered package with real kernel grants and a fake key; EXA-009, TS-008. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidService } from '@/test/paid-service.ts';
import { request } from './fixture.ts';
import { spawn } from './index.ts';
import type { Spawn } from '@/lib/package-loader/types.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { validator } from '@/lib/package-loader/index.ts';
import { load } from '@/lib/package-loader/load.ts';
import { SpillSink } from '@/lib/spill/index.ts';
await test('EXA-009 the registered API process checks service grants before budget and never logs its key', async () => {
  const schemas = new Schemas(); await schemas.load(); const declared: unknown = spawn[0];
  assert.ok((await validator<Spawn>(schemas, 'spawn'))(declared));
  const f = await paidService('tools-exa', declared, { name: 'exa-key', value: 'offline-test-secret' }, 0);
  try {
    const allowed = f.client('alice'); const denied = f.client('bob', false);
    assert.equal((await allowed.client.call(f.endpoint, request())).error?.code, 'budget');
    assert.equal((await denied.client.call(f.endpoint, request())).error?.code, 'tool');
    const stage = await load({ ...f.entry, state: `${f.root}/stage` }, { entries: [f.entry], excluded: [], profile: {}, provided: { 'service/tool-service.exa': { endpoint: f.endpoint } }, spaces: [], runtime: {
      root: '/tmp', providerSocket: '/unused', person: 'alice', model: 'unused', provider: 'unused', token: allowed.token, space: '/tmp', system: [], roots: [], mode: { readOnly: false, deny: [] }
    } }, schemas, () => undefined);
    assert.ok(stage.ok); assert.ok(stage.value.offer); assert.ok(stage.value.call); const sink = new SpillSink('/tmp', 'call');
    try {
      const offered = await stage.value.offer({ mode: { readOnly: true, deny: [] } }); assert.ok(Array.isArray(offered)); assert.equal(offered.length, 4);
      const result = await stage.value.call(request(), sink, new AbortController().signal);
      assert.ok(schemas.validator('turn-events', 'callAnswer')(result)); assert.deepEqual(result, { id: 'call', ok: false, error: { code: 'budget', message: 'paid-test would be exceeded.' } });
    } finally { await stage.value.shutdown?.(); await sink.abort(); }
    const rows = await f.rows(); assert.equal(rows.includes('offline-test-secret'), false); assert.equal(rows.includes(allowed.token), false); assert.equal(rows.includes('usage.report'), false);
  } finally { await f.close(); }
});
