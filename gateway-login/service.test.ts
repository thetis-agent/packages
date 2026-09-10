/** Authenticate over the shipped Unix HTTP surface in its own sandbox; KS-006–007, ADR 0018. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginProcess, loginRequest } from '@/test/login-process.ts';
import { isObject } from '@/lib/schema/index.ts';

await test('KS-007 a real login gateway returns only kernel-resolved sessions and keeps passwords out of logs', async () => {
  const f = await loginProcess();
  try {
    assert.ok((await f.process.probe()).ok);
    const rejected = await loginRequest(f.socket, { id: 'external-alice', password: 'wrong' }); assert.equal(rejected.status, 401);
    const logged = await loginRequest(f.socket, { id: 'external-alice', password: 'Alice password', person: 'bob' });
    assert.equal(logged.status, 200); assert.ok(isObject(logged.body) && isObject(logged.body['value']));
    const value = logged.body['value']; assert.equal(value['person'], 'alice'); assert.ok(typeof value['sessionToken'] === 'string');
    assert.ok(f.identity.resolveSession(value['sessionToken']).ok); assert.ok(!f.identity.authenticate(value['sessionToken']).ok);
    const cookies = logged.headers['set-cookie']; assert.ok(Array.isArray(cookies)); assert.ok(String(cookies[0]).includes('HttpOnly; Secure; SameSite=Strict'));
    const rows = await f.rows(); for (const secret of ['Alice password', value['sessionToken'], f.token]) assert.ok(!rows.includes(secret));
    assert.ok((await f.process.drain(30000)).ok);
    assert.ok((await f.process.control.notify({ note: 'env.updated', params: { resume: true } })).ok); assert.ok((await f.process.probe()).ok);
    assert.equal((await loginRequest(f.socket, { id: 'external-alice', password: 'Alice password' })).status, 200);
  } finally { await f.close(); }
});

await test('The login HTTP boundary refuses malformed and oversized requests before password verification', async () => {
  const f = await loginProcess();
  try {
    assert.ok((await f.process.probe()).ok);
    for (const [input, code] of [[null, 'invalid-args'], [{ id: 'external-alice', password: 'Alice password', extra: 'x'.repeat(17000) }, 'frame-too-large']]) {
      const response = await loginRequest(f.socket, input); assert.ok(isObject(response.body) && isObject(response.body['error'])); assert.equal(response.body['error']['code'], code);
    }
    assert.ok(!(await f.rows()).includes('Alice password'));
  } finally { await f.close(); }
});
