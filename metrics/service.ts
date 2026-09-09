/** Keep metrics queries in the registered deployment sandbox; ADR 0017 §4. */
import { serve } from '../../lib/service/index.ts';
import { handler } from './server.ts';
const result = await serve(handler, outcome => { if (!outcome.ok) process.stderr.write(`${outcome.error.code}: ${outcome.error.message}\n`); }, ['env.logs']);
if (!result.ok) { process.stderr.write(`${result.error.code}: ${result.error.message}\n`); process.exitCode = 1; }
