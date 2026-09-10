/** Declare the update-status spawn without any apply or undo path; rule 6, AGENTS.md; ADR 0048. */
import { fileURLToPath } from 'node:url';

export const stages = {};
export const spawn = [{ id: 'status', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' }];
