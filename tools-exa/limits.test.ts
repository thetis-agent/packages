/** Refuse unbounded spend and protect persisted run ownership and secrets; EXA-006–008. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, request } from './fixture.ts';
import { Owners } from './owners.ts';
import { ApiSchemas } from './schema.ts';
import { configure } from './execute.ts';

await test('EXA-006 a denied cost reservation sends no HTTP request', async () => {
  const f = await fixture(() => { assert.fail('Budget refusal must precede HTTP.'); }, {}, 0.006);
  try { assert.equal((await f.call(request())).error?.code, 'budget'); assert.equal(f.reports.length, 0); } finally { await f.close(); }
});
await test('EXA-007 response limits and malformed JSON produce bounded errors', async () => {
  for (const response of ['{broken', 'x'.repeat(1025), JSON.stringify({ results: [{}] })]) {
    const f = await fixture(() => Promise.resolve(new Response(response)), { responseBytes: 1024 });
    try { const result = await f.call(request()); assert.equal(result.ok, false); assert.ok(['io', 'budget'].includes(result.error?.code ?? '')); }
    finally { await f.close(); }
  }
});
await test('EXA-007 success content and metadata cannot disclose the authentication key', async () => {
  const f = await fixture(() => Promise.resolve(Response.json({ requestId: 'fixture-exa-secret', results: [{ url: 'https://example.com', text: 'echo fixture-exa-secret' }] })));
  try { const result = await f.call(request()); assert.ok(result.ok); assert.equal(JSON.stringify(result).includes('fixture-exa-secret'), false); }
  finally { await f.close(); }
});
await test('EXA-007 deadlines abort HTTP and release the bounded pool', async () => {
  const entered = Promise.withResolvers<undefined>(); let calls = 0;
  const f = await fixture((_url, options) => {
    calls++;
    if (calls > 1) return Promise.resolve(Response.json({ results: [] }));
    return new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true }); entered.resolve(undefined); });
  }, { concurrency: 1 });
  try {
    const pending = f.call(request()); await entered.promise;
    assert.equal((await f.call(request())).error?.code, 'budget'); assert.equal(calls, 1);
    f.time.advance(100); assert.equal((await pending).error?.code, 'deadline');
    assert.equal((await f.call(request())).ok, true); assert.equal(calls, 2);
  } finally { await f.close(); }
});
await test('EXA-008 agent runs retain person ownership through restart and reject foreign follow-ups', async () => {
  const paths: string[] = [];
  const fetcher = (url: string) => { paths.push(url); return Promise.resolve(Response.json({ id: 'run-1', status: url.endsWith('/cancel') ? 'cancelled' : 'running' })); };
  const f = await fixture(fetcher);
  try {
    const started = await f.call(request('exa_agent_start', { query: 'research', effort: 'low' })); assert.ok(started.ok); assert.equal(started.data?.['runId'], 'run-1');
    const ledger = await readFile(`${f.root}/exa-runs.json`, 'utf8'); assert.equal(ledger.includes('fixture-exa-secret'), false); assert.equal(ledger.includes(f.token), false);
    const bob = f.identity.issue({ id: 'bob', person: 'bob', scope: 'person', target: 'bob', generation: 1, services: [] }); assert.ok(bob.ok);
    for (const call of [request('exa_agent_get', { id: 'run-1' }), request('exa_agent_start', { query: 'follow-up', previousRunId: 'run-1' })]) {
      assert.equal((await f.tools.call(call, bob.value, new AbortController().signal)).ok, false);
    }
    assert.equal(paths.length, 1);
    const reopened = await configure({}, 'fixture-exa-secret', f.schemas, f.time, f.authority, f.budgets, f.root, fetcher); assert.ok(reopened.ok);
    assert.ok((await reopened.value.call(request('exa_agent_get', { id: 'run-1' }), f.token, new AbortController().signal)).ok);
    assert.equal((await f.call(request('exa_agent_stop', { id: 'run-1' }))).error?.code, 'invalid-args');
    assert.ok((await f.call(request('exa_agent_cancel', { id: 'run-1' }))).ok); assert.equal(paths.at(-1), 'https://api.exa.ai/agent/runs/run-1/cancel');
  } finally { await f.close(); }
});
await test('EXA-008 max-effort stop sends its required beta header and full ledgers refuse new runs', async () => {
  const f = await fixture((url, options) => {
    assert.equal(new Headers(options.headers).get('Exa-Beta'), 'agent-max-effort-2026-07-27');
    return Promise.resolve(Response.json({ id: 'run-max', status: url.endsWith('/stop') ? 'completed' : 'running' }));
  }, { runLimit: 1 });
  try {
    assert.ok((await f.call(request('exa_agent_start', { query: 'research', effort: 'max' }))).ok);
    assert.ok((await f.call(request('exa_agent_stop', { id: 'run-max' }))).ok);
    assert.equal((await f.call(request('exa_agent_start', { query: 'more' }))).error?.code, 'budget');
    const opened = await Owners.open(`${f.root}/exa-runs.json`, await ApiSchemas.load(f.schemas), 1); assert.ok(opened.ok); assert.equal(opened.value.room(), false);
  } finally { await f.close(); }
});

await test('EXA-008 an echoed key cannot become a persisted agent run ID', async () => {
  const f = await fixture(() => Promise.resolve(Response.json({ id: 'fixture-exa-secret', status: 'running' })));
  try {
    assert.equal((await f.call(request('exa_agent_start', { query: 'test' }))).error?.code, 'io');
    assert.equal((await readFile(`${f.root}/exa-runs.json`, 'utf8')).includes('fixture-exa-secret'), false);
  } finally { await f.close(); }
});
