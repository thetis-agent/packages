/** Isolate review-time package evaluation behind inherited kernel control; ADR 0027, TE-022. */
import { serve } from '@/lib/service/index.ts';
import { discovery } from './discovery.ts';
const result = await serve(discovery, outcome => { if (!outcome.ok) process.stderr.write(`${outcome.error.code}: ${outcome.error.message}\n`); });
if (!result.ok) { process.stderr.write(`${result.error.code}: ${result.error.message}\n`); process.exitCode = 1; }
