/** Select only documented HTTP fields and apply bounded defaults; EXA-002–004. */
import { isObject, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { CallRequest } from '@/contracts/turn-events/types.ts';
import type { Settings } from './types.ts';
import { operations } from './definitions.ts';
import type { Operation } from './definitions.ts';
import type { ApiSchemas } from './schema.ts';
export interface ApiRequest { operation: Operation; path: string; method: 'POST' | 'GET'; body?: Record<string, unknown>; beta?: string; runId?: string }
export const maxEffortHeader = 'agent-max-effort-2026-07-27';

function pick(args: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties'];
  return Object.fromEntries(Object.entries(args).filter(([name]) => isObject(properties) && name in properties));
}
function filters(args: Record<string, unknown>): Result<void, 'invalid-args'> {
  const start = args['startPublishedDate']; const end = args['endPublishedDate'];
  for (const date of [start, end]) if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(date) || !Number.isFinite(Date.parse(date)))) return failure('invalid-args', 'A publication date is invalid.');
  if (typeof start === 'string' && typeof end === 'string' && Date.parse(start) > Date.parse(end)) return failure('invalid-args', 'The publication date range is reversed.');
  if (['company', 'people'].includes(String(args['category'])) && [start, end, args['excludeDomains']].some(value => value !== undefined)) return failure('invalid-args', 'Company and people searches do not support these date or exclusion filters.');
  return { ok: true, value: undefined };
}
function agent(body: Record<string, unknown>, settings: Settings): Result<ApiRequest, 'invalid-args' | 'budget'> {
  const effort = body['effort'] ?? 'low'; const maximum = body['maxCostDollars'] ?? settings.agentMaxCostDollars;
  delete body['maxCostDollars']; body['effort'] = effort;
  if (effort === 'auto' || effort === 'max') {
    if (typeof maximum !== 'number' || maximum > settings.agentMaxCostDollars) return failure('budget', 'The Exa run exceeds its configured cost ceiling.');
    body['budget'] = { maxCostDollars: maximum };
  }
  return { ok: true, value: { operation: 'exa_agent_start', method: 'POST', path: '/agent/runs', body, ...(effort === 'max' ? { beta: maxEffortHeader } : {}) } };
}

export function prepare(request: CallRequest, schemas: ApiSchemas, settings: Settings): Result<ApiRequest, 'invalid-args' | 'budget'> {
  const operation = operations.find(operation => operation.name === request.name);
  if (!operation || !schemas.validator<Record<string, unknown>>(operation.schema)(request.args)) return failure('invalid-args', 'The Exa arguments do not match a supported operation.');
  const body = pick(request.args, schemas.definition(operation.schema));
  if (Buffer.byteLength(JSON.stringify(body)) > settings.requestBytes) return failure('budget', 'The Exa request exceeds its byte limit.');
  switch (operation.name) {
    case 'exa_search': {
      const valid = filters(body); if (!valid.ok) return valid;
      return { ok: true, value: { operation: operation.name, method: 'POST', path: '/search', body: { ...body, type: body['type'] ?? 'auto', numResults: body['numResults'] ?? 5, contents: body['contents'] ?? { highlights: { maxCharacters: 1000 } } } } };
    }
    case 'exa_contents': {
      const urls = body['urls'];
      if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string' || !URL.canParse(url) || !['https:', 'http:'].includes(new URL(url).protocol) || new URL(url).username || new URL(url).password)) return failure('invalid-args', 'Contents requires HTTP or HTTPS URLs without credentials.');
      if (body['text'] === undefined && body['highlights'] === undefined && body['summary'] === undefined) body['text'] = { maxCharacters: 4000 };
      if (!['text', 'highlights', 'summary'].some(name => !!body[name])) return failure('invalid-args', 'Contents requires at least one content type.');
      return { ok: true, value: { operation: operation.name, method: 'POST', path: '/contents', body } };
    }
    case 'exa_answer': return { ok: true, value: { operation: operation.name, method: 'POST', path: '/answer', body: { ...body, model: 'exa', stream: false } } };
    case 'exa_agent_start': return agent(body, settings);
    case 'exa_agent_get': case 'exa_agent_cancel': case 'exa_agent_stop': {
      const id = body['id']; if (typeof id !== 'string') return failure('invalid-args', 'The Exa run ID is invalid.');
      const suffix = operation.name === 'exa_agent_get' ? '' : operation.name === 'exa_agent_cancel' ? '/cancel' : '/stop';
      return { ok: true, value: { operation: operation.name, method: suffix ? 'POST' : 'GET', path: `/agent/runs/${encodeURIComponent(id)}${suffix}`, runId: id, ...(operation.name === 'exa_agent_stop' ? { beta: maxEffortHeader } : {}) } };
    }
  }
}
