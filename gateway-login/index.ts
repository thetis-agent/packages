/** Keep password proof in its designated gateway and principal resolution in the kernel; ADR 0018 §2. */
import { fileURLToPath } from 'node:url';
export const stages = {};
export const spawn = [{ id: 'login', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' }];
