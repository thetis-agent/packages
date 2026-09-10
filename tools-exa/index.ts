/** Connect tools to their registered API process without exposing its secret; ADR 0009, EXA-001. */
import { fileURLToPath } from 'node:url';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { CallRequest, CallAnswer, OfferRequest, ToolDef } from '@/contracts/turn-events/types.ts';
import type { SpillSink } from '@/lib/spill/index.ts';
import { toolError } from '@/lib/service/tool-client.ts';
import type { ServiceCall } from '@/lib/service/tool-client.ts';
import { definitions, source, serviceName } from './definitions.ts';
import { ApiSchemas } from './schema.ts';

export const spawn = [{ id: 'exa', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: { EXA_API_KEY: 'secret/exa-key' }, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'egress' }];
const schemas = new Schemas();
let tools: ToolDef[] = [];
let callService: ServiceCall | undefined;
interface Context { callService?: ServiceCall }
export async function init(_profile: unknown, context: Context): Promise<void> {
  tools = definitions(await ApiSchemas.load(schemas)); callService = context.callService;
}
export const stages = {
  source,
  offer(request: OfferRequest): Promise<ToolDef[]> {
    return Promise.resolve(structuredClone(tools.filter(tool => !request.mode.readOnly || tool.readOnly)));
  },
  async call(request: CallRequest, _sink: SpillSink, signal?: AbortSignal): Promise<CallAnswer> {
    const tool = tools.find(tool => tool.name === request.name);
    if (!tool) return toolError(request.id, 'gone', 'This Exa tool is no longer available.');
    if (!isObject(request.args) || !schemas.arguments(tool.schema, request.args)) return toolError(request.id, 'invalid-args', 'The Exa tool arguments do not match their schema.');
    const deny = request.mode['deny'];
    if (request.mode['readOnly'] === true && !tool.readOnly || Array.isArray(deny) && (deny.includes(request.name) || deny.includes(`tools-exa/${request.name}`))) return toolError(request.id, 'read-only-mode', 'This Exa operation is not available in this mode.');
    return callService ? callService(serviceName, request, signal) : toolError(request.id, 'gone', 'The Exa API process has no authenticated connection.');
  }
};
