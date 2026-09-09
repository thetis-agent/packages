/** Derive diagnostic scores from immutable trajectories without acquiring gate authority; ADR 0014 §3. */
import { fileURLToPath } from 'node:url';
export const stages = {};
export const spawn = [{ id: 'queries', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' }];
export { summarize, bootstrap } from '../../lib/evaluation/index.ts';
export type { Summary, Interval } from '../../lib/evaluation/index.ts';
export { retrieval, invariance, ablation, retrievalLimits } from './retrieval.ts';
export { gold, goldLimits } from './gold.ts';
