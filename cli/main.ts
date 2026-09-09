/** Execute one headless command with inherited authority and responsive drain; KS-001, KS-017. */
import { authority } from '../../lib/sandbox-runner/authority.ts';
import { Schemas, failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { clock } from '../../lib/events/index.ts';
import { Peer } from '../../lib/socket/index.ts';
import type { Handler } from '../../lib/socket/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import { capabilities, run } from './index.ts';
import { output } from './io.ts';
import { streamFor } from './stream.ts';
import type { SessionClient } from '../../lib/session/client.ts';

async function main(): Promise<Result<void>> {
  const inherited = await authority(); if (!inherited.ok) return inherited;
  const schemas = new Schemas(); await schemas.load();
  const status = { stopping: false }; let active: Promise<Result<void>> | undefined; let cancelling: Promise<Result<unknown>> | undefined;
  const handlers = new Map<Method, Handler>([['health.probe', async () => {
    if (status.stopping) { const cancelled = await cancelling; if (cancelled && !cancelled.ok) return cancelled; await active; }
    return { ok: true, value: { ready: true, draining: status.stopping } };
  }]]);
  let stream: SessionClient | undefined;
  const peer: Peer = new Peer(inherited.value.socket, schemas, clock, capabilities, { handlers, note: (note): Promise<Result<void>> => {
    if (note.note !== 'run.stop') return Promise.resolve({ ok: true, value: undefined });
    status.stopping = true; const args = process.argv.slice(2); const conversation = args[1];
    if (args[0] === 'send' && conversation) cancelling ??= peer.call('session.cancel', { conversation });
    return Promise.resolve({ ok: true, value: undefined });
  } });
  try {
    const connected = await peer.connect(); if (!connected.ok) return connected;
    if (status.stopping) return failure('switching', 'The command run is stopping.');
    const io = output(process.stdout); const opened = await streamFor(process.argv.slice(2), schemas, clock, batch => io.write(`${JSON.stringify({ ok: true, value: batch })}\n`));
    if (!opened.ok) return opened; stream = opened.value;
    active = run(process.argv.slice(2), peer, io, stream); return await active;
  } finally { stream?.close(); await cancelling; peer.close(); await peer.finished(); }
}

const result = await main();
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
