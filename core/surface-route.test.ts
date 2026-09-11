/** Exercise a contributed panel's command over a real socket, end to end; contract/surface, ADR 0051.
 *
 * surface-command.test.ts covers the decisions; this covers the wire. The endpoint below is the same
 * one control.ts opens — the real `publicCapabilities`, a real `Peer` on each side, the real
 * kernel-socket frame schema — and the caller is the real `SessionClient` the web gateway holds open
 * for a conversation. Nothing here is a stand-in except the package's own hook and the subscription,
 * which is what makes it worth running: a method missing from the negotiated set, or a params shape
 * the frame schema refuses, is invisible to every unit test and fatal here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Peer } from '@/lib/socket/index.ts';
import type { Handler } from '@/lib/socket/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import type { CallRequest } from '@/contracts/turn-events/types.ts';
import type { Stage } from '@/lib/events/stages.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import { Service, serviceLimits } from '@/lib/service/lifecycle.ts';
import { SessionClient } from '@/lib/session/client.ts';
import { publicCapabilities } from './protocol.ts';
import { surfaceCommand } from './surface-command.ts';

const schemas = new Schemas(); await schemas.load();

async function endpoint(stages: readonly Stage[]) {
  const directory = await mkdtemp('/tmp/surface-route-'); const path = join(directory, 'public.sock');
  const service = new Service(clock, serviceLimits, 'io');
  let opened: string | undefined;
  const opening = await service.open(path, async connection => {
    const handlers = new Map<Method, Handler>();
    const peer = new Peer(connection.socket, schemas, clock, publicCapabilities, { handlers, note: () => Promise.resolve({ ok: true, value: undefined }) });
    handlers.set('session.subscribe', params => {
      const conversation = params['conversation'];
      if (typeof conversation !== 'string') return Promise.resolve({ ok: false as const, error: { code: 'invalid-args', message: 'no conversation' } });
      opened = conversation;
      return Promise.resolve({ ok: true, value: { conversation, cursor: 0, oldest: 1 } });
    });
    handlers.set('session.request', surfaceCommand(stages, schemas, clock, directory, () => opened));
    const accepted = await peer.accept({ person: 'alice', scope: 'person' });
    if (!accepted.ok) return accepted;
    connection.admitted();
    return peer.finished();
  }, () => undefined);
  assert.ok(opening.ok, JSON.stringify(opening));
  const client = await SessionClient.open(path, schemas, clock, () => Promise.resolve({ ok: true, value: undefined }));
  assert.ok(client.ok, JSON.stringify(client));
  return { client: client.value, async close() { client.value.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); } };
}

/** A contributing package, reduced to what a mounted stage is: a source name and the hook that answers. */
function contributor(answer: (request: CallRequest) => unknown): Stage {
  return { source: 'inspector-tools@1.0.0', call: request => Promise.resolve(answer(request)) };
}

await test('a request travels the open conversation\'s own stream and the package\'s answer comes back on it', async () => {
  const seen: CallRequest[] = [];
  const f = await endpoint([contributor(request => { seen.push(request); return { id: request.id, ok: true, content: [{ type: 'text', text: 'read twice' }], data: { read: 2 } }; })]);
  try {
    const subscribed = await f.client.subscribe('c1'); assert.ok(subscribed.ok, JSON.stringify(subscribed));
    const answer = await f.client.request('c1', 'inspector-tools', 'usage', {});
    assert.ok(answer.ok, JSON.stringify(answer));
    assert.equal(answer.value.ok, true);
    assert.deepEqual(answer.value.data, { read: 2 });
    assert.deepEqual(answer.value.content, [{ type: 'text', text: 'read twice' }]);
    const [request] = seen; assert.ok(request);
    assert.equal(request.name, 'usage');
    assert.deepEqual(request.roots, []);
  } finally { await f.close(); }
});

await test('the stream refuses a conversation it is not reading before the frame is ever sent', async () => {
  let called = false;
  const f = await endpoint([contributor(request => { called = true; return { id: request.id, ok: true }; })]);
  try {
    const subscribed = await f.client.subscribe('c1'); assert.ok(subscribed.ok);
    const answer = await f.client.request('c2', 'inspector-tools', 'usage', {});
    assert.ok(!answer.ok); assert.equal(answer.error.code, 'forbidden');
    assert.equal(called, false);
  } finally { await f.close(); }
});

await test('a package that is not mounted here is refused across the wire, not locally', async () => {
  const f = await endpoint([contributor(request => ({ id: request.id, ok: true }))]);
  try {
    const subscribed = await f.client.subscribe('c1'); assert.ok(subscribed.ok);
    const answer = await f.client.request('c1', 'not-here', 'usage', {});
    assert.ok(!answer.ok); assert.equal(answer.error.code, 'not-found');
    assert.equal(answer.error.message, 'That panel is not allowed to do this.');
  } finally { await f.close(); }
});

await test('an answer the package invented is refused rather than handed on', async () => {
  const f = await endpoint([contributor(() => ({ id: 'somebody-else', ok: true }))]);
  try {
    const subscribed = await f.client.subscribe('c1'); assert.ok(subscribed.ok);
    const answer = await f.client.request('c1', 'inspector-tools', 'usage', {});
    assert.ok(!answer.ok); assert.equal(answer.error.code, 'protocol');
  } finally { await f.close(); }
});
