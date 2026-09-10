/** Preserve citations and partial page failures without copying vendor internals; EXA-003–005. */
import { isObject, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { CallAnswer } from '@/contracts/turn-events/types.ts';
import type { ApiSchemas } from './schema.ts';
import type { Operation } from './definitions.ts';
export function response(operation: Operation, input: unknown, schemas: ApiSchemas): Result<Record<string, unknown>, 'io'> {
  const name = operation === 'exa_search' ? 'searchResponse' : operation === 'exa_contents' ? 'contentsResponse' : operation === 'exa_answer' ? 'answerResponse' : 'agentResponse';
  if (!schemas.validator<Record<string, unknown>>(name)(input)) return failure('io', 'The Exa response does not match its schema.');
  const fields = ['requestId', 'results', 'statuses', 'answer', 'citations', 'output', 'id', 'status', 'stopReason', 'usage', 'costDollars'];
  return { ok: true, value: Object.fromEntries(fields.filter(name => input[name] !== undefined).map(name => [name, input[name]])) };
}
export function answer(id: string, value: Record<string, unknown>, redact: (text: string) => string): CallAnswer {
  const data: NonNullable<CallAnswer['data']> = {};
  for (const [key, field] of [['requestId', 'requestId'], ['runId', 'id'], ['status', 'status']]) {
    const item = field ? value[field] : undefined; if (key && typeof item === 'string') data[key] = redact(item);
  }
  const cost = value['costDollars'];
  if (isObject(cost) && typeof cost['total'] === 'number' && Number.isFinite(cost['total']) && cost['total'] >= 0) data['estimatedCost'] = cost['total'];
  if (Array.isArray(value['results'])) data['resultCount'] = value['results'].length;
  return { id, ok: true, content: [{ type: 'text', text: redact(JSON.stringify(value)) }], data };
}
