/** Run registry operations only in the registered sandbox; ADR 0007, ADR 0017. */
import { serve } from '../../lib/service/index.ts';
import { handler } from '../../lib/registry/server.ts';
const result = await serve(handler, outcome => { if (!outcome.ok) process.stderr.write(`${outcome.error.code}: ${outcome.error.message}\n`); });
if (!result.ok) { process.stderr.write(`${result.error.code}: ${result.error.message}\n`); process.exitCode = 1; }
