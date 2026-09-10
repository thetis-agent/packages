/** Bound scrypt work outside the event loop and retain no plaintext passwords; ADR 0018 §2. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Credential } from './types.ts';

export const settings = { workers: 2, cost: 16384, blockSize: 8, parallelism: 1, memoryBytes: 33554432, passwordBytes: 4096 };
let active = 0;

async function derive(password: string, salt: string): Promise<Result<Buffer>> {
  if (Buffer.byteLength(password) > settings.passwordBytes) return failure('invalid-args', 'The password exceeds its byte limit.');
  if (active >= settings.workers) return failure('budget', 'The password worker pool is full.');
  active += 1;
  try {
    return await new Promise(resolve => {
      scrypt(password, Buffer.from(salt, 'hex'), 64, { N: settings.cost, r: settings.blockSize, p: settings.parallelism, maxmem: settings.memoryBytes }, (error, key) => {
        resolve(error ? failure('io', 'The password proof could not be computed.') : { ok: true, value: key });
      });
    });
  } finally { active -= 1; }
}

export async function credential(id: string, password: string): Promise<Result<Credential>> {
  if (!id || id.length > 256 || !password || password.length > 1024) return failure('invalid-args', 'The password identity has invalid fields.');
  const salt = randomBytes(32).toString('hex'); const hashed = await derive(password, salt);
  return hashed.ok ? { ok: true, value: { id, salt, hash: hashed.value.toString('hex') } } : hashed;
}

export async function verify(password: string, account: Credential | undefined): Promise<Result<boolean>> {
  const hashed = await derive(password, account?.salt ?? '0'.repeat(64)); if (!hashed.ok) return hashed;
  const expected = Buffer.from(account?.hash ?? '0'.repeat(128), 'hex');
  const equal = expected.length === hashed.value.length && timingSafeEqual(expected, hashed.value);
  hashed.value.fill(0);
  return { ok: true, value: equal && account !== undefined };
}
