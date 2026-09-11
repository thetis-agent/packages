/** Serve the lifted web surface and the /ws wire behind a per-request kernel identity check, over
 * this person's own public socket; ADR 0009, ADR 0019, ADR 0038. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { serve } from '@/lib/service/index.ts';
import { accept, limits as wireLimits } from '@/lib/websocket/index.ts';
import type { Channel, Handler, RequestHandler } from '@/lib/websocket/index.ts';
import { load } from '@/lib/assets/index.ts';
import { compose } from './panels.ts';
import { clock } from '@/lib/events/index.ts';
import { isObject, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { Wire } from './wire.ts';
import type { Versions } from './wire.ts';
import { SignIn, sessionToken } from './identity.ts';
import { requestHandler } from './http.ts';
import type { Contract } from './types.ts';
import { settings } from './index.ts';

const assetsRoot = fileURLToPath(new URL('./assets', import.meta.url));
const manifestPath = fileURLToPath(new URL('./assets.json', import.meta.url));

/* The two versions the foot of the page reports back to the person looking at it.
 *
 * The first is read from this package's own manifest rather than declared anywhere: the served
 * assets and the process serving them are one install, so the manifest beside them is the only
 * figure that cannot drift out of step with what is on screen. The second is whatever version the
 * kernel's own profile answer carries, which today is none — the reply is this target's settings,
 * and the deployment's setup version is not among them. It is read rather than omitted because the
 * bar already hides an item whose datum is absent, so wiring the seam costs nothing and the day the
 * kernel does answer with one the bar shows it without another change here. */
async function versions(supplied: unknown): Promise<Versions> {
  const manifest: unknown = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  return {
    agent: isObject(manifest) && typeof manifest['version'] === 'string' ? manifest['version'] : '',
    setup: isObject(supplied) && typeof supplied['version'] === 'string' ? supplied['version'] : ''
  };
}
const headerEnd = Buffer.from('\r\n\r\n');

interface Sniffed { raw: Buffer; upgrade: boolean; cookie: string | undefined }

/** Peek at the request line and headers without consuming them, so a socket that turns out to be
 * an unsigned-in WebSocket upgrade never reaches ws's own handshake writer (item 5: that writer
 * commits its 101 response before any factory runs, so the gate must sit in front of it). Any
 * request carrying an Upgrade header is treated as needing the gate, not only a genuine /ws
 * handshake: accept() destroys anything else with that header anyway, so gating it too costs one
 * harmless whois call and never admits an ungated Wire. */
function sniff(socket: Socket, limit: number): Promise<Sniffed | undefined> {
  return new Promise(resolve => {
    let buffered = Buffer.alloc(0); let settled = false;
    const finish = (value: Sniffed | undefined): void => {
      if (settled) return; settled = true;
      socket.removeListener('data', onData); socket.removeListener('close', onEnd); socket.removeListener('error', onEnd);
      resolve(value);
    };
    const onEnd = (): void => { finish(undefined); };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(headerEnd);
      if (end === -1) {
        if (buffered.length > limit) { socket.pause(); finish({ raw: buffered, upgrade: false, cookie: undefined }); }
        return;
      }
      socket.pause();
      const lines = buffered.subarray(0, end).toString('latin1').split('\r\n');
      const cookieLine = lines.find(line => /^cookie\s*:/i.test(line));
      finish({ raw: buffered, upgrade: lines.some(line => /^upgrade\s*:/i.test(line)), cookie: cookieLine ? cookieLine.slice(cookieLine.indexOf(':') + 1).trim() : undefined });
    };
    socket.on('data', onData); socket.on('close', onEnd); socket.on('error', onEnd);
  });
}

/** Mirror ws's own abortHandshake: write the status line and close, before any 101 response could be sent. */
function refuse(socket: Socket): void {
  socket.once('finish', () => { socket.destroy(); });
  socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
}

async function admit(socket: Socket, admitted: () => void, signIn: SignIn, person: string, factory: (channel: Channel, role: string) => Handler, request: RequestHandler): Promise<Result<void>> {
  const sniffed = await sniff(socket, wireLimits.headerBytes);
  if (!sniffed) return { ok: true, value: undefined };
  let role = '';
  if (sniffed.upgrade) {
    const signed = await signIn.check(sessionToken(sniffed.cookie));
    if (!signed.ok || signed.value.person !== person) { refuse(socket); return { ok: true, value: undefined }; }
    role = signed.value.role;
  }
  socket.unshift(sniffed.raw);
  return accept(socket, admitted, channel => factory(channel, role), request);
}

const result = await serve(async (supplied, schemas, peer, identity) => {
  const wireSchema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(wireSchema)) throw new Error('The committed gateway schema is invalid.');
  const checkFrame = schemas.compile<Contract>(wireSchema);
  const reported = await versions(supplied);
  const table = await load(assetsRoot, manifestPath, schemas);
  if (!table.ok) return table;
  // Packages that contribute a panel or a renderer are served from this same origin and this same
  // sign-in gate; the surface never learns what any of them mean.
  const composed = await compose(table.value, schemas);
  // A contributor that cannot be served is named on stderr and left out; the surface still starts.
  for (const refusal of composed.refused) process.stderr.write(`${JSON.stringify({ surface: 'panel refused', ...refusal })}\n`);
  return { ok: true, value: connection => {
    const signIn = new SignIn(peer, settings.pendingIdentity);
    const request = requestHandler(composed.table, signIn);
    const factory = (channel: Channel, role: string): Handler => {
      const wire = new Wire(peer, schemas, clock, identity, role, frame => channel.write(frame), composed.contribution, reported);
      return {
        message: value => checkFrame(value) ? wire.command(value) : Promise.resolve(failure('invalid-args', 'The gateway frame violates its schema.')),
        close: () => { wire.close(); }
      };
    };
    return admit(connection.socket, connection.admitted, signIn, identity.person, factory, request);
  } };
}, outcome => { if (!outcome.ok) process.stderr.write(`${JSON.stringify(outcome)}\n`); },
  ['session.list', 'session.create', 'session.submit', 'session.cancel', 'session.whois', 'env.status', 'env.logs', 'env.reset'], 'person');
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
