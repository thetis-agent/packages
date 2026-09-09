/** Parse concrete scoped commands without inventing kernel-origin authority; KS-004–005, KS-015. */
import type { Method } from '../../contracts/kernel-socket/types.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';

type Command = { method: Method; params: Record<string, unknown> };
const mapped = new Map<string, Method>([['status', 'env.status'], ['logs', 'env.logs'], ['reset', 'env.reset'], ['profile', 'profile.get'], ['health', 'health.probe'], ['list', 'session.list']]);
const invalid = () => failure('invalid-args', 'Use status, logs, reset, profile, health, list, new [project], send <conversation> <text>, cancel <conversation>, or subscribe <conversation> [from].');

export function command(args: readonly string[]): Result<Command> {
  const name = args[0]; if (!name) return invalid();
  if (name === 'default' || name === 'secret') return failure('forbidden', 'This command requires the trusted kernel origin; an inherited run cannot impersonate that origin.');
  const method = mapped.get(name);
  if (method && args.length === 1) return { ok: true, value: { method, params: {} } };
  const first = args[1];
  if (name === 'new' && args.length <= 2 && first !== '') return { ok: true, value: { method: 'session.create', params: { surface: 'cli', ...(first === undefined ? {} : { project: first }) } } };
  if (!first || Buffer.byteLength(first) > 256) return invalid();
  if (name === 'cancel' && args.length === 2) return { ok: true, value: { method: 'session.cancel', params: { conversation: first } } };
  if (name === 'send' && args.length >= 3) {
    const text = args.slice(2).join(' '); if (!text) return invalid();
    return { ok: true, value: { method: 'session.submit', params: { conversation: first, input: { text, attachments: [] } } } };
  }
  if (name === 'subscribe' && args.length <= 3) {
    const from = args[2] === undefined ? undefined : Number(args[2]);
    if (from !== undefined && (!Number.isSafeInteger(from) || from < 0 || args[2]?.trim() === '')) return invalid();
    return { ok: true, value: { method: 'session.subscribe', params: { conversation: first, ...(from === undefined ? {} : { from }) } } };
  }
  return invalid();
}
