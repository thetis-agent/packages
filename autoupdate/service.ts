/** Serve the update-status factory as the spawned deployment process; ADR 0048. */
import { serve } from '@/lib/service/index.ts';
import { handler } from './server.ts';

const result = await serve(handler, outcome => { if (!outcome.ok) process.stderr.write(`${outcome.error.code}: ${outcome.error.message}\n`); });
if (!result.ok) { process.stderr.write(`${result.error.code}: ${result.error.message}\n`); process.exitCode = 1; }
