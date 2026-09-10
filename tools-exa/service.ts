/** The registered process alone receives the Exa key; ADR 0009, EXA-009. */
import { serve } from '@/lib/service/index.ts';
import { toolServer } from '@/lib/service/tool-server.ts';
import { KernelAuthority } from '@/lib/provider/authority.ts';
import { BudgetCheckpoint } from '@/lib/provider/checkpoint.ts';
import { Budgets } from '@/lib/provider/index.ts';
import { clock } from '@/lib/events/index.ts';
import { configure } from './execute.ts';
import { startup } from './startup.ts';
import { failure, isObject } from '@/lib/schema/index.ts';

const result = await serve(async (input, schemas, peer, _identity, token) => {
  const config = await startup(input, schemas); if (!config.ok) return config;
  const self = await peer.call('token.whois', { runToken: token });
  if (!self.ok || !isObject(self.value) || typeof self.value['id'] !== 'string') return failure('auth', 'The kernel did not identify the Exa API process.');
  const checkpoint = await BudgetCheckpoint.open('/state/budget.json', schemas); if (!checkpoint.ok) return checkpoint;
  const budgets = new Budgets(config.value.rule, Date.now, config.value.peopleLimit, checkpoint.value);
  const tools = await configure(config.value.settings, process.env['EXA_API_KEY'], schemas, clock, new KernelAuthority(peer, self.value['id']), budgets, '/state');
  if (!tools.ok) return tools;
  return { ok: true, value: await toolServer(schemas, (request, token, signal) => tools.value.call(request, token, signal)) };
}, () => undefined, ['token.whois', 'usage.report']);
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
