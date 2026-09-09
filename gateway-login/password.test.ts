/** Refuse unbounded password work and retain only salted hashes; ADR 0018 §2. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credential, verify, settings } from './password.ts';

await test('Password proofs use independent salts and reject values outside their bounded worker pool', async () => {
  const running = Array.from({ length: settings.workers }, () => credential('external-id', 'secret proof'));
  const refused = await credential('external-id', 'secret proof'); assert.ok(!refused.ok); assert.equal(refused.error.code, 'budget');
  const results = await Promise.all(running); const first = results[0]; const second = results[1]; assert.ok(first?.ok && second?.ok);
  assert.notEqual(first.value.salt, second.value.salt); assert.notEqual(first.value.hash, second.value.hash);
  assert.deepEqual(await verify('secret proof', first.value), { ok: true, value: true });
  assert.deepEqual(await verify('wrong proof', first.value), { ok: true, value: false });
  assert.ok(!(await credential('', 'secret')).ok); assert.ok(!(await credential('external-id', '')).ok);
  assert.ok(!(await credential('external-id', 'x'.repeat(1025))).ok);
});
