/** Verify password evidence against real kernel bindings without granting the gateway person selection; KS-006–007. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Identity, loginFixture as fixture } from '@/test/login-fixture.ts';
import { PasswordAuthority, settings } from './authority.ts';

await test('KS-007 the kernel resolves verified external ids and ignores a login request naming another person', async () => {
  const f = await fixture(); let assertions = 0;
  try {
    const service = await PasswordAuthority.open(f.path, f.schemas, f.clock, params => { assertions += 1; assert.deepEqual(params, { kind: 'password', id: 'external-alice', evidence: { verified: true } }); return Promise.resolve(f.identity.session('login', params.kind, params.id)); }); assert.ok(service.ok);
    const result = await service.value.login({ id: 'external-alice', password: 'Alice password', person: 'bob' }); assert.ok(result.ok);
    assert.equal(result.value.person, 'alice'); assert.ok(f.identity.resolveSession(result.value.sessionToken).ok);
    assert.ok(!f.identity.authenticate(result.value.sessionToken).ok);
    const wrong = await service.value.login({ id: 'external-alice', password: 'wrong' }); assert.ok(!wrong.ok); assert.equal(wrong.error.code, 'auth');
    const unknown = await service.value.login({ id: 'unknown', password: 'Alice password' }); assert.deepEqual(unknown, wrong); assert.equal(assertions, 1);
  } finally { await f.close(); }
});

await test('KS-006 even a correct password cannot assert an undesignated authority or an unbound identity', async () => {
  const f = await fixture();
  try {
    const service = await PasswordAuthority.open(f.path, f.schemas, f.clock, params => Promise.resolve(f.identity.session('other', params.kind, params.id))); assert.ok(service.ok);
    const result = await service.value.login({ id: 'external-alice', password: 'Alice password' }); assert.ok(!result.ok); assert.equal(result.error.code, 'forbidden');
    const unbound = new Identity({ people: [], bindings: [], authorities: { password: 'login' } }, () => 0);
    const second = await PasswordAuthority.open(f.path, f.schemas, f.clock, params => Promise.resolve(unbound.session('login', params.kind, params.id))); assert.ok(second.ok);
    const missing = await second.value.login({ id: 'external-alice', password: 'Alice password' }); assert.ok(!missing.ok); assert.equal(missing.error.code, 'unbound');
  } finally { await f.close(); }
});

await test('Password attempts have a bounded window and persisted state rejects duplicate identities', async () => {
  const f = await fixture();
  try {
    const service = await PasswordAuthority.open(f.path, f.schemas, f.clock, params => Promise.resolve(f.identity.session('login', params.kind, params.id))); assert.ok(service.ok);
    for (let attempt = 0; attempt < settings.attempts; attempt += 1) assert.ok(!(await service.value.login({ id: 'external-alice', password: 'wrong' })).ok);
    const refused = await service.value.login({ id: 'external-alice', password: 'Alice password' }); assert.ok(!refused.ok); assert.equal(refused.error.code, 'budget');
    f.clock.advance(settings.windowMs); assert.ok((await service.value.login({ id: 'external-alice', password: 'Alice password' })).ok);
    await writeFile(f.path, JSON.stringify({ version: 1, accounts: [{ id: 'duplicate', salt: '0'.repeat(64), hash: '0'.repeat(128) }, { id: 'duplicate', salt: '0'.repeat(64), hash: '0'.repeat(128) }] }));
    const invalid = await PasswordAuthority.open(f.path, f.schemas, f.clock, () => Promise.resolve({ ok: true, value: {} })); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'collision');
  } finally { await f.close(); }
});

await test('Password boundaries refuse malformed credentials, malformed input and malformed kernel sessions', async () => {
  const f = await fixture();
  try {
    const service = await PasswordAuthority.open(f.path, f.schemas, f.clock, () => Promise.resolve({ ok: true, value: { sessionToken: 'injected\r\n', person: 'alice', role: 'user' } })); assert.ok(service.ok);
    const malformed = await service.value.login(null); assert.ok(!malformed.ok); assert.equal(malformed.error.code, 'invalid-args');
    const session = await service.value.login({ id: 'external-alice', password: 'Alice password' }); assert.ok(!session.ok); assert.equal(session.error.code, 'protocol');
    for (const state of ['{', JSON.stringify({ version: 1, accounts: [{ id: 'external-alice', salt: 'invalid', hash: 'invalid' }] })]) {
      await writeFile(f.path, state); const invalid = await PasswordAuthority.open(f.path, f.schemas, f.clock, () => Promise.resolve({ ok: true, value: {} })); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    }
  } finally { await f.close(); }
});
