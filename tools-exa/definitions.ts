/** Give each HTTP operation a fixed tool definition; EXA-001, TE-018–020. */
import type { ToolDef } from '@/contracts/turn-events/types.ts';
import type { ApiSchemas } from './schema.ts';
export const source = 'tools-exa@1.0.0';
export const serviceName = 'service/tool-service.exa';
export const operations = [
  { name: 'exa_search', schema: 'search', readOnly: true, description: 'Search the web. Use filters for domains, publication dates, and categories. Request text, highlights, or summaries.' },
  { name: 'exa_contents', schema: 'fetch', readOnly: true, description: 'Read one or more web pages by URL. Return text, highlights, summaries, and each page status.' },
  { name: 'exa_answer', schema: 'answer', readOnly: true, description: 'Ask Exa to produce an answer with source citations. This operation uses an external model.' },
  { name: 'exa_agent_start', schema: 'agentStart', readOnly: false, description: 'Start a paid Exa research run. Return its ID promptly. Use exa_agent_get for results and exa_agent_cancel to cancel.' },
  { name: 'exa_agent_get', schema: 'agentId', readOnly: true, description: 'Read the status, output, citations, and usage of an Exa run started by you.' },
  { name: 'exa_agent_cancel', schema: 'agentId', readOnly: false, description: 'Cancel your queued or running Exa research run. Closing a local request does not cancel remote work.' },
  { name: 'exa_agent_stop', schema: 'agentId', readOnly: false, description: 'Stop your max-effort Exa run early and retain its collected results. Other effort modes do not support this operation.' }
] as const;
export type Operation = (typeof operations)[number]['name'];
export function definitions(schemas: ApiSchemas): ToolDef[] {
  return operations.map(operation => ({ name: operation.name, description: operation.description, schema: schemas.definition(operation.schema), source, readOnly: operation.readOnly, endsTurn: false, destructive: false,
    data: { requestId: 'string', runId: 'string', status: 'string', resultCount: 'number', estimatedCost: 'number', reservedCost: 'number' } }));
}
