/** Serve bounded headless commands only through a person's mounted socket; KS-004–005. */
import { readFile } from 'node:fs/promises';
import { serve } from '../../lib/service/index.ts';
import { socketFrames } from '../../lib/ndjson/socket.ts';
import { FrameWriter } from '../../lib/ndjson/writer.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import { capabilities, execute } from './index.ts';
import { clock } from '../../lib/events/index.ts';
import { streamFor } from './stream.ts';
import type { SessionClient } from '../../lib/session/client.ts';
import type { Contract } from './types.ts';

const result = await serve(async (_settings, schemas, peer) => {
  const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(schema)) throw new Error('The committed command schema is invalid.');
  const check = schemas.compile<Contract>(schema);
  return { ok: true, value: async connection => {
    const writer = new FrameWriter(connection.socket); let stream: SessionClient | undefined;
    try {
      for await (const frame of socketFrames(connection.socket)) {
        if (!frame.ok) return await writer.write(frame);
        if (!check(frame.value)) return await writer.write(failure('invalid-args', 'The command request violates its schema.'));
        connection.admitted(); const opened = await streamFor(frame.value.args, schemas, clock, batch => writer.write({ ok: true, value: batch }));
        if (!opened.ok) return await writer.write(opened); stream = opened.value;
        return await writer.write(await execute(frame.value.args, peer, stream));
      }
      return failure('io', 'The command connection ended before its request.');
    } finally { stream?.close(); await writer.settled(); writer.close(); }
  } };
}, result => { if (!result.ok) process.stderr.write(`${JSON.stringify(result)}\n`); }, capabilities, 'person');
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
