/** Wait for output delivery and refuse closed pipes without buffering commands; KS-018. */
import type { Writable } from 'node:stream';
import { failure } from '@/lib/schema/index.ts';
import type { IO } from './index.ts';

export function output(stream: Writable): IO {
  let failed = false; stream.on('error', () => { failed = true; });
  return { write: bytes => {
    if (failed || stream.destroyed) return Promise.resolve(failure('io', 'The command output is closed.'));
    return new Promise(resolve => {
      stream.write(bytes, error => { resolve(error ? failure('io', 'The command output could not be written.') : { ok: true, value: undefined }); });
    });
  } };
}
