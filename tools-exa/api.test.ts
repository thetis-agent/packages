/** Exercise actual Exa request and response shapes at the external HTTP edge; EXA-001–005. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { configured } from '@/lib/schema/settings.ts';
import { fixture, request } from './fixture.ts';
import { ApiSchemas } from './schema.ts';
import { prepare, maxEffortHeader } from './request.ts';
import { definitions } from './definitions.ts';
import type { Settings } from './types.ts';

await test('EXA-001 the native package offers seven distinct API operations with complete argument schemas', async () => {
  const schemas = new Schemas(); const api = await ApiSchemas.load(schemas); const tools = definitions(api);
  assert.equal(tools.length, 7); assert.equal(tools.filter(tool => tool.readOnly).length, 4);
  for (const tool of tools) assert.ok(schemas.validator('turn-events', 'toolDef')(tool));
  const settings = configured(api.definition('settings'), {}); assert.ok(api.validator<Settings>('settings')(settings));
  const call = prepare(request(), api, settings); assert.ok(call.ok);
  assert.deepEqual(call.value.body, { query: 'search', type: 'auto', numResults: 5, contents: { highlights: { maxCharacters: 1000 } } });
  const max = prepare(request('exa_agent_start', { query: 'research', effort: 'max', maxCostDollars: 1 }), api, settings); assert.ok(max.ok);
  assert.equal(max.value.beta, maxEffortHeader); assert.deepEqual(max.value.body?.['budget'], { maxCostDollars: 1 });
});
await test('EXA-002 search uses direct HTTPS, strips unknown arguments, and preserves structured output and source URLs', async () => {
  const f = await fixture((url, options) => {
    assert.equal(url, 'https://api.exa.ai/search'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('x-api-key'), 'fixture-exa-secret');
    assert.ok(typeof options.body === 'string'); const body: unknown = JSON.parse(options.body); assert.ok(isObject(body));
    assert.equal(body['baseUrl'], undefined); assert.equal(body['person'], undefined);
    return Promise.resolve(Response.json({ requestId: 's1', results: [{ url: 'https://example.com', title: null, highlights: ['source'] }], output: { answer: 'value' }, costDollars: { total: 0.007 }, ignored: 1 }));
  });
  try {
    const result = await f.call(request('exa_search', { query: 'test', baseUrl: 'https://attacker.invalid', person: 'bob' }));
    assert.ok(result.ok); assert.equal(result.data?.['resultCount'], 1); assert.equal(result.data['reservedCost'], 0.007);
    assert.ok(JSON.stringify(result.content).includes('https://example.com')); assert.equal(JSON.stringify(result).includes('ignored'), false);
  } finally { await f.close(); }
});
await test('EXA-003 contents keeps partial failures and answer keeps citations without streaming', async () => {
  const f = await fixture((url, options) => {
    assert.ok(typeof options.body === 'string'); const body: unknown = JSON.parse(options.body); assert.ok(isObject(body));
    if (url.endsWith('/contents')) {
      assert.deepEqual(body['text'], { maxCharacters: 4000 });
      return Promise.resolve(Response.json({ results: [{ url: 'https://example.com', text: 'page' }], statuses: [{ id: 'https://missing.invalid', status: 'error', error: { tag: 'not_found' } }] }));
    }
    assert.equal(url, 'https://api.exa.ai/answer'); assert.equal(body['stream'], false); assert.equal(body['model'], 'exa');
    return Promise.resolve(Response.json({ answer: 'answer', citations: [{ url: 'https://example.com', title: 'source' }] }));
  });
  try {
    const contents = await f.call(request('exa_contents', { urls: ['https://example.com', 'https://missing.invalid'] })); assert.ok(contents.ok);
    assert.ok(JSON.stringify(contents.content).includes('not_found'));
    const answer = await f.call(request('exa_answer', { query: 'question' })); assert.ok(answer.ok); assert.ok(JSON.stringify(answer.content).includes('citations'));
  } finally { await f.close(); }
});
await test('EXA-004 invalid filters, URLs, disabled content types, and metered caps cannot reach Exa', async () => {
  const f = await fixture(() => { assert.fail('Invalid input reached Exa.'); });
  try {
    const cases = [request('exa_search', { query: 'x', category: 'people', excludeDomains: ['example.com'] }), request('exa_search', { query: 'x', startPublishedDate: 'invalid' }),
      request('exa_contents', { urls: ['file:///secret'] }), request('exa_contents', { urls: ['https://example.com'], text: false }),
      request('exa_agent_start', { query: 'x', effort: 'auto', maxCostDollars: 2 }), request('exa_agent_get', { id: '../secret' })];
    for (const call of cases) assert.equal((await f.call(call)).ok, false);
    assert.equal(f.reports.length, 0);
  } finally { await f.close(); }
});
for (const [status, code] of [[401, 'tool'], [402, 'budget'], [429, 'budget'], [404, 'not-found'], [422, 'invalid-args'], [500, 'io']] as const) await test(`EXA-005 HTTP ${String(status)} produces a typed error without vendor body leakage`, async () => {
  const f = await fixture(() => Promise.resolve(new Response('fixture-exa-secret', { status })));
  try { const result = await f.call(request()); assert.equal(result.error?.code, code); assert.equal(JSON.stringify(result).includes('fixture-exa-secret'), false); }
  finally { await f.close(); }
});
