/** Probe edited packages under their person's scope without serving a turn; GN-001, ADR 0027. */
import { serve } from '@/lib/service/index.ts';
import { discovery } from './discovery.ts';
const result = await serve(discovery, outcome => { if (!outcome.ok) process.stderr.write(`${outcome.error.code}: ${outcome.error.message}\n`); }, [], 'person');
if (!result.ok) { process.stderr.write(`${result.error.code}: ${result.error.message}\n`); process.exitCode = 1; }
