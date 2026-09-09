/** Keep registry mechanics outside the trusted kernel; proposal §5, ADR 0017. */
import { fileURLToPath } from 'node:url';
export { Registry } from '../../lib/registry/index.ts';
export type { Pin, Release, Lock } from '../../lib/registry/types.ts';
export const stages = {};
export const spawn = [{ id: 'registry', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' }];
