/** Keep the private evaluator in its registered deployment sandbox; ADR 0014, EV-002. */
import { serve } from '@/lib/service/index.ts';
import { handler } from './server.ts';
const result = await serve(handler, outcome => { if (!outcome.ok) process.stderr.write(`${outcome.error.code}: ${outcome.error.message}\n`); }, ['install', 'snapshot', 'prune', 'results.submit', 'install.run', 'snapshot.score']);
if (!result.ok) { process.stderr.write(`${result.error.code}: ${result.error.message}\n`); process.exitCode = 1; }
