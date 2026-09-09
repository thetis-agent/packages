/** Keep evaluation orchestration unprivileged and distinct from the trusted act; ADR 0014, ADR 0018. */
import { fileURLToPath } from 'node:url';
export const stages = {};
export const spawn = [{ id: 'runner', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: { EVALUATOR_SEED: 'secret/evaluator.seed' }, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' }];
export { Evaluator, evaluationLimits } from './run.ts';
export type { Execution, Configuration, Outcome, TurnJob, CheckJob } from './run.ts';
export { mutate, vocabulary, mutationLimits } from './mutate.ts';
export { suite, suiteLimits } from './suite.ts';
export { Rotation, rotation, rotationStage, rotationLimits } from './rotation.ts';
