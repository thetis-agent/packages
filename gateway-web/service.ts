/** Serve the lifted chat wire only behind a kernel-established person endpoint; ADR 0009, ADR 0019. */
import { readFile } from 'node:fs/promises';
import { serve } from '../../lib/service/index.ts';
import { accept } from '../../lib/websocket/index.ts';
import { clock } from '../../lib/events/index.ts';
import { isObject, failure } from '../../lib/schema/index.ts';
import { Wire } from './wire.ts';
import type { Contract } from './types.ts';

const result = await serve(async (_settings, schemas, peer, identity) => {
  const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(schema)) throw new Error('The committed gateway schema is invalid.');
  const check = schemas.compile<Contract>(schema);
  return { ok: true, value: connection => accept(connection.socket, () => { connection.admitted(); }, channel => {
    const wire = new Wire(peer, schemas, clock, identity, frame => channel.write(frame));
    return { message: value => check(value) ? wire.command(value) : Promise.resolve(failure('invalid-args', 'The gateway frame violates its schema.')), close: () => { wire.close(); } };
  }) };
}, outcome => { if (!outcome.ok) process.stderr.write(`${JSON.stringify(outcome)}\n`); }, ['session.list', 'session.create', 'session.submit', 'session.cancel'], 'person');
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
