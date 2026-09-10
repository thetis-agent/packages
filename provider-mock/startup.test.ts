/** Pin deployment configuration and bounded scripts without replacing the engine; PR-014. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from './startup.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { providerFixture, collect, request, stream } from '@/test/provider-fixture.ts';

await test('PR-014 deployment settings script reasoning, fragmented calls and terminal usage deterministically', async () => {
  const schemas = new Schemas(); await schemas.load();
  const settings = { scripts: [[{ type: 'delta.reasoning', opaque: { retained: true } }, { type: 'delta.tool_call', callId: 'c', name: 'tool', args: '{' }, { type: 'delta.tool_call', callId: 'c', args: '}' }, { type: 'usage', counters: { cost: 0.002 } }, { type: 'stop', reason: 'tool_calls' }]] };
  const runs = [];
  for (let index = 0; index < 2; index += 1) {
    const f = providerFixture(); const configured = await configure(settings, f.authority, f.budgets, schemas); assert.ok(configured.ok);
    const rows = await collect(configured.value.run(stream(request()), f.token, new AbortController().signal));
    assert.equal(rows.at(-1)?.type, 'stop'); assert.deepEqual(f.reports[0]?.counters, { cost: 0.002 }); runs.push(rows);
  }
  assert.deepEqual(runs[0], runs[1]);
});

await test('PR-014 deployment settings refuse malformed, over-count and over-byte scripts before serving', async () => {
  const schemas = new Schemas(); await schemas.load(); const f = providerFixture();
  for (const settings of [{ scripts: [[{ type: 'unknown' }]] }, { scripts: [[{ type: 'usage', counters: { cost: -1 } }]] }, { scriptEvents: 1, scripts: [[{ type: 'delta.text', text: 'a' }], [{ type: 'delta.text', text: 'b' }]] }, { scriptBytes: 2, scripts: [[{ type: 'delta.text', text: 'large' }]] }]) {
    const result = await configure(settings, f.authority, f.budgets, schemas); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
  }
});

await test('PR-010 personal adapters authenticate but do not charge deployment budgets', async () => {
  const schemas = new Schemas(); await schemas.load(); const f = providerFixture([], 0);
  const configured = await configure({}, f.authority, f.budgets, schemas, 'person'); assert.ok(configured.ok);
  const rows = await collect(configured.value.run(stream(request()), f.token, new AbortController().signal));
  assert.equal(rows.at(-1)?.type, 'stop'); assert.equal(f.reports.length, 1);
  const refused = await collect(configured.value.run(stream(request()), 'unknown', new AbortController().signal));
  assert.ok(refused.some(row => row.type === 'error' && row.code === 'auth'));
});

await test('PR-014 a reviewed model id survives mock deployment and real-provider preparation unchanged', async () => {
  const schemas = new Schemas(); await schemas.load(); const f = providerFixture();
  const configured = await configure({ modelId: 'reviewed/model' }, f.authority, f.budgets, schemas); assert.ok(configured.ok);
  const described = await configured.value.describe(); assert.ok(described.ok); assert.equal(described.value.models[0]?.id, 'reviewed/model');
  const rows = await collect(configured.value.run(stream(request('prefix', { model: 'reviewed/model' })), f.token, new AbortController().signal));
  assert.ok(rows.some(row => row.type === 'start' && row.model === 'reviewed/model')); assert.equal(rows.at(-1)?.type, 'stop');
  const refused = await collect(configured.value.run(stream(request()), f.token, new AbortController().signal));
  assert.ok(refused.some(row => row.type === 'error' && row.code === 'provider'));
  for (const modelId of ['', 'x'.repeat(257)]) assert.ok(!(await configure({ modelId }, f.authority, f.budgets, schemas)).ok);
});
