/** Guard the sign-in page and the browser form flow beside the existing JSON login tests; ADR 0038 §4. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginProcess, loginGet, loginFormRequest } from '@/test/login-process.ts';
import { isObject } from '@/lib/schema/index.ts';

const csp = "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

await test('GET /login serves the sign-in page and its stylesheet through lib/assets, HEAD mirrors, and an unknown path answers the JSON not-found', async () => {
  const f = await loginProcess();
  try {
    assert.ok((await f.process.probe()).ok);

    const page = await loginGet(f.socket, '/login');
    assert.equal(page.status, 200); assert.equal(page.headers['content-type'], 'text/html'); assert.equal(page.headers['content-security-policy'], csp);
    assert.match(page.body, /<form[^>]*action=["']\/login["']/); assert.match(page.body, /name=["']id["']/); assert.match(page.body, /name=["']password["']/);

    const head = await loginGet(f.socket, '/login', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers['content-type'], 'text/html');

    const css = await loginGet(f.socket, '/login/theme.css');
    assert.equal(css.status, 200); assert.equal(css.headers['content-type'], 'text/css');

    const missing = await loginGet(f.socket, '/nope');
    assert.equal(missing.status, 404); const missingBody: unknown = JSON.parse(missing.body);
    assert.ok(isObject(missingBody) && isObject(missingBody['error']) && missingBody['error']['code'] === 'not-found');

    assert.ok((await f.process.drain(30000)).ok);
  } finally { await f.close(); }
});

await test('POST /login as a browser form redirects by kernel identity, honours a safe next, refuses an unsafe one, and never leaks the password on failure', async () => {
  const f = await loginProcess();
  try {
    assert.ok((await f.process.probe()).ok);

    const ok = await loginFormRequest(f.socket, { id: 'external-alice', password: 'Alice password' });
    assert.equal(ok.status, 303); assert.equal(ok.headers['location'], '/alice/'); assert.equal(ok.headers['cache-control'], 'no-store');
    const cookies = ok.headers['set-cookie']; assert.ok(Array.isArray(cookies)); assert.ok(String(cookies[0]).includes('HttpOnly; Secure; SameSite=Strict'));
    const issued = /thetis_session=([^;]+)/.exec(String(cookies[0])); assert.ok(issued);
    const sessionToken = issued[1] ?? ''; assert.ok(sessionToken.length > 0);

    const withNext = await loginFormRequest(f.socket, { id: 'external-alice', password: 'Alice password', next: '/alice/?c=1' });
    assert.equal(withNext.status, 303); assert.equal(withNext.headers['location'], '/alice/?c=1');

    for (const unsafe of ['//evil.example', 'https://evil', '/ok\\evil']) {
      const fallback = await loginFormRequest(f.socket, { id: 'external-alice', password: 'Alice password', next: unsafe });
      assert.equal(fallback.status, 303); assert.equal(fallback.headers['location'], '/alice/');
    }

    const wrong = await loginFormRequest(f.socket, { id: 'external-alice', password: 'wrong' });
    assert.equal(wrong.status, 303); assert.equal(wrong.headers['location'], '/login?error=refused'); assert.equal(wrong.headers['set-cookie'], undefined);

    const unknown = await loginFormRequest(f.socket, { id: 'nobody', password: 'whatever' });
    assert.equal(unknown.status, 303); assert.equal(unknown.headers['location'], '/login?error=refused'); assert.equal(unknown.headers['set-cookie'], undefined);

    const oversize = await loginFormRequest(f.socket, { id: 'external-alice', password: 'Alice password', extra: 'x'.repeat(17000) });
    assert.equal(oversize.status, 400); const oversizeBody: unknown = JSON.parse(oversize.body);
    assert.ok(isObject(oversizeBody) && isObject(oversizeBody['error']) && oversizeBody['error']['code'] === 'frame-too-large');

    const rows = await f.rows(); for (const secret of ['Alice password', 'wrong', sessionToken, f.token]) assert.ok(!rows.includes(secret));
    assert.ok((await f.process.drain(30000)).ok);
  } finally { await f.close(); }
});
