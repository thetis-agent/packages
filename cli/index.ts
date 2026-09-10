/** Keep headless commands within inherited, scoped kernel authority; KS-001–005. */
import { fileURLToPath } from 'node:url';
import type { SessionClient } from '@/lib/session/client.ts';
import type { Peer } from '@/lib/socket/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { command } from './command.ts';

export const stages = {};
export const spawn = [{ id: 'cli', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'person', network: 'none' }];
export const settings = { arguments: 64, argumentBytes: 65536, outputBytes: 1048576, timeoutMs: 10000, turnMs: 600000 };
export const capabilities = ['session.list', 'session.create', 'session.submit', 'session.cancel', 'profile.get', 'health.probe', 'env.status', 'env.logs', 'env.reset', 'run.stop', 'env.updated'];
export interface IO { write(bytes: string): Promise<Result<void>> }

export async function execute(args: readonly string[], peer: Peer, stream?: SessionClient): Promise<Result<unknown>> {
  if (args.length > settings.arguments || args.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > settings.argumentBytes) return failure('budget', 'The command exceeds its argument limit.');
  const parsed = command(args); if (!parsed.ok) return parsed;
  if (parsed.value.method === 'session.subscribe') {
    if (!stream) return failure('unsupported', 'The environment session stream is not available.');
    const conversation = parsed.value.params['conversation']; const from = parsed.value.params['from'];
    if (typeof conversation !== 'string' || from !== undefined && typeof from !== 'number') throw new Error('The command parser lost subscription fields.');
    const subscribed = await stream.subscribe(conversation, from); if (!subscribed.ok) return subscribed;
    const ended = await stream.end(); return ended.ok ? subscribed : ended;
  }
  if (parsed.value.method === 'session.submit' && stream) {
    const conversation = parsed.value.params['conversation']; if (typeof conversation !== 'string') throw new Error('The command parser lost its conversation.');
    const subscribed = await stream.subscribe(conversation); if (!subscribed.ok) return subscribed;
    const submitted = await peer.call(parsed.value.method, parsed.value.params, settings.turnMs); if (!submitted.ok) return submitted;
    const ended = await stream.end(); return ended.ok ? submitted : ended;
  }
  return peer.call(parsed.value.method, parsed.value.params, parsed.value.method === 'session.submit' ? settings.turnMs : settings.timeoutMs);
}

export async function run(args: readonly string[], peer: Peer, io: IO, stream?: SessionClient): Promise<Result<void>> {
  const result = await execute(args, peer, stream); const bytes = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(bytes) > settings.outputBytes) return failure('frame-too-large', 'The command output exceeds its byte limit.');
  const written = await io.write(bytes); if (!written.ok) return written;
  return result.ok ? { ok: true, value: undefined } : result;
}
