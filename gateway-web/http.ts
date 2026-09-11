/** Serve the lifted web surface and the small account endpoints behind a per-request identity check,
 * never naming a person from the request itself; ADR 0038 §4, docs/08-vocabulary.md. */
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { respond } from '@/lib/assets/index.ts';
import type { Table } from '@/lib/assets/index.ts';
import { bytes, reply, safeRedirectPath } from '@/lib/http/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { RequestHandler } from '@/lib/websocket/index.ts';
import type { SignIn } from './identity.ts';
import { sessionToken } from './identity.ts';
import type { Attachments } from './attachments.ts';

export const settings = { nextBytes: 256 };

/** The one route on this surface that is neither an account endpoint nor a lifted asset. */
const attachmentRoute = /^\/api\/attachments\/(?<conversation>[^/]{1,128})(?:\/(?<file>[^/]{1,128}))?$/u;

function routePath(url: string | undefined): string {
  if (!url) return '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** The upload's `name` rides in the query rather than the body because the body is the image itself: this
 * endpoint takes raw bytes with the type in `content-type`, not a multipart form, so nothing has to parse
 * an 8 MB body twice to find a filename. A name that will not decode is simply absent; attachments.ts
 * supplies its own label in that case, and the name is only ever a label. */
function queryName(url: string | undefined): string | undefined {
  const query = url?.indexOf('?') ?? -1;
  if (!url || query === -1) return undefined;
  const value = new URLSearchParams(url.slice(query + 1)).get('name');
  return value === null ? undefined : value;
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
  response.end(JSON.stringify(failure('not-offered', 'This gateway serves only GET, HEAD and POST.')));
  return { ok: true, value: undefined };
}

function redirectToLogin(response: ServerResponse, request: IncomingMessage): Result<void> {
  // The proxy stripped the prefix, so the page the browser asked for is prefix + the path we see; a bare
  // prefix without its slash would land on `/alice`, where the surface's relative asset URLs resolve wrongly.
  const prefix = safePrefix(request.headers['x-forwarded-prefix']);
  const next = prefix === undefined ? undefined : safeRedirectPath(`${prefix}${request.url ?? '/'}`, settings.nextBytes);
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

/** Take one image into the conversation the path names and answer with what the `send` frame must quote.
 * The bytes are read with a hard cap rather than a trusted `content-length`, so a lying header buys an
 * upload nothing: `bytes` stops at the limit and refuses whatever is still arriving. */
async function handleUpload(store: Attachments, conversation: string, limit: number, request: IncomingMessage, response: ServerResponse): Promise<Result<void>> {
  const read = await bytes(request, limit, 'That image');
  if (!read.ok) { reply(response, read.error.code === 'frame-too-large' ? failure('budget', store.tooLarge) : read); return { ok: true, value: undefined }; }
  const saved = await store.save(conversation, queryName(request.url), request.headers['content-type'], read.value);
  reply(response, saved);
  return { ok: true, value: undefined };
}

/** Hand one stored image back to the page that is drawing a transcript. The name is a content hash, so the
 * answer can be cached for as long as the browser likes and never goes stale; `private` keeps it out of any
 * shared cache between this person and the next. */
async function handleImage(store: Attachments, conversation: string, file: string, method: string, response: ServerResponse): Promise<Result<void>> {
  const found = await store.file(conversation, file);
  if (!found.ok) { reply(response, found); return { ok: true, value: undefined }; }
  response.writeHead(200, { 'content-type': found.value.mime, 'content-length': String(found.value.bytes),
    'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', connection: 'close' });
  if (method === 'HEAD') { response.end(); return { ok: true, value: undefined }; }
  try { await pipeline(createReadStream(found.value.path), response); return { ok: true, value: undefined }; }
  catch { if (!response.writableEnded) response.destroy(); return failure('io', 'That image could not be read.'); }
}

/** An attachment is this person's own, so the check is stricter than the one the assets get: the sign-in
 * must not merely be valid, it must name the person this gateway was spawned for. `admit` in service.ts
 * makes exactly that comparison before letting a WebSocket through, and an upload writes where that wire reads. */
async function handleAttachment(store: Attachments, signIn: SignIn, person: string, limit: number, request: IncomingMessage, response: ServerResponse, route: RegExpExecArray): Promise<Result<void>> {
  const signed = await signIn.check(sessionToken(request.headers.cookie));
  if (!signed.ok) { reply(response, signed); return { ok: true, value: undefined }; }
  if (signed.value.person !== person) { reply(response, failure('auth', 'This conversation belongs to someone else.')); return { ok: true, value: undefined }; }
  const conversation = route.groups?.['conversation'] ?? ''; const file = route.groups?.['file'];
  const method = request.method ?? '';
  if (method === 'POST') return file === undefined ? handleUpload(store, conversation, limit, request, response) : Promise.resolve(methodNotAllowed(response));
  if (file === undefined) { reply(response, failure('not-found', 'That image is no longer available.')); return { ok: true, value: undefined }; }
  return handleImage(store, conversation, file, method, response);
}

/** The only plain-HTTP surface: the account endpoints, the attachment route, then the lifted assets, then a flat refusal; ADR 0038 §4. */
export function requestHandler(table: Table, signIn: SignIn, store: Attachments, person: string, limit: number): RequestHandler {
  return async (request, response) => {
    const method = request.method ?? ''; const path = routePath(request.url);
    if ((method === 'GET' || method === 'HEAD') && path === '/api/me') return handleMe(signIn, request, response);
    if (method === 'POST' && path === '/logout') return Promise.resolve(clearCookieAndRedirect(response));
    const attachment = attachmentRoute.exec(path);
    if (attachment && (method === 'GET' || method === 'HEAD' || method === 'POST')) return handleAttachment(store, signIn, person, limit, request, response, attachment);
    if (method === 'GET' || method === 'HEAD') return handleAsset(table, signIn, request, response);
    return Promise.resolve(methodNotAllowed(response));
  };
}
