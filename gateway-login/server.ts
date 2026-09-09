/** Bound the headless login surface within the shared service lifecycle; ADR 0012, KS-017. */
import { createServer } from 'node:http';
import { body, reply } from '../../lib/http/index.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { Connection } from '../../lib/service/lifecycle.ts';
import type { PasswordAuthority } from './authority.ts';

export const settings = { bodyBytes: 16384, headersBytes: 16384, deadlineMs: 10000 };

async function handle(authority: PasswordAuthority, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method !== 'POST' || request.url !== '/login') { reply(response, failure('not-found', 'Only the login surface exists.')); return; }
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') { reply(response, failure('invalid-args', 'The login surface requires JSON.')); return; }
    const input = await body(request, settings.bodyBytes, 'The login request'); if (!input.ok) { reply(response, input); return; }
    const result = await authority.login(input.value);
    if (result.ok) response.setHeader('set-cookie', `thetis_session=${result.value.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    reply(response, result);
  } catch { if (!response.destroyed && !response.headersSent) reply(response, failure('io', 'The login request could not complete.')); else response.destroy(); }
}

export function connection(authority: PasswordAuthority): (connection: Connection) => Promise<Result<void>> {
  const server = createServer({ maxHeaderSize: settings.headersBytes, requestTimeout: settings.deadlineMs, headersTimeout: settings.deadlineMs });
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('request', (request, response) => {
    void handle(authority, request, response).catch(() => { response.destroy(); });
  });
  return connection => new Promise(resolve => {
    connection.socket.once('close', () => { resolve({ ok: true, value: undefined }); });
    server.emit('connection', connection.socket);
  });
}
