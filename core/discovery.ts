/** Capture declared registrations in disposable workers inside the discovery sandbox; TE-021–022, ADR 0027. */
import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Initializer } from './initialization.ts';
import { validator } from '../../lib/package-loader/index.ts';
import type { DiscoveryStartup, DiscoveryRequest, Captured, Setup } from '../../lib/package-loader/types.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { socketFrames, send } from '../../lib/ndjson/socket.ts';
import type { Connection } from '../../lib/service/lifecycle.ts';
import { clock } from '../../lib/events/index.ts';
import { encode } from '../../lib/ndjson/index.ts';

async function checked(input: unknown, schemas: Schemas): Promise<Result<DiscoveryStartup>> {
  if (!(await validator<DiscoveryStartup>(schemas, 'discoveryStartup'))(input) || input.setup.runtime !== undefined) return failure('invalid-args', 'The discovery startup must contain a package-only profile.');
  const value = structuredClone(input); const roots = await Promise.all(value.roots.map(root => realpath(root)));
  for (const entry of value.setup.entries) {
    const canonical = await realpath(entry.path);
    if (canonical !== entry.path || !roots.some(root => canonical.startsWith(`${root}/`))) return failure('outside-roots', 'The package entry is outside the configured review roots.');
  }
  return { ok: true, value };
}
async function capture(config: DiscoveryStartup, schemas: Schemas): Promise<Result<Captured>> {
  const state = await mkdtemp(join(config.state, 'discovery-')); const initializer = new Initializer(clock, schemas);
  try {
    const setup: Setup = { ...config.setup, entries: config.setup.entries.map(entry => ({ ...entry, state: join(state, createHash('sha256').update(entry.manifest.name).digest('hex')) })) };
    const result = await initializer.start(setup); if (!result.ok) return result;
    const value: Captured = { sources: [...result.value.sources], gaps: [...result.value.gaps], registrations: [...result.value.registrations].map(([source, registration]) => ({ source, registration })), failures: [...result.value.failures].map(([source, message]) => ({ source, message })) };
    return encode(value, 65536).ok ? { ok: true, value } : failure('budget', 'The captured registration exceeds its response budget.');
  } finally { await initializer.stop(); await rm(state, { recursive: true, force: true }); }
}
export async function discovery(input: unknown, schemas: Schemas): Promise<Result<(connection: Connection) => Promise<Result<void>>>> {
  const config = await checked(input, schemas); if (!config.ok) return config;
  const validate = await validator<DiscoveryRequest>(schemas, 'discoveryRequest'); let active = false;
  return { ok: true, value: async connection => {
    const frames = socketFrames(connection.socket); const first = await frames.next();
    if (first.done || !first.value.ok || !validate(first.value.value)) return send(connection.socket, { v: '1', id: 'invalid', ...failure('invalid-args', 'The discovery request violates its schema.') });
    const request = first.value.value; connection.admitted();
    if (active) return send(connection.socket, { v: '1', id: request.id, ...failure('budget', 'The discovery worker pool is full.') });
    active = true;
    try { return await send(connection.socket, { v: '1', id: request.id, ...await capture(config.value, schemas) }); }
    catch { return await send(connection.socket, { v: '1', id: request.id, ...failure('io', 'The package registration discovery failed.') }); }
    finally { active = false; }
  } };
}
