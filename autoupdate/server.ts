/** Answer status.status over the mounted socket only; this factory starts and stops nothing (rule 6, AGENTS.md; ADR 0048). */
import { socketFrames, send } from '@/lib/ndjson/socket.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import type { Connection } from '@/lib/service/lifecycle.ts';
import schema from './schema.json' with { type: 'json' };
import type { Request, Update } from './types.ts';
import { validator, read } from './status.ts';

interface Settings { statusPath: string; statusBytes: number; pollMs: number }

function settings(value: unknown): Settings {
  const object = isObject(value) ? value : {};
  const statusPath = typeof object['statusPath'] === 'string' ? object['statusPath'] : '/updates/status.json';
  const statusBytes = typeof object['statusBytes'] === 'number' ? object['statusBytes'] : 65536;
  const pollMs = typeof object['pollMs'] === 'number' ? object['pollMs'] : 60000;
  return { statusPath, statusBytes, pollMs };
}

/** Narrower than lib/service's Factory type by design: this factory needs no peer and no kernel identity. */
export async function handler(raw: unknown, schemas: Schemas): Promise<Result<(connection: Connection) => Promise<Result<void>>>> {
  const config = settings(raw);
  const check = await validator(schemas); if (!check.ok) return check;
  const file = check.value;
  const request = schemas.definition<Request>(schema, 'request');
  let cache: { until: number; value: Result<Update, 'budget' | 'invalid-args' | 'io'> } | undefined;
  async function cached(): Promise<Result<Update, 'budget' | 'invalid-args' | 'io'>> {
    const now = Date.now();
    if (cache && cache.until > now) return cache.value;
    const value = await read(config.statusPath, config.statusBytes, file);
    cache = { until: now + config.pollMs, value };
    return value;
  }
  return { ok: true, value: async connection => {
    try {
      for await (const frame of socketFrames(connection.socket)) {
        if (!frame.ok) return frame;
        if (!request(frame.value)) return await send(connection.socket, failure('invalid-args', 'The update status request does not match its contract.'));
        connection.admitted();
        if (frame.value.method !== 'status') return await send(connection.socket, failure('unsupported', 'This method is not provided by the update status service.'));
        return await send(connection.socket, await cached());
      }
      return failure('io', 'The update status request ended before a frame arrived.');
    } catch { return failure('io', 'The update status connection failed.'); }
    finally { connection.socket.end(); }
  } };
}
