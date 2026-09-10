/** Bound the headless login surface within the shared service lifecycle; ADR 0012, ADR 0038, KS-017. */
import { createServer } from 'node:http';
import { body, bytes, reply, safeRedirectPath } from '@/lib/http/index.ts';
import { respond } from '@/lib/assets/index.ts';
import type { Table } from '@/lib/assets/index.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Connection } from '@/lib/service/lifecycle.ts';
import type { PasswordAuthority } from './authority.ts';

export const settings = { bodyBytes: 16384, headersBytes: 16384, deadlineMs: 10000, nextBytes: 1024 };

function routePath(url: string | undefined): string {
  if (!url) return '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** Only a same-origin, single-slash path may be an untrusted redirect target; ADR 0038 §4 names the kernel, not the request, for everything else. */
function safeNext(next: string | null): string | undefined {
  return safeRedirectPath(next, settings.nextBytes);
}

function cookie(token: string): string { return `thetis_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`; }

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
}

/** The login form is urlencoded, not JSON: reuse lib/http's byte-bounded read and decode UTF-8 ourselves. */
async function formBody(request: IncomingMessage, limit: number, label: string): Promise<Result<string>> {
  const read = await bytes(request, limit, label); if (!read.ok) return read;
  return { ok: true, value: read.value.toString('utf8') };
}

async function handleJson(authority: PasswordAuthority, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = await body(request, settings.bodyBytes, 'The login request'); if (!input.ok) { reply(response, input); return; }
  const result = await authority.login(input.value);
  if (result.ok) response.setHeader('set-cookie', cookie(result.value.sessionToken));
  reply(response, result);
}

/** Never echo the id or password, and never let the redirect distinguish an unknown id from a wrong password; ADR 0038 §4. */
async function handleForm(authority: PasswordAuthority, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await formBody(request, settings.bodyBytes, 'The login request'); if (!raw.ok) { reply(response, raw); return; }
  const params = new URLSearchParams(raw.value);
  const result = await authority.login({ id: params.get('id') ?? '', password: params.get('password') ?? '' });
  if (!result.ok) { redirect(response, '/login?error=refused'); return; }
  response.setHeader('set-cookie', cookie(result.value.sessionToken));
  redirect(response, safeNext(params.get('next')) ?? `/${encodeURIComponent(result.value.person)}/`);
}

async function handle(authority: PasswordAuthority, table: Table, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const method = request.method ?? '';
    if (method === 'GET' || method === 'HEAD') { await respond(table, request, response); return; }
    if (method !== 'POST' || routePath(request.url) !== '/login') { reply(response, failure('not-found', 'Only the login surface exists.')); return; }
    const contentType = request.headers['content-type']?.split(';')[0];
    if (contentType === 'application/json') { await handleJson(authority, request, response); return; }
    if (contentType === 'application/x-www-form-urlencoded') { await handleForm(authority, request, response); return; }
    reply(response, failure('invalid-args', 'The login surface requires JSON or a form submission.'));
  } catch { if (!response.destroyed && !response.headersSent) reply(response, failure('io', 'The login request could not complete.')); else response.destroy(); }
}

export function connection(authority: PasswordAuthority, table: Table): (connection: Connection) => Promise<Result<void>> {
  const server = createServer({ maxHeaderSize: settings.headersBytes, requestTimeout: settings.deadlineMs, headersTimeout: settings.deadlineMs });
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('request', (request, response) => {
    void handle(authority, table, request, response).catch(() => { response.destroy(); });
  });
  return connection => new Promise(resolve => {
    connection.socket.once('close', () => { resolve({ ok: true, value: undefined }); });
    server.emit('connection', connection.socket);
  });
}
