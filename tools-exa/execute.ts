/** Keep Exa HTTP operations and per-person remote-run ownership in the reviewed package; EXA-001–008. */
import type { CallRequest, CallAnswer, ToolDef } from '@/contracts/turn-events/types.ts';
import type { Caller, Authority, Budgets } from '@/lib/provider/index.ts';
import type { PaidTool } from '@/lib/provider/tool-call.ts';
import { PaidTools } from '@/lib/provider/tool-call.ts';
import { toolError } from '@/lib/service/tool-client.ts';
import { configured } from '@/lib/schema/settings.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { gap } from '@/lib/semver-match/index.ts';
import { ApiSchemas } from './schema.ts';
import { definitions } from './definitions.ts';
import { prepare } from './request.ts';
import { Http } from './http.ts';
import type { Fetcher } from './http.ts';
import type { Settings } from './types.ts';
import { estimate } from './prices.ts';
import { response, answer } from './response.ts';
import { Owners } from './owners.ts';

export class ExaTools implements PaidTool {
  readonly definitions: readonly ToolDef[];
  readonly #schemas: ApiSchemas; readonly #settings: Settings; readonly #http: Http; readonly #owners: Owners;
  constructor(schemas: ApiSchemas, settings: Settings, http: Http, owners: Owners) {
    this.definitions = definitions(schemas); this.#schemas = schemas; this.#settings = settings; this.#http = http; this.#owners = owners;
  }
  check(request: CallRequest, caller: Caller): CallAnswer | undefined {
    if (!caller.person || caller.person.length > 256) return toolError(request.id, 'tool', 'The caller has no supported person identity.');
    const prepared = prepare(request, this.#schemas, this.#settings);
    if (!prepared.ok) return toolError(request.id, prepared.error.code, prepared.error.message);
    const id = prepared.value.runId;
    const previous = prepared.value.body?.['previousRunId'];
    const owner = typeof previous === 'string' ? previous : id;
    if (owner) { const checked = this.#owners.check(owner, caller.person, prepared.value.operation === 'exa_agent_stop'); if (!checked.ok) return toolError(request.id, checked.error.code, checked.error.message); }
    if (prepared.value.operation === 'exa_agent_start' && !this.#owners.room()) return toolError(request.id, 'budget', 'The Exa run ledger is full or unavailable.');
    return undefined;
  }
  estimate(request: CallRequest): number {
    const prepared = prepare(request, this.#schemas, this.#settings);
    return prepared.ok ? estimate(prepared.value, this.#settings) : Infinity;
  }
  async execute(request: CallRequest, caller: Caller, signal: AbortSignal): Promise<CallAnswer> {
    const checked = this.check(request, caller); if (checked) return checked;
    const prepared = prepare(request, this.#schemas, this.#settings);
    if (!prepared.ok) return toolError(request.id, prepared.error.code, prepared.error.message);
    const reservation = prepared.value.operation === 'exa_agent_start' ? this.#owners.begin() : undefined;
    if (reservation && !reservation.ok) return toolError(request.id, reservation.error.code, reservation.error.message);
    try {
      const fetched = await this.#http.request(prepared.value, request.deadlineMs, signal);
      if (!fetched.ok) return toolError(request.id, fetched.error.code, fetched.error.message);
      const result = response(prepared.value.operation, fetched.value, this.#schemas);
      if (!result.ok) return toolError(request.id, result.error.code, result.error.message);
      if (prepared.value.runId && result.value['id'] !== prepared.value.runId) return toolError(request.id, 'io', 'Exa returned a different run ID.');
      if (prepared.value.operation === 'exa_agent_start') {
        const id = result.value['id']; if (typeof id !== 'string' || this.#http.redact(id) !== id) return toolError(request.id, 'io', 'Exa returned no run ID.');
        const saved = await this.#owners.save(id, caller.person, String(prepared.value.body?.['effort']));
        if (!saved.ok) return toolError(request.id, 'io', 'The Exa run started but its ownership could not be stored.');
      }
      return answer(request.id, result.value, text => this.#http.redact(text));
    } finally { if (reservation?.ok) reservation.value(); }
  }
}

export async function configure(input: unknown, key: string | undefined, schemas: Schemas, time: Clock, authority: Authority, budgets: Budgets, state: string, fetcher: Fetcher = fetch): Promise<Result<PaidTools>> {
  if (!key) return failure('gap', gap({ name: 'tools-exa', version: '1.0.0' }, 'secret/exa-key', '*'));
  if (!isObject(input)) return failure('invalid-args', 'The Exa settings must be an object.');
  const api = await ApiSchemas.load(schemas); const settings = configured(api.definition('settings'), input);
  if (!api.validator<Settings>('settings')(settings)) return failure('invalid-args', 'The Exa settings violate their schema.');
  const owners = await Owners.open(`${state}/exa-runs.json`, api, settings.runLimit); if (!owners.ok) return owners;
  const tools = new ExaTools(api, settings, new Http(key, settings, time, fetcher), owners.value);
  return { ok: true, value: new PaidTools(tools, authority, budgets, schemas) };
}
