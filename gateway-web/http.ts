/** Serve the lifted web surface and the small account endpoints behind a per-request identity check,
 * never naming a person from the request itself; ADR 0038 §4, docs/08-vocabulary.md. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { respond } from '../../lib/assets/index.ts';
import type { Table } from '../../lib/assets/index.ts';
import { reply, safeRedirectPath } from '../../lib/http/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { RequestHandler } from '../../lib/websocket/index.ts';
import type { SignIn } from './identity.ts';
import { sessionToken } from './identity.ts';

export const settings = { nextBytes: 256 };

function routePath(url: string | undefined): string {
  if (!url) return '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** Only a same-origin, single-slash prefix may steer the post-login redirect; the kernel, not this value, names the person; ADR 0038 §4.
 * Elimination by typeof/undefined (rather than Array.isArray, whose lib.es5 signature narrows to `any[]`) keeps this branch typed. */
function safePrefix(prefix: string | readonly string[] | undefined): string | undefined {
  const value: string | undefined = typeof prefix === 'string' ? prefix : prefix === undefined ? undefined : prefix[0];
  return safeRedirectPath(value, settings.nextBytes);
}

function wantsHtml(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function methodNotAllowed(response: ServerResponse): Result<void> {
  response.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", connection: 'close' });
  response.end(JSON.stringify(failure('not-offered', 'This gateway serves only GET, HEAD and POST /logout.')));
  return { ok: true, value: undefined };
}

function redirectToLogin(response: ServerResponse, request: IncomingMessage): Result<void> {
  const next = safePrefix(request.headers['x-forwarded-prefix']);
  const location = next === undefined ? '/login' : `/login?next=${encodeURIComponent(next)}`;
  response.writeHead(303, { location, 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
  return { ok: true, value: undefined };
}

/** Clearing the cookie must work with no cookie at all: that is when a stuck browser needs it most. */
function clearCookieAndRedirect(response: ServerResponse): Result<void> {
  response.setHeader('set-cookie', 'thetis_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  response.writeHead(303, { location: '/login', 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
  return { ok: true, value: undefined };
}

async function handleMe(signIn: SignIn, request: IncomingMessage, response: ServerResponse): Promise<Result<void>> {
  const signed = await signIn.check(sessionToken(request.headers.cookie));
  reply(response, signed);
  return { ok: true, value: undefined };
}

async function handleAsset(table: Table, signIn: SignIn, request: IncomingMessage, response: ServerResponse): Promise<Result<void>> {
  const signed = await signIn.check(sessionToken(request.headers.cookie));
  if (signed.ok) { await respond(table, request, response); return { ok: true, value: undefined }; }
  if (wantsHtml(request)) return redirectToLogin(response, request);
  reply(response, signed);
  return { ok: true, value: undefined };
}

/** The only plain-HTTP surface: the account endpoints, then the lifted assets, then a flat refusal; ADR 0038 §4. */
export function requestHandler(table: Table, signIn: SignIn): RequestHandler {
  return async (request, response) => {
    const method = request.method ?? ''; const path = routePath(request.url);
    if ((method === 'GET' || method === 'HEAD') && path === '/api/me') return handleMe(signIn, request, response);
    if (method === 'POST' && path === '/logout') return Promise.resolve(clearCookieAndRedirect(response));
    if (method === 'GET' || method === 'HEAD') return handleAsset(table, signIn, request, response);
    return Promise.resolve(methodNotAllowed(response));
  };
}
