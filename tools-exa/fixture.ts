/** Replace only the external HTTP edge in offline Exa tests; EXA-001–008. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { toolIdentity } from '@/test/tool-identity.ts';
import type { CallRequest } from '@/contracts/turn-events/types.ts';
import { configure } from './execute.ts';
import type { Fetcher } from './http.ts';
export function request(name = 'exa_search', args: unknown = { query: 'search' }): CallRequest {
  return { id: 'call', name, args, mode: { readOnly: false, deny: [] }, roots: [], deadlineMs: 100, budget: { resultBytes: 32768 } };
}
export async function fixture(fetcher: Fetcher, settings: Record<string, unknown> = {}, cost = 10) {
  const root = await mkdtemp('/tmp/exa-test-'); const schemas = new Schemas(); const time = new ManualClock(); const identity = toolIdentity(cost);
  const configured = await configure(settings, 'fixture-exa-secret', schemas, time, identity.authority, identity.budgets, root, fetcher); assert.ok(configured.ok, JSON.stringify(configured));
  return { ...identity, root, schemas, time, tools: configured.value, call: (call: CallRequest, signal = new AbortController().signal) => configured.value.call(call, identity.token, signal),
    async close() { await rm(root, { recursive: true, force: true }); } };
}
