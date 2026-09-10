/** Prove two inherited identities chat through the headless lifted wire in distinct sandboxes, and that
 * the per-person public socket gates both the assets and the wire on the kernel's own answer to
 * session.whois, never on the request itself; ADR 0038, KS-004, KS-023, ADR 0019. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceFixture } from '../../test/provider-service.ts';
import { environmentProcess } from '../../test/environment-process.ts';
import { gatewayProcess } from '../../test/gateway-process.ts';
import { webClient, httpGet } from '../../test/web-client.ts';

async function person(shared: Awaited<ReturnType<typeof serviceFixture>>, who: string, other?: string): Promise<string> {
  const environment = await environmentProcess(shared, who, true); assert.ok((await environment.process.probe()).ok);
  const gateway = await gatewayProcess(shared, environment, who, 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
  const session = shared.mintSession(who); const cookie = `thetis_session=${session}`;
  const client = await webClient(gateway.socket, { cookie });
  try {
    const page = await httpGet(gateway.socket, '/', { cookie, accept: 'text/html' });
    assert.equal(page.status, 200); assert.ok(String(page.headers['content-type']).startsWith('text/html'));
    assert.ok(typeof page.headers['content-security-policy'] === 'string' && page.headers['content-security-policy'].length > 0);
    const script = await httpGet(gateway.socket, '/app.js', { cookie });
    assert.equal(script.status, 200); assert.equal(script.headers['content-type'], 'text/javascript');
    const me = await httpGet(gateway.socket, '/api/me', { cookie });
    assert.equal(me.status, 200); const named: unknown = JSON.parse(me.body); assert.ok(typeof named === 'object' && named !== null);
    assert.equal((named as { value: { person: string } }).value.person, who);

    await client.send({ type: 'hello', person: 'forged' }); const hello = await client.next(); assert.equal(hello['type'], 'user'); assert.deepEqual(hello['user'], { name: who, role: 'user' });
    await client.send({ type: 'list', person: 'forged' }); const list = await client.next(); assert.deepEqual(list['sessions'], []);
    if (other) { await client.send({ type: 'open', id: other }); const rejected = await client.next(); assert.equal(rejected['type'], 'error'); }
    await client.send({ type: 'new' }); const opened = await client.next(); assert.equal(opened['type'], 'opened'); const id = opened['session']; assert.ok(typeof id === 'string');
    await client.send({ type: 'send', id, text: 'Hello', person: 'forged' });
    let finished = false; let accepted = false; let deltas = 0; let text = '';
    for (let count = 0; count < 128 && (!finished || !accepted); count++) {
      const frame = await client.next(); assert.notEqual(frame['type'], 'error', JSON.stringify(frame));
      if (frame['kind'] === 'delta') { deltas++; text += String(frame['text']); }
      if (frame['kind'] === 'turn-finished') { finished = true; assert.equal(frame['stopped_by'], 'answer'); }
      accepted ||= frame['type'] === 'accepted';
    }
    assert.ok(finished && accepted); assert.ok(deltas < 100); assert.equal(text, who === 'alice' ? 'PRIVATE_WIRE'.repeat(1000) : 'Hello.');
    const rows = await environment.rows(); assert.ok(rows.includes('turn.start')); assert.ok(rows.includes('turn.end')); assert.ok(!rows.includes('PRIVATE_WIRE')); assert.ok(!(await shared.rows()).includes('PRIVATE_WIRE'));
    const gatewayRows = await gateway.rows();
    assert.ok(!rows.includes(session)); assert.ok(!gatewayRows.includes(session)); assert.ok(!(await shared.rows()).includes(session));
    await client.send({ type: 'history', id }); assert.equal((await client.next())['code'], 'unsupported');
    await client.send({ type: 'send', id, text: 'unsupported', attachments: [{}] }); assert.equal((await client.next())['code'], 'unsupported');
    return id;
  } finally { client.close(); await gateway.close(); await environment.close(); }
}

await test('The headless gateway wire keeps two people isolated and batches mock tokens outside kernel control', async () => {
  const shared = await serviceFixture(1, { scripts: [Array.from({ length: 1000 }, () => ({ type: 'delta.text', text: 'PRIVATE_WIRE' }))] }); assert.ok((await shared.process.probe()).ok);
  try { const alice = await person(shared, 'alice'); const bob = await person(shared, 'bob', alice); assert.notEqual(alice, bob); }
  finally { await shared.close(); }
});

await test('A signed-out browser is redirected to sign in for pages and refused at the wire', async () => {
  const shared = await serviceFixture(); assert.ok((await shared.process.probe()).ok);
  try {
    const environment = await environmentProcess(shared, 'alice', true); assert.ok((await environment.process.probe()).ok);
    const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
    try {
      const page = await httpGet(gateway.socket, '/', { accept: 'text/html' });
      assert.equal(page.status, 303); assert.equal(page.headers['location'], '/login');
      const deep = await httpGet(gateway.socket, '/', { accept: 'text/html', prefix: '/alice' });
      assert.equal(deep.headers['location'], '/login?next=%2Falice%2F');
      const me = await httpGet(gateway.socket, '/api/me');
      assert.equal(me.status, 401);
      const asJson = await httpGet(gateway.socket, '/', { accept: 'application/json' });
      assert.equal(asJson.status, 401);
      await assert.rejects(webClient(gateway.socket));
    } finally { await gateway.close(); await environment.close(); }
  } finally { await shared.close(); }
});

await test('A session naming another person is refused by this person\'s own socket', async () => {
  const shared = await serviceFixture(); assert.ok((await shared.process.probe()).ok);
  try {
    const environment = await environmentProcess(shared, 'alice', true); assert.ok((await environment.process.probe()).ok);
    const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
    try {
      const bobsSession = shared.mintSession('bob'); const cookie = `thetis_session=${bobsSession}`;
      const me = await httpGet(gateway.socket, '/api/me', { cookie });
      assert.equal(me.status, 401);
      await assert.rejects(webClient(gateway.socket, { cookie }));
      const rows = await gateway.rows(); assert.ok(!rows.includes(bobsSession));
    } finally { await gateway.close(); await environment.close(); }
  } finally { await shared.close(); }
});

await test('Signing out clears the cookie and redirects even without one', async () => {
  const shared = await serviceFixture(); assert.ok((await shared.process.probe()).ok);
  try {
    const environment = await environmentProcess(shared, 'alice', true); assert.ok((await environment.process.probe()).ok);
    const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
    try {
      const signedIn = shared.mintSession('alice'); const cookie = `thetis_session=${signedIn}`;
      const withCookie = await httpGet(gateway.socket, '/logout', { cookie, method: 'POST' });
      assert.equal(withCookie.status, 303); assert.equal(withCookie.headers['location'], '/login');
      assert.ok(String(withCookie.headers['set-cookie']).includes('thetis_session=;'));
      const withoutCookie = await httpGet(gateway.socket, '/logout', { method: 'POST' });
      assert.equal(withoutCookie.status, 303); assert.equal(withoutCookie.headers['location'], '/login');
    } finally { await gateway.close(); await environment.close(); }
  } finally { await shared.close(); }
});
