/** Run only with explicit authorization and a key on fd 3; excluded from offline tests. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { descriptor } from '@/lib/files/descriptor.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import { Budgets } from '@/lib/provider/index.ts';
import { BudgetCheckpoint } from '@/lib/provider/checkpoint.ts';
import { toolIdentity } from '@/test/tool-identity.ts';
import { configure } from './execute.ts';
import { request } from './fixture.ts';
const key = await descriptor(3, Number(process.argv[2])); assert.ok(key.ok);
const root = await mkdtemp('/tmp/live-exa-');
try {
  const schemas = new Schemas(); const identity = toolIdentity(0.05);
  const state = await BudgetCheckpoint.open(`${root}/budget.json`, schemas); assert.ok(state.ok);
  const tools = await configure({}, key.value.toString('utf8'), schemas, clock, identity.authority,
    new Budgets({ name: 'live-exa', cost: 0.05, requests: 3, windowMs: 86400000 }, () => 0, 4096, state.value), root); assert.ok(tools.ok);
  const results: Record<string, unknown>[] = [];
  for (const call of [request('exa_search', { query: 'Exa API search documentation', numResults: 2 }), request('exa_contents', { urls: ['https://exa.ai/docs/reference/pricing'] }), request('exa_answer', { query: 'What is the capital of France?' })]) {
    const result = await tools.value.call({ ...call, deadlineMs: 30000 }, identity.token, new AbortController().signal);
    assert.ok(result.ok, JSON.stringify(result)); results.push({ tool: call.name, ...result.data });
    assert.equal(JSON.stringify(result).includes(key.value.toString('utf8')), false);
  }
  const stored = await readFile(`${root}/budget.json`, 'utf8');
  assert.equal(stored.includes(key.value.toString('utf8')), false); assert.equal(stored.includes(identity.token), false);
  process.stdout.write(`${JSON.stringify({ measurement: 'live-exa', maximumCost: 0.05, results, secretInState: false })}\n`);
} finally { key.value.fill(0); await rm(root, { recursive: true, force: true }); }
