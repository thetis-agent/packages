/** Select the scoped directory mount without routing content through kernel control; ADR 0019. */
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { settings } from '../../lib/session/client.ts';
import type { Batch } from '../../lib/session/types.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { SessionClient } from '../../lib/session/client.ts';
import { mounted } from '../../lib/session/mount.ts';
import type { Clock } from '../../lib/events/index.ts';

export async function streamFor(args: readonly string[], schemas: Schemas, clock: Clock, receive: (batch: Batch) => Promise<Result<void>>): Promise<Result<SessionClient | undefined>> {
  if (args[0] !== 'send' && args[0] !== 'subscribe') return { ok: true, value: undefined };
  try { await stat(dirname(settings.endpoint)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && args[0] === 'send') return { ok: true, value: undefined };
    return failure('unsupported', 'The environment session stream is not mounted.');
  }
  return mounted(schemas, clock, receive);
}
