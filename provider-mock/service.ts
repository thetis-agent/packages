/** Expose the scripted provider only with inherited authority and durable budgets; PR-010–014. */
import { serve } from '../../lib/provider/service.ts';
import { configure } from './startup.ts';

const result = await serve((settings, authority, budgets, schemas, _clock, scope) => configure(settings, authority, budgets, schemas, scope), outcome => {
  if (!outcome.ok) process.stderr.write(`${JSON.stringify(outcome)}\n`);
});
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
