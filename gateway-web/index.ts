/** Keep the web gateway scoped by inherited identity and a direct environment mount; ADR 0009, ADR 0019. */
import { fileURLToPath } from 'node:url';
export const stages = {};
export const settings = { messageBytes: 1048576, pending: 8, streams: 8, turnMs: 600000, headerBytes: 16384, pendingIdentity: 8 };
export const spawn = [{ id: 'web', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'person', network: 'none' }];
